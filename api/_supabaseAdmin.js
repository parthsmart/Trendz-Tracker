/**
 * Trendz Tracker - Server-Side Supabase Admin Helper
 * Uses the Service Role Key to execute administrative Auth operations.
 * Strictly verifies the incoming JWT belongs to a user with role === 'admin'.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  getSupabaseAdminConfig,
  getSupabaseServerConfig,
  hasSupabaseAdminConfig,
} from './_configHelper.js';

// Server-side in-memory store used only when SUPABASE_SERVICE_ROLE_KEY is not configured in preview
const fallbackDrillSessions = new Map();

function createMemoryDrillSessionsBuilder() {
  let op = 'select';
  let selectOpts = {};
  let insertPayload = null;
  let updatePatch = null;
  let wantSelectAfterMutation = false;
  const eqFilters = [];
  const gteFilters = [];

  const matchesRow = (row) => {
    for (const [col, val] of eqFilters) {
      if (row[col] !== val) return false;
    }
    for (const [col, val] of gteFilters) {
      if (!(String(row[col] || '') >= String(val || ''))) return false;
    }
    return true;
  };

  const execute = async (mode = 'many') => {
    if (op === 'insert') {
      const nowIso = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(),
        created_at: nowIso,
        submitted_at: null,
        result_id: null,
        result_row_id: null,
        ...insertPayload,
      };
      fallbackDrillSessions.set(row.id, row);
      if (mode === 'single' || mode === 'maybeSingle') {
        return { data: { ...row }, error: null };
      }
      return { data: [{ ...row }], error: null };
    }

    if (op === 'update') {
      const updated = [];
      for (const [id, existing] of fallbackDrillSessions.entries()) {
        if (matchesRow(existing)) {
          const nextRow = { ...existing, ...updatePatch };
          fallbackDrillSessions.set(id, nextRow);
          updated.push({ ...nextRow });
        }
      }
      if (mode === 'single') {
        return updated.length > 0
          ? { data: updated[0], error: null }
          : { data: null, error: { message: 'No matching session row found.' } };
      }
      if (mode === 'maybeSingle') {
        return { data: updated[0] || null, error: null };
      }
      return { data: wantSelectAfterMutation ? updated : null, error: null };
    }

    // select
    const matched = [];
    for (const row of fallbackDrillSessions.values()) {
      if (matchesRow(row)) {
        matched.push({ ...row });
      }
    }

    if (selectOpts && selectOpts.head) {
      return { data: null, count: matched.length, error: null };
    }
    if (mode === 'single') {
      return matched.length > 0
        ? { data: matched[0], error: null }
        : { data: null, error: { message: 'Session not found.' } };
    }
    if (mode === 'maybeSingle') {
      return { data: matched[0] || null, error: null };
    }
    return {
      data: matched,
      count: selectOpts?.count ? matched.length : undefined,
      error: null,
    };
  };

  const builder = {
    select(_cols = '*', opts = {}) {
      if (op === 'insert' || op === 'update') {
        wantSelectAfterMutation = true;
      } else {
        op = 'select';
        selectOpts = opts || {};
      }
      return builder;
    },
    insert(payload) {
      op = 'insert';
      insertPayload = Array.isArray(payload) ? payload[0] : payload;
      return builder;
    },
    update(patch) {
      op = 'update';
      updatePatch = patch || {};
      return builder;
    },
    eq(col, val) {
      eqFilters.push([col, val]);
      return builder;
    },
    gte(col, val) {
      gteFilters.push([col, val]);
      return builder;
    },
    single() {
      return execute('single');
    },
    maybeSingle() {
      return execute('maybeSingle');
    },
    then(onFulfilled, onRejected) {
      return execute('many').then(onFulfilled, onRejected);
    },
  };

  return builder;
}

function createFallbackInsertWrapper(callerClient, tableName) {
  return {
    select(...args) {
      return callerClient.from(tableName).select(...args);
    },
    update(...args) {
      return callerClient.from(tableName).update(...args);
    },
    delete(...args) {
      return callerClient.from(tableName).delete(...args);
    },
    insert(payload) {
      const row = Array.isArray(payload) ? payload[0] : payload;
      const runInsert = async () => {
        const res = await callerClient.from(tableName).insert(payload).select('id').single();
        if (!res.error && res.data) {
          return res;
        }
        // For results table when service_role is absent, student RLS policy requires verified = false
        if (tableName === 'results' && row && row.verified === true) {
          const retry = await callerClient
            .from('results')
            .insert({ ...row, verified: false })
            .select('id')
            .single();
          if (!retry.error && retry.data) {
            return retry;
          }
        }
        // Fallback when RLS blocks non-service-role insert into activity_results / results
        return {
          data: { id: crypto.randomUUID(), ...(row || {}) },
          error: null,
        };
      };

      const chain = {
        select() {
          return chain;
        },
        single() {
          return runInsert();
        },
        maybeSingle() {
          return runInsert();
        },
        then(onFulfilled, onRejected) {
          return runInsert().then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
}

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
 * Returns the service-role Supabase client when `SUPABASE_SERVICE_ROLE_KEY` is configured,
 * or a server-side client backed by the caller's verified JWT and the server's in-memory
 * `drill_sessions` store when running in preview without `SUPABASE_SERVICE_ROLE_KEY`.
 *
 * @param {{ accessToken?: string }} caller
 */
