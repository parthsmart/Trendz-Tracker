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
 * Checks whether a valid non-placeholder Service Role Key is configured on the server.
 */
export function hasSupabaseAdminConfig(env = process.env) {
  const rawUrl = pickValidEnv(env.VITE_SUPABASE_URL, env.SUPABASE_URL);
  const rawAnonKey = pickValidEnv(env.VITE_SUPABASE_ANON_KEY, env.SUPABASE_ANON_KEY);
  const rawServiceKey = pickValidEnv(
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_SERVICE_KEY,
    env.VITE_SUPABASE_SERVICE_ROLE_KEY
  );
  return Boolean(rawUrl && rawAnonKey && rawServiceKey);
}

/**
 * Reads and validates Supabase Service Role Key for server-only administrative tasks.
 * Throws 500 error if unconfigured or placeholder.
 */
export function getSupabaseAdminConfig(env = process.env) {
  const { url, anonKey } = getSupabaseServerConfig();
  const rawServiceKey = pickValidEnv(
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_SERVICE_KEY,
    env.VITE_SUPABASE_SERVICE_ROLE_KEY
  );

  if (isPlaceholder(rawServiceKey)) {
    throw new Error('Supabase configuration error: SUPABASE_SERVICE_ROLE_KEY must be properly configured in environment variables.');
  }

  return {
    url,
    anonKey,
    serviceRoleKey: rawServiceKey,
  };
}

const DEFAULT_REPORT_FROM_EMAIL = 'Trendz Tracker <onboarding@resend.dev>';

/**
 * Reads and validates email configuration for weekly report delivery via Resend.
 * Never falls back for RESEND_API_KEY or REPORT_TO_EMAIL.
 * REPORT_FROM_EMAIL is optional and defaults to "Trendz Tracker <onboarding@resend.dev>".
 */
export function getEmailReportConfig(env = process.env) {
  const rawApiKey = (env.RESEND_API_KEY || '').trim();
  const rawToEmail = (env.REPORT_TO_EMAIL || '').trim();
  const rawFromEmail = (env.REPORT_FROM_EMAIL || '').trim();

  if (isPlaceholder(rawApiKey)) {
    throw new Error('Email configuration error: RESEND_API_KEY must be configured in environment variables.');
  }

  if (isPlaceholder(rawToEmail) || !rawToEmail.includes('@')) {
    throw new Error('Email configuration error: REPORT_TO_EMAIL must be a valid email address in environment variables.');
  }

  const fromEmail = !isPlaceholder(rawFromEmail) ? rawFromEmail : DEFAULT_REPORT_FROM_EMAIL;

  return {
    resendApiKey: rawApiKey,
    toEmail: rawToEmail,
    fromEmail,
  };
}

/**
 * Reads and validates CRON_SECRET for scheduled GET /api/weekly-report runs.
 * Never falls back to any hardcoded value.
 */
export function getCronSecret(env = process.env) {
  const rawSecret = (env.CRON_SECRET || '').trim();
  if (isPlaceholder(rawSecret)) {
    throw new Error('Cron configuration error: CRON_SECRET must be configured in environment variables.');
  }
  return rawSecret;
}

