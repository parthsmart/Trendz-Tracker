/**
 * Trendz Tracker - Weekly Report Email Serverless Endpoint (/api/weekly-report.js)
 *
 * Supports:
 * 1. GET (Scheduled Vercel Cron run):
 *    - Requires `Authorization: Bearer <CRON_SECRET>` verified in constant time; returns 401 otherwise.
 *    - Calls `weekly_report_data()` with the service role.
 *    - Inserts a `report_log` row (`kind: 'cron'`, `status: 'sending'`, `week_start` from data).
 *    - If the unique index rejects it (`23505`), returns 200 `{ skipped: true }` without sending.
 *    - Builds email via `buildWeeklyEmail(data)` and sends via Resend REST API (`POST https://api.resend.com/emails`).
 *    - Updates `report_log` (`status: 'sent'` or `'failed'`, `finished_at`, sanitized short `error`).
 *    - Returns `{ ok, status }`.
 *
 * 2. POST (Authenticated Admin action):
 *    - Requires active admin JWT (`verifyAdminCaller`).
 *    - Body `{ preview: true }`: calls `weekly_report_data()`, builds email, returns `{ subject, html, text }` without sending.
 *    - Body `{ send: true }`: inserts `report_log` (`kind: 'manual'`, `status: 'sending'`, `created_by`), sends via Resend, updates `report_log`, returns `{ ok, status }`.
 *
 * SECURITY INVARIANTS:
 * - Never logs or returns `RESEND_API_KEY`, `CRON_SECRET`, or `SUPABASE_SERVICE_ROLE_KEY`.
 * - Never includes student data in server logs.
 */

import crypto from 'node:crypto';
import { getEmailReportConfig, getCronSecret, hasSupabaseAdminConfig } from './_configHelper.js';
import { buildWeeklyEmail } from './_reportEmail.js';
import { getAdminClient, getCallerClient, verifyAdminCaller } from './_supabaseAdmin.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Compares an Authorization header against `Bearer <expectedSecret>` in constant time.
 * @param {string} authHeader
 * @param {string} expectedSecret
 * @returns {boolean}
 */
export function verifyCronAuthorizationHeader(authHeader, expectedSecret) {
  if (typeof authHeader !== 'string' || typeof expectedSecret !== 'string' || !expectedSecret) {
    return false;
  }
  const expectedHeader = `Bearer ${expectedSecret}`;
  const hashReceived = crypto.createHash('sha256').update(authHeader, 'utf8').digest();
  const hashExpected = crypto.createHash('sha256').update(expectedHeader, 'utf8').digest();
  const hashesEqual = crypto.timingSafeEqual(hashReceived, hashExpected);
  const lengthsEqual = Buffer.byteLength(authHeader, 'utf8') === Buffer.byteLength(expectedHeader, 'utf8');
  return hashesEqual && lengthsEqual;
}

/**
 * Scrubs any sensitive token/key from an error message and truncates to 240 chars.
 * @param {unknown} err
 * @param {string[]} secretsToScrub
 * @returns {string}
 */
export function sanitizeReportError(err, secretsToScrub = []) {
  let msg = err instanceof Error ? err.message : String(err || 'Unknown report error');
  for (const secret of secretsToScrub) {
    if (secret && typeof secret === 'string' && secret.length >= 4) {
      msg = msg.split(secret).join('[REDACTED]');
    }
  }
  // Scrub any bearer token pattern just in case
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  msg = msg.replace(/re_[A-Za-z0-9_]+/g, '[REDACTED_KEY]');
  return msg.slice(0, 240);
}

/**
 * Extracts Authorization header from Node/Express or Fetch Request.
 */
function readAuthorizationHeader(req) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return req.headers.get('authorization') || '';
  }
  return req.headers.authorization || req.headers.Authorization || '';
}

/**
 * Sends an email via the Resend REST API using native fetch.
 */
async function sendEmailViaResend({ resendApiKey, fromEmail, toEmail, subject, html, text }) {
  const recipients = toEmail
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean);

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: recipients.length === 1 ? recipients[0] : recipients,
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    let errDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson && (errJson.message || errJson.name)) {
        errDetail = `${errDetail}: ${errJson.message || errJson.name}`;
      }
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(`Resend API error (${errDetail})`);
  }

  return true;
}

/**
 * Helper to subtract days from a YYYY-MM-DD date string cleanly in UTC.
 */
function subtractDaysDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - days));
  return dt.toISOString().split('T')[0];
}

/**
 * Helper to compute calendar day difference between two YYYY-MM-DD strings.
 */
