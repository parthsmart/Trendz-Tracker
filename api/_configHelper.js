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
    trimmed.includes('<your-') ||
    trimmed.includes('YOUR_SUPABASE_') ||
    trimmed.startsWith('YOUR_') ||
    trimmed.endsWith('...')
  );
}

/**
 * Picks the first non-placeholder value from a list of candidate environment variable values.
 */
function pickValidEnv(...candidates) {
  for (const candidate of candidates) {
    if (!isPlaceholder(candidate)) {
      return candidate.trim();
    }
  }
  return '';
}

/**
 * Reads and validates public Supabase URL and Anon Key from either
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY or SUPABASE_URL / SUPABASE_ANON_KEY.
 * Throws 500 error if unconfigured or placeholder.
 */
export function getSupabaseServerConfig() {
  const rawUrl = pickValidEnv(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_URL);
  const rawAnonKey = pickValidEnv(process.env.VITE_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY);

  if (!rawUrl || !rawAnonKey) {
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
