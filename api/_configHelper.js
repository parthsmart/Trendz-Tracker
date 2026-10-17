/**
 * Trendz Tracker - Central Server Configuration Helper
 * Single source of truth for validating and reading Supabase server environment variables.
 * Never falls back to hardcoded project URLs or keys.
 */

function isPlaceholder(val) {
  if (!val || typeof val !== 'string') return true;
  const trimmed = val.trim();
  return (
    trimmed === '' ||
    trimmed.includes('your-project-ref') ||
    trimmed.includes('YOUR_SUPABASE_') ||
    trimmed.startsWith('YOUR_')
  );
}

/**
 * Reads and validates public Supabase URL and Anon Key.
 * Throws 500 error if unconfigured or placeholder.
 */
export function getSupabaseServerConfig() {
  const rawUrl = (process.env.SUPABASE_URL || '').trim();
  const rawAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  if (isPlaceholder(rawUrl) || isPlaceholder(rawAnonKey)) {
    throw new Error('Supabase configuration error: SUPABASE_URL and SUPABASE_ANON_KEY must be properly configured in environment variables.');
  }

  const cleanUrl = rawUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
  return {
    url: cleanUrl,
    anonKey: rawAnonKey,
  };
}

/**
 * Reads and validates Supabase Service Role Key for server-only administrative tasks.
 * Throws 500 error if unconfigured or placeholder.
 */
export function getSupabaseAdminConfig() {
  const { url, anonKey } = getSupabaseServerConfig();
  const rawServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (isPlaceholder(rawServiceKey)) {
    throw new Error('Supabase configuration error: SUPABASE_SERVICE_ROLE_KEY must be properly configured in environment variables.');
  }

  return {
    url,
    anonKey,
    serviceRoleKey: rawServiceKey,
  };
}