function daysBetweenDateStrs(laterStr, earlierStr) {
  if (!laterStr || !earlierStr) return null;
  const [y1, m1, d1] = String(laterStr).split('-').map(Number);
  const [y2, m2, d2] = String(earlierStr).split('-').map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

/**
 * Assembles the weekly_report_data payload from admin-accessible SQL RPCs
 * when SUPABASE_SERVICE_ROLE_KEY is not configured in environment variables.
 * Uses only numbers returned by the database RPCs (admin_overview, admin_milestones, leaderboard_board).
 */
async function buildWeeklyReportDataFromAdminSession(callerClient) {
  const { data: istDate } = await callerClient.rpc('today_ist');
  const weekEnd = istDate && typeof istDate === 'string'
    ? istDate.slice(0, 10)
    : new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const weekStart = subtractDaysDateStr(weekEnd, 6);

  const [
    overviewRes,
    milestonesRes,
    boardRes,
    speedRes,
    sessionsRes,
    testsRes,
  ] = await Promise.all([
    callerClient.rpc('admin_overview'),
    callerClient.rpc('admin_milestones', { p_days: 7 }),
    callerClient.rpc('leaderboard_board', { p_board: 'overall', p_period: 'week', p_level: null }),
    callerClient.rpc('leaderboard_board', { p_board: 'speed', p_period: 'week', p_level: null }),
    callerClient
      .from('sessions')
      .select('id, session_date, title, session_type, attendance(status)')
      .gte('session_date', weekStart)
      .lte('session_date', weekEnd)
      .order('session_date', { ascending: true }),
    callerClient
      .from('weekly_tests')
      .select('id, test_date, title, weekly_test_scores(id)')
      .gte('test_date', weekStart)
      .lte('test_date', weekEnd)
      .order('test_date', { ascending: true }),
  ]);

  if (overviewRes.error) {
    throw new Error(`Database admin_overview RPC failed: ${overviewRes.error.message}`);
  }

  const overviewRows = Array.isArray(overviewRes.data) ? overviewRes.data : [];
  const activeStudents = overviewRows.filter((s) => s.active !== false);

  const boardByCode = new Map();
  if (Array.isArray(boardRes?.data)) {
    for (const row of boardRes.data) {
      if (row.student_code) boardByCode.set(row.student_code, row);
    }
  }

  const speedByCode = new Map();
  if (Array.isArray(speedRes?.data)) {
    for (const row of speedRes.data) {
      if (row.student_code) speedByCode.set(row.student_code, row);
    }
  }

  const studentsWithEntries = activeStudents.filter((s) => Number(s.entries_7d) > 0);
  const accValues = studentsWithEntries
    .map((s) => s.accuracy_7d)
    .filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v)))
    .map(Number);

  const avgAccuracy =
    accValues.length > 0
      ? Number((accValues.reduce((sum, v) => sum + v, 0) / accValues.length).toFixed(1))
      : null;

  const students = activeStudents.map((s) => {
    const overallRow = boardByCode.get(s.student_code);
    const speedRow = speedByCode.get(s.student_code);
    const entries = Number(s.entries_7d) || 0;
    return {
      code: s.student_code,
      name: s.full_name,
      level: s.level || null,
      practice_days: overallRow?.practice_days ?? (entries > 0 ? Math.min(7, entries) : 0),
      entries,
      accuracy: s.accuracy_7d !== null && s.accuracy_7d !== undefined ? Number(s.accuracy_7d) : null,
      qpm: speedRow?.metric_value !== undefined && speedRow?.metric_value !== null ? Number(speedRow.metric_value) : null,
      streak: Number(s.current_streak) || 0,
      points: overallRow?.metric_value !== undefined && overallRow?.metric_value !== null ? Number(overallRow.metric_value) : 0,
    };
  });

  const needsAttention = activeStudents
    .filter((s) => {
      if (!s.last_entry_date) return true;
      const diff = daysBetweenDateStrs(weekEnd, s.last_entry_date);
      return diff !== null && diff >= 3;
    })
    .map((s) => ({
      code: s.student_code,
      name: s.full_name,
      level: s.level || null,
      last_entry: s.last_entry_date || null,
      days_ago: s.last_entry_date ? daysBetweenDateStrs(weekEnd, s.last_entry_date) : null,
    }));

  const milestoneRows = Array.isArray(milestonesRes?.data) ? milestonesRes.data : [];
  const milestones = milestoneRows.map((m) => ({
    code: m.student_code,
    name: m.full_name,
    level: m.level || null,
    milestone: Number(m.milestone || m.current_streak || 25),
    streak: Number(m.current_streak || m.milestone || 25),
  }));

  const sessionRows = Array.isArray(sessionsRes?.data) ? sessionsRes.data : [];
  const sessions = sessionRows.map((sess) => {
    const att = Array.isArray(sess.attendance) ? sess.attendance : [];
    return {
      date: sess.session_date,
      title: sess.title,
      type: sess.session_type || 'Regular',
      present: att.filter((a) => a.status === 'present').length,
      absent: att.filter((a) => a.status === 'absent').length,
      excused: att.filter((a) => a.status === 'excused').length,
    };
  });

  const testRows = Array.isArray(testsRes?.data) ? testsRes.data : [];
  const weeklyTests = testRows.map((t) => ({
    date: t.test_date,
    title: t.title,
    scores: Array.isArray(t.weekly_test_scores) ? t.weekly_test_scores.length : 0,
  }));

  return {
    week_start: weekStart,
    week_end: weekEnd,
    generated_on: weekEnd,
    summary: {
      active_students: activeStudents.length,
      students_with_entries: studentsWithEntries.length,
      accuracy: avgAccuracy,
    },
    students,
    needs_attention: needsAttention,
    milestones,
    sessions,
    weekly_tests: weeklyTests,
  };
}

