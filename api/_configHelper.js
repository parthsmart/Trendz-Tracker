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
 * Reads and validates CRON_SECRET for scheduled GET /api/weekly-report and GET /api/backup runs.
 * Never falls back to any hardcoded value.
 */
export function getCronSecret(env = process.env) {
  const rawSecret = (env.CRON_SECRET || '').trim();
  if (isPlaceholder(rawSecret)) {
    throw new Error('Cron configuration error: CRON_SECRET must be configured in environment variables.');
  }
  return rawSecret;
}

/**
 * Extracts a clean Google Spreadsheet ID whether the env var contains a bare ID
 * or a full https://docs.google.com/spreadsheets/d/<ID>/... URL.
 */
function extractSpreadsheetId(rawValue) {
  const trimmed = String(rawValue || '').trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    return match[1];
  }
  return trimmed;
}

/**
 * Validates and extracts Google Service Account credentials and Backup Sheet ID.
 * Never logs or includes the key or JSON content in error messages.
 * Never falls back to any default values.
 */
export function getGoogleBackupConfig(env = process.env) {
  const rawJson = (env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const rawSheetId = extractSpreadsheetId(env.BACKUP_SHEET_ID);

  if (isPlaceholder(rawJson)) {
    throw new Error('Backup configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must be configured in environment variables.');
  }

  if (isPlaceholder(rawSheetId)) {
    throw new Error('Backup configuration error: BACKUP_SHEET_ID must be configured in environment variables.');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Backup configuration error: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Backup configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }

  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key.trim() : '';

  if (isPlaceholder(clientEmail) || !clientEmail.includes('@')) {
    throw new Error('Backup configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid client_email.');
  }

  if (isPlaceholder(rawPrivateKey) || !rawPrivateKey.includes('PRIVATE KEY')) {
    throw new Error('Backup configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid PEM private_key.');
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

  return {
    clientEmail,
    privateKey,
    sheetId: rawSheetId,
  };
}

/**
 * Checks whether both GOOGLE_SERVICE_ACCOUNT_JSON and BACKUP_SHEET_ID are validly configured.
 */
export function hasGoogleBackupConfig(env = process.env) {
  try {
    getGoogleBackupConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates and extracts Google Service Account credentials and optional Mirror Sheet ID (`MIRROR_SHEET_ID`).
 * If `MIRROR_SHEET_ID` is not set, `hasGoogleMirrorConfig(env)` returns `false` without error.
 */
export function getGoogleMirrorConfig(env = process.env) {
  const rawJson = (env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const rawMirrorSheetId = extractSpreadsheetId(env.MIRROR_SHEET_ID);

  if (isPlaceholder(rawJson)) {
    throw new Error('Mirror configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must be configured in environment variables.');
  }

  if (isPlaceholder(rawMirrorSheetId)) {
    throw new Error('Mirror configuration error: MIRROR_SHEET_ID must be configured in environment variables.');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Mirror configuration error: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Mirror configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }

  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key.trim() : '';

  if (isPlaceholder(clientEmail) || !clientEmail.includes('@')) {
    throw new Error('Mirror configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid client_email.');
  }

  if (isPlaceholder(rawPrivateKey) || !rawPrivateKey.includes('PRIVATE KEY')) {
    throw new Error('Mirror configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid PEM private_key.');
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

  return {
    clientEmail,
    privateKey,
    sheetId: rawMirrorSheetId,
    mirrorSheetId: rawMirrorSheetId,
  };
}

/**
 * Checks whether optional MIRROR_SHEET_ID (and GOOGLE_SERVICE_ACCOUNT_JSON) is configured.
 * If MIRROR_SHEET_ID is not set, returns false cleanly with no error.
 */
export function hasGoogleMirrorConfig(env = process.env) {
  try {
    getGoogleMirrorConfig(env);
    return true;
  } catch {
    return false;
  }
}



