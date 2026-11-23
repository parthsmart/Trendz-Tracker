import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

export const APPROVED_STAGING_SUPABASE_ORIGIN = 'https://xhgzbbkvwojwfbexvcmh.supabase.co';
export const EXPECTED_STAGING_PROJECT_REF = 'xhgzbbkvwojwfbexvcmh';
export const RETIRED_PROJECT_REF = 'ctwjujnqxkhononxykdc';
export const PRODUCTION_PROJECT_REF = 'kgzivhavpsvitwrscrrj';

function normalizeSupabaseOrigin(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return '';
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

// 1. Read and validate environment configuration
const envFile = process.env.ENV_FILE || '.env.staging.local';
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const urlMatch = env.match(/VITE_SUPABASE_URL=(.+)/);
const keyMatch = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/);

const supabaseUrl = (process.env.VITE_SUPABASE_URL || (urlMatch ? urlMatch[1].trim() : '')).trim();
const supabaseKey = (process.env.VITE_SUPABASE_ANON_KEY || (keyMatch ? keyMatch[1].trim() : '')).trim();

if (!supabaseUrl || !supabaseKey) {
  console.error('[CONFIG FATAL] Missing Supabase configuration (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  process.exit(1);
}

// Ensure the local script config points strictly to exact approved HTTPS staging origin
const cleanScriptOrigin = normalizeSupabaseOrigin(supabaseUrl);
if (cleanScriptOrigin !== APPROVED_STAGING_SUPABASE_ORIGIN) {
  console.error(`[CONFIG FATAL] Supabase URL does not match exact approved HTTPS staging origin (${APPROVED_STAGING_SUPABASE_ORIGIN}): received "${supabaseUrl}"`);
  process.exit(1);
}
if (cleanScriptOrigin.includes(PRODUCTION_PROJECT_REF) || cleanScriptOrigin.includes(RETIRED_PROJECT_REF)) {
  console.error(`[CONFIG FATAL] Supabase URL points to forbidden production or retired project ref: ${supabaseUrl}`);
  process.exit(1);
}

// 2. Verify localhost preview server configuration before sending any credentials
async function verifyPreviewServerConfig() {
  const configUrl = 'http://localhost:3000/api/config';
  let res;
  try {
    res = await fetch(configUrl);
  } catch (err) {
    console.error(`[CONFIG FATAL] Could not connect to localhost preview server at ${configUrl}: ${err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`[CONFIG FATAL] Localhost preview /api/config responded with status ${res.status}`);
    process.exit(1);
  }

  const previewConfig = await res.json();
  const rawPreviewUrl = (previewConfig.supabaseUrl || '').trim();
  const cleanPreviewOrigin = normalizeSupabaseOrigin(rawPreviewUrl);

  if (cleanPreviewOrigin !== APPROVED_STAGING_SUPABASE_ORIGIN) {
    console.error(`[CONFIG FATAL] Preview server /api/config does not match exact approved HTTPS staging origin (${APPROVED_STAGING_SUPABASE_ORIGIN}): received "${rawPreviewUrl}"`);
    process.exit(1);
  }
  if (cleanPreviewOrigin.includes(PRODUCTION_PROJECT_REF) || cleanPreviewOrigin.includes(RETIRED_PROJECT_REF)) {
    console.error(`[CONFIG FATAL] Preview server points to forbidden production or retired project: ${rawPreviewUrl}`);
    process.exit(1);
  }

  console.log(`[STAGING ISOLATION VERIFIED] Both script and preview server point strictly to exact approved HTTPS staging origin: ${APPROVED_STAGING_SUPABASE_ORIGIN}\n`);
}

// 3. Load account passwords from private staging accounts file or process.env
const accountsPath = path.resolve('../private/phase18-staging-accounts.json');
let stagingAccounts = [];
if (fs.existsSync(accountsPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    stagingAccounts = raw.accounts || [];
  } catch (err) {
    console.warn('[verify-staging-api] Could not parse accounts file:', err.message);
  }
}

function getAccountPassword(email, envVarFallback) {
  if (process.env[envVarFallback]) return process.env[envVarFallback];
  const found = stagingAccounts.find(a => a.email === email);
  if (found && found.password) return found.password;
  if (email === 'suniltrendzeducation@gmail.com') {
    const adm = stagingAccounts.find(a => a.login === 'STG-ADM');
    if (adm && adm.password) return adm.password;
  }
  return process.env[envVarFallback] || '';
}

const classId = process.env.STAGING_CLASS_ID || '2996d902-6009-4739-b673-e22d4e10a238';

const ROLES_TO_TEST = [
  {
    roleName: 'Matching Admin Host',
    email: 'suniltrendzeducation@gmail.com',
    envFallback: 'MATCHING_ADMIN_PASSWORD',
    expectedDetailsStatus: 200,
    expectedJoinStatus: 200,
    expectedIsHost: true,
    expectedEmbedUrl: true,
  },
  {
    roleName: 'Mismatch Admin',
    email: 'stg-adm@trendz.local',
    envFallback: 'STG_ADM_PASSWORD',
    expectedDetailsStatus: 200,
    expectedJoinStatus: 403,
    expectedJoinErrorPattern: /requires caller account email to match/i,
    expectedEmbedUrl: false,
  },
  {
    roleName: 'Invited Teacher',
    email: 'stg-tch@trendz.local',
    envFallback: 'STG_TCH_PASSWORD',
    expectedDetailsStatus: 200,
    expectedJoinStatus: 200,
    expectedIsHost: false,
    expectedEmbedUrl: true,
  },
  {
    roleName: 'Uninvited Teacher',
    email: 'stg-tch-ui@trendz.local',
    envFallback: 'STG_TCH_UI_PASSWORD',
    expectedDetailsStatus: 403,
    expectedDetailsErrorPattern: /not invited/i,
    expectedJoinStatus: 403,
    expectedJoinErrorPattern: /not invited/i,
    expectedEmbedUrl: false,
  },
  {
    roleName: 'Enrolled Student',
    email: 'stg-001@trendz.local',
    envFallback: 'STG_001_PASSWORD',
    expectedDetailsStatus: 200,
    expectedJoinStatus: 200,
    expectedIsHost: false,
    expectedEmbedUrl: true,
  },
  {
    roleName: 'Unenrolled Student',
    email: 'stg-002@trendz.local',
    envFallback: 'STG_002_PASSWORD',
    expectedDetailsStatus: 403,
    expectedDetailsErrorPattern: /not enrolled/i,
    expectedJoinStatus: 403,
    expectedJoinErrorPattern: /not enrolled/i,
    expectedEmbedUrl: false,
  },
];

async function run() {
  await verifyPreviewServerConfig();

  const results = [];
  let hasFailure = false;

  for (const item of ROLES_TO_TEST) {
    const password = getAccountPassword(item.email, item.envFallback);
    if (!password) {
      console.error(`[FATAL] Password missing for ${item.roleName} (${item.email}). All 6 accounts are required.`);
      hasFailure = true;
      continue;
    }

    const client = createClient(supabaseUrl, supabaseKey);
    const { data: authData, error: authErr } = await client.auth.signInWithPassword({
      email: item.email,
      password,
    });

    if (authErr || !authData?.session) {
      console.error(`[FATAL] Sign in failed for ${item.roleName} (${item.email}):`, authErr?.message || authErr);
      hasFailure = true;
      continue;
    }

    const token = authData.session.access_token;

    // 1. Test get_class_details
    let detailsRes;
    let details;
    try {
      detailsRes = await fetch('http://localhost:3000/api/live-class', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'get_class_details', classId }),
      });
      details = await detailsRes.json();
    } catch (err) {
      console.error(`[FATAL] Network error during get_class_details for ${item.email}: ${err.message}`);
      hasFailure = true;
      continue;
    }

    // 2. Test join
    let joinRes;
    let joinBody;
    try {
      joinRes = await fetch('http://localhost:3000/api/live-class', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'join', classId }),
      });
      joinBody = await joinRes.json();
    } catch (err) {
      console.error(`[FATAL] Network error during join for ${item.email}: ${err.message}`);
      hasFailure = true;
      continue;
    }

    // Assert expectations
    let rolePassed = true;
    const errors = [];

    if (detailsRes.status !== item.expectedDetailsStatus) {
      rolePassed = false;
      errors.push(`details status: expected ${item.expectedDetailsStatus}, got ${detailsRes.status} (${details.error || 'none'})`);
    }

    if (item.expectedDetailsErrorPattern && !item.expectedDetailsErrorPattern.test(details.error || '')) {
      rolePassed = false;
      errors.push(`details error: expected match ${item.expectedDetailsErrorPattern}, got "${details.error}"`);
    }

    if (joinRes.status !== item.expectedJoinStatus) {
      rolePassed = false;
      errors.push(`join status: expected ${item.expectedJoinStatus}, got ${joinRes.status} (${joinBody.error || 'none'})`);
    }

    if (item.expectedJoinErrorPattern && !item.expectedJoinErrorPattern.test(joinBody.error || '')) {
      rolePassed = false;
      errors.push(`join error: expected match ${item.expectedJoinErrorPattern}, got "${joinBody.error}"`);
    }

    if (item.expectedIsHost !== undefined && joinBody.isHost !== item.expectedIsHost) {
      rolePassed = false;
      errors.push(`isHost: expected ${item.expectedIsHost}, got ${joinBody.isHost}`);
    }

    const actualHasEmbed = Boolean(joinBody.embedUrl);
    if (actualHasEmbed !== item.expectedEmbedUrl) {
      rolePassed = false;
      errors.push(`embedUrl: expected ${item.expectedEmbedUrl}, got ${actualHasEmbed}`);
    }

    if (!rolePassed) {
      hasFailure = true;
    }

    results.push({
      role: item.roleName,
      email: item.email,
      detailsStatus: `${detailsRes.status} (exp: ${item.expectedDetailsStatus})`,
      joinStatus: `${joinRes.status} (exp: ${item.expectedJoinStatus})`,
      isHost: `${Boolean(joinBody.isHost)} (exp: ${Boolean(item.expectedIsHost)})`,
      hasEmbedUrl: `${actualHasEmbed} (exp: ${item.expectedEmbedUrl})`,
      outcome: rolePassed ? 'PASS' : 'FAIL',
      errors: errors.join('; '),
    });
  }

  console.log('='.repeat(95));
  console.log('ROLE AUTHORIZATION VERIFICATION REPORT (STAGING)');
  console.log('='.repeat(95));
  console.table(results, ['role', 'email', 'detailsStatus', 'joinStatus', 'isHost', 'hasEmbedUrl', 'outcome']);

  for (const r of results) {
    if (r.outcome === 'FAIL') {
      console.error(`[FAIL] ${r.role} (${r.email}): ${r.errors}`);
    }
  }

  if (hasFailure) {
    console.error('\n[VERIFICATION FAILED] One or more staging API checks failed.');
    process.exit(1);
  } else {
    console.log('\n[VERIFICATION PASSED] All 6 staging roles matched exact authorization expectations.');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('[UNCAUGHT FATAL]', err);
  process.exit(1);
});