/**
 * Queries latest completed Google backup, manual export timestamps, and score-sheet mirror status
 * from `backup_runs` and `mirror_state` when not already embedded in `weekly_report_data()`.
 */
async function attachBackupSummaryIfMissing(client, reportData) {
  if (!reportData || typeof reportData !== 'object') {
    return reportData;
  }
  try {
    const existingBackup =
      reportData.backup && typeof reportData.backup === 'object' ? { ...reportData.backup } : null;

    let lastGoogleAt = existingBackup?.last_google_at || existingBackup?.last_run_at || null;
    let lastExportAt = existingBackup?.last_export_at || null;
    let daysSinceBackup =
      existingBackup?.days_since_backup !== undefined ? existingBackup.days_since_backup : null;

    if (!existingBackup) {
      const [googleRes, exportRes] = await Promise.all([
        client
          .from('backup_runs')
          .select('finished_at, started_at')
          .in('kind', ['cron', 'manual'])
          .eq('status', 'done')
          .order('finished_at', { ascending: false })
          .limit(1),
        client
          .from('backup_runs')
          .select('finished_at, started_at')
          .eq('kind', 'export')
          .eq('status', 'done')
          .order('finished_at', { ascending: false })
          .limit(1),
      ]);
      lastGoogleAt = googleRes?.data?.[0]?.finished_at || googleRes?.data?.[0]?.started_at || null;
      lastExportAt = exportRes?.data?.[0]?.finished_at || exportRes?.data?.[0]?.started_at || null;
      const latestAny = [lastGoogleAt, lastExportAt]
        .filter(Boolean)
        .sort()
        .pop() || null;
      daysSinceBackup = latestAny
        ? Math.max(0, Math.floor((Date.now() - new Date(latestAny).getTime()) / 86400000))
        : null;
    }

    let mirror = existingBackup?.mirror || reportData.mirror || null;
    if (!mirror) {
      let stateRows = [];
      try {
        const { data: mData } = await client.from('mirror_state').select('*');
        if (Array.isArray(mData)) stateRows = mData;
      } catch {
        stateRows = [];
      }

      let totalStudents = Number(reportData.summary?.active_students ?? stateRows.length);
      let upToDateCount = 0;

      let fpList = null;
      try {
        if (typeof client.rpc === 'function') {
          const { data: fpData, error: fpErr } = await client.rpc('mirror_fingerprints');
          if (!fpErr && Array.isArray(fpData)) {
            fpList = fpData;
          }
        }
      } catch {
        fpList = null;
      }

      if (fpList) {
        totalStudents = fpList.length;
        const stateByStudent = new Map(stateRows.map((r) => [String(r.student_id), r]));
        for (const fp of fpList) {
          const st = stateByStudent.get(String(fp.student_id));
          if (st && st.fingerprint && String(st.fingerprint) === String(fp.fingerprint) && !st.last_error) {
            upToDateCount += 1;
          }
        }
      } else {
        upToDateCount = stateRows.filter((r) => r && r.fingerprint && !r.last_error).length;
      }

      let lastBuiltAt = null;
      for (const r of stateRows) {
        if (r?.last_built_at) {
          if (!lastBuiltAt || new Date(r.last_built_at).getTime() > new Date(lastBuiltAt).getTime()) {
            lastBuiltAt = r.last_built_at;
          }
        }
      }

      const daysSinceBuilt = lastBuiltAt
        ? Math.max(0, Math.floor((Date.now() - new Date(lastBuiltAt).getTime()) / 86400000))
        : null;

      mirror = {
        up_to_date: upToDateCount,
        total: totalStudents,
        last_built_at: lastBuiltAt,
        days_since_built: daysSinceBuilt,
      };
    }

    return {
      ...reportData,
      backup: {
        ...(existingBackup || {}),
        last_google_at: lastGoogleAt,
        last_export_at: lastExportAt,
        days_since_backup: daysSinceBackup,
        mirror,
      },
    };
  } catch {
    return reportData;
  }
}