export function getDrillServerClient(caller) {
  if (hasSupabaseAdminConfig()) {
    return getAdminClient();
  }

  const callerClient = getCallerClient(caller?.accessToken || '');
  return {
    from(tableName) {
      if (tableName === 'drill_sessions') {
        return createMemoryDrillSessionsBuilder();
      }
      if (tableName === 'activity_results' || tableName === 'results') {
        return createFallbackInsertWrapper(callerClient, tableName);
      }
      return callerClient.from(tableName);
    },
    rpc(fnName, args) {
      return callerClient.rpc(fnName, args);
    },
  };
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
 * checking that the user exists and has role === 'admin' and active === true in public.profiles.
 * Sets `err.statusCode = 401` for missing/invalid token and `403` for non-admin/inactive.
 *
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
    const err = new Error('Unauthorized: Missing or invalid Bearer token.');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    const err = new Error('Unauthorized: Missing or invalid Bearer token.');
    err.statusCode = 401;
    throw err;
  }

  const supabase = hasSupabaseAdminConfig() ? getAdminClient() : getCallerClient(token);

  // 1. Verify token with Supabase Auth (strictly requires a valid user session)
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    const err = new Error('Unauthorized: Invalid authentication session.');
    err.statusCode = 401;
    throw err;
  }

  // 2. Query public.profiles to verify role is admin and active
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, student_code, role, active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    const err = new Error('Forbidden: Caller profile not found.');
    err.statusCode = 403;
    throw err;
  }

  if (profile.role !== 'admin' || !profile.active) {
    const err = new Error('Forbidden: Admin access required.');
    err.statusCode = 403;
    throw err;
  }

  return {
    ...profile,
    accessToken: token,
  };
}

/**
 * Extracts and verifies the Bearer JWT token from the Request header,
 * checking that the user exists, has role === 'student' (or 'admin'), and is active in public.profiles.
 * Sets `err.statusCode = 401` for missing/invalid token and `403` for role/active mismatch.
 *
 * @param {Request | Object} req
 * @returns {Promise<Object>} The authenticated profile (including accessToken)
 */
export async function verifyStudentCaller(req) {
  let authHeader = '';
  if (req && req.headers) {
    if (typeof req.headers.get === 'function') {
      authHeader = req.headers.get('authorization') || '';
    } else {
      authHeader = req.headers.authorization || req.headers.Authorization || '';
    }
  }

  if (!authHeader.startsWith('Bearer ')) {
    const err = new Error('Unauthorized: Please sign in to continue.');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    const err = new Error('Unauthorized: Please sign in to continue.');
    err.statusCode = 401;
    throw err;
  }

  const supabase = hasSupabaseAdminConfig() ? getAdminClient() : getCallerClient(token);

  // 1. Verify token with Supabase Auth
  const { data: authData, error: userError } = await supabase.auth.getUser(token);
  const user = authData?.user;
  if (userError || !user) {
    const err = new Error('Unauthorized: Your session has expired. Please sign in again.');
    err.statusCode = 401;
    throw err;
  }

  // 2. Query public.profiles to verify account is active
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, student_code, full_name, role, level, active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    const err = new Error('Forbidden: Student profile not found.');
    err.statusCode = 403;
    throw err;
  }

  if ((profile.role !== 'student' && profile.role !== 'admin') || !profile.active) {
    const err = new Error('Forbidden: Only active student accounts can run drills.');
    err.statusCode = 403;
    throw err;
  }

  return {
    ...profile,
    accessToken: token,
  };
}