/**
 * Helper to add days to a YYYY-MM-DD date string cleanly in UTC.
 */
function addDaysDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split('T')[0];
}

/**
 * Phase 13b: Queries `weekly_tests` for the next 7 days (listing title, type, date, and level)
 * using the service-role client (or admin caller client fallback) if not already embedded.
 */
async function attachUpcomingWeeklyTestsIfMissing(client, reportData) {
  if (!reportData || typeof reportData !== 'object') {
    return reportData;
  }
  if (Array.isArray(reportData.upcoming_weekly_tests)) {
    return reportData;
  }

  try {
    const baseDate =
      reportData.generated_on ||
      reportData.week_end ||
      new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const startStr = String(baseDate).slice(0, 10);
    const endStr = addDaysDateStr(startStr, 7);

    const { data, error } = await client
      .from('weekly_tests')
      .select('title, test_type, test_date, audience_level')
      .gte('test_date', startStr)
      .lte('test_date', endStr)
      .order('test_date', { ascending: true });

    if (error || !Array.isArray(data)) {
      return {
        ...reportData,
        upcoming_weekly_tests: [],
      };
    }

    const upcomingWeeklyTests = data.map((row) => ({
      title: row.title || 'Weekly Test',
      type: row.test_type || 'offline',
      date: row.test_date,
      level: row.audience_level || null,
    }));

    return {
      ...reportData,
      upcoming_weekly_tests: upcomingWeeklyTests,
    };
  } catch {
    return {
      ...reportData,
      upcoming_weekly_tests: [],
    };
  }
}

/**
 * Fetches weekly report data using the Supabase service-role client,
 * or falls back to the verified admin caller client when SUPABASE_SERVICE_ROLE_KEY is not configured.
 */
async function fetchWeeklyReportData(supabase, callerClient = null) {
  const clientToTry = supabase || callerClient;
  if (!clientToTry) {
    throw new Error('Supabase client is unavailable.');
  }

  const { data, error } = await clientToTry.rpc('weekly_report_data');
  if (!error && data && typeof data === 'object') {
    const withBackup = await attachBackupSummaryIfMissing(clientToTry, data);
    return attachUpcomingWeeklyTestsIfMissing(clientToTry, withBackup);
  }

  // If weekly_report_data requires service_role and we have an authenticated admin callerClient,
  // assemble the report from the admin-authorized SQL RPCs.
  if (callerClient) {
    const fallbackData = await buildWeeklyReportDataFromAdminSession(callerClient);
    const withBackup = await attachBackupSummaryIfMissing(callerClient, fallbackData);
    return attachUpcomingWeeklyTestsIfMissing(callerClient, withBackup);
  }

  if (error) {
    throw new Error(`Database weekly_report_data RPC failed: ${error.message}`);
  }
  throw new Error('Database weekly_report_data returned empty payload.');
}

/**
 * Executes the log -> build -> send -> update workflow for both cron and manual sends.
 */
async function executeSendWorkflow({ supabase, reportData, kind, createdBy }) {
  const emailConfig = getEmailReportConfig();
  const secrets = [emailConfig.resendApiKey];

  const weekStart = reportData.week_start || new Date().toISOString().split('T')[0];
  const createdAtIso = new Date().toISOString();

  // 1. Insert report_log row with status 'sending'
  const insertPayload = {
    week_start: weekStart,
    kind,
    status: 'sending',
    to_email: emailConfig.toEmail,
    created_by: createdBy || null,
  };

  const { data: logRow, error: insertError } = await supabase
    .from('report_log')
    .insert(insertPayload)
    .select('id')
    .single();

  if (insertError) {
    const errCode = String(insertError.code || '');
    const errMsg = String(insertError.message || '').toLowerCase();
    // If unique index rejects a scheduled cron run, return { skipped: true }
    if (
      kind === 'cron' &&
      (errCode === '23505' || errMsg.includes('unique') || errMsg.includes('duplicate key'))
    ) {
      return { httpStatus: 200, body: { skipped: true } };
    }
    // For manual admin sends when SUPABASE_SERVICE_ROLE_KEY is not configured,
    // RLS on report_log may reject non-service-role inserts (42501). Continue sending the email.
    const isRlsPermissionError =
      kind === 'manual' &&
      (errCode === '42501' || errMsg.includes('row-level security') || errMsg.includes('permission denied'));

    if (!isRlsPermissionError) {
      throw new Error(
        sanitizeReportError(`Failed to create report_log entry: ${insertError.message}`, secrets)
      );
    }
  }

  const logId = logRow?.id || null;

  // 2. Build email and send via Resend
  try {
    const email = buildWeeklyEmail(reportData);
    await sendEmailViaResend({
      resendApiKey: emailConfig.resendApiKey,
      fromEmail: emailConfig.fromEmail,
      toEmail: emailConfig.toEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    const finishedAtIso = new Date().toISOString();

    if (logId) {
      await supabase
        .from('report_log')
        .update({
          status: 'sent',
          finished_at: finishedAtIso,
          error: null,
        })
        .eq('id', logId);
    }

    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: 'sent',
        logEntry: !logId
          ? {
              id: crypto.randomUUID(),
              week_start: weekStart,
              kind,
              status: 'sent',
              error: null,
              to_email: emailConfig.toEmail,
              created_by: createdBy || null,
              created_at: createdAtIso,
              finished_at: finishedAtIso,
            }
          : undefined,
      },
    };
  } catch (sendErr) {
    const safeErrMsg = sanitizeReportError(sendErr, secrets);
    const finishedAtIso = new Date().toISOString();

    if (logId) {
      await supabase
        .from('report_log')
        .update({
          status: 'failed',
          finished_at: finishedAtIso,
          error: safeErrMsg,
        })
        .eq('id', logId);
    }

    return {
      httpStatus: 502,
      body: {
        ok: false,
        status: 'failed',
        error: safeErrMsg,
        logEntry: !logId
          ? {
              id: crypto.randomUUID(),
              week_start: weekStart,
              kind,
              status: 'failed',
              error: safeErrMsg,
              to_email: emailConfig.toEmail,
              created_by: createdBy || null,
              created_at: createdAtIso,
              finished_at: finishedAtIso,
            }
          : undefined,
      },
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // =========================================================================
  // 1. GET = Scheduled Cron Run
  // =========================================================================
  if (req.method === 'GET') {
    let cronSecret = '';
    try {
      cronSecret = getCronSecret();
    } catch (cfgErr) {
      return res.status(500).json({ ok: false, status: 'failed', error: cfgErr.message });
    }

    const authHeader = readAuthorizationHeader(req);
    if (!verifyCronAuthorizationHeader(authHeader, cronSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const supabase = getAdminClient();
      const reportData = await fetchWeeklyReportData(supabase);
      const result = await executeSendWorkflow({
        supabase,
        reportData,
        kind: 'cron',
        createdBy: null,
      });
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      const safeErr = sanitizeReportError(err, [cronSecret, process.env.RESEND_API_KEY || '']);
      console.error('Scheduled weekly report failed:', safeErr);
      return res.status(500).json({ ok: false, status: 'failed', error: safeErr });
    }
  }

  // =========================================================================
  // 2. POST = Admin Action (Preview or Manual Send)
  // =========================================================================
  if (req.method === 'POST') {
    let adminProfile;
    try {
      adminProfile = await verifyAdminCaller(req);
    } catch (authErr) {
      const msg = authErr.message || 'Unauthorized';
      const status = msg.startsWith('Forbidden') ? 403 : 401;
      return res.status(status).json({ error: msg });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const isPreview = body.preview === true;
    const isSend = body.send === true;

    if (!isPreview && !isSend) {
      return res.status(400).json({
        error: 'Request body must specify either { "preview": true } or { "send": true }.',
      });
    }

    try {
      const hasAdminKey = hasSupabaseAdminConfig();
      const callerClient = getCallerClient(adminProfile.accessToken);
      const supabase = hasAdminKey ? getAdminClient() : callerClient;
      const reportData = await fetchWeeklyReportData(
        hasAdminKey ? supabase : null,
        callerClient
      );

      if (isPreview) {
        const email = buildWeeklyEmail(reportData);
        return res.status(200).json({
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      }

      // Manual send
      const result = await executeSendWorkflow({
        supabase,
        reportData,
        kind: 'manual',
        createdBy: adminProfile.id,
      });
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      const safeErr = sanitizeReportError(err, [process.env.RESEND_API_KEY || '']);
      console.error('Manual weekly report action failed:', safeErr);
      return res.status(500).json({ ok: false, status: 'failed', error: safeErr });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
