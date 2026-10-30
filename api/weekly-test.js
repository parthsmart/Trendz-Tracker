/**
 * Trendz Tracker - Online Weekly Test Serverless Endpoint (api/weekly-test.js)
 *
 * Actions:
 * 1. POST { action: 'start', test_id, category_id }
 *    - Verifies student caller via `verifyStudentCaller(req)`.
 *    - Calls `weekly_test_check(p_test, p_student, p_category)` with service role.
 *      When `ok` is false, returns 400 with `{ error: reason }`.
 *    - Inserts `weekly_test_attempts` (`test_id, student_id, category_id, status='started'`).
 *      If unique constraint fails, returns 400 `"You have already started this section."`.
 *    - Generates a question pool using `api/_drills.js` (`30 -> 50`, `60 -> 100`, `120 -> 200`, `300 -> 500`),
 *      inserts an open `drill_sessions` row (`activity_type='basics'`, `settings={ kind: 'weekly_test', test_id, category_id, seconds, pool }`,
 *      `expires_at = now + seconds + 60s`), and updates `weekly_test_attempts.session_id`.
 *    - If any step after the attempt insert fails, deletes that attempt row so the student can retry.
 *    - Returns `{ ok: true, session_id, title, category_name, seconds, questions }` (never expected answers).
 *
 * 2. POST { action: 'submit', session_id, answers }
 *    - Verifies student caller via `verifyStudentCaller(req)`.
 *    - Loads the student's open `drill_sessions` row where `settings.kind = 'weekly_test'`.
 *    - Rejects when expired or when `elapsed < attempted * 0.25`.
 *    - Evaluates answers with `checkTimedBasicsSubmission` (or zero-attempt handling when `answers.length === 0`).
 *    - Atomically marks `drill_sessions` as `'submitted'`.
 *    - When `attempted === 0`: sets `weekly_test_attempts` `status='submitted', finished_at=now()`, saves no score,
 *      and returns `{ ok: true, correct: 0, attempted: 0, accuracy: 0, used_seconds }`.
 *    - When `attempted > 0`: inserts into `weekly_test_scores` (`test_id, student_id, category_id, correct, total=attempted, time_seconds=round(used_seconds), source='online'`)
 *      and updates `weekly_test_attempts` `status='submitted', finished_at=now()`.
 *    - Never logs answers or tokens.
 */

import { getDrillServerClient, verifyStudentCaller } from './_supabaseAdmin.js';
import {
  BASICS_TIMED_POOLS,
  BASICS_TIMED_SECONDS,
  BASICS_TIMED_GRACE_SECONDS,
  parseBasicsCategoryName,
  generateBasicsSet,
  stripBasicsExpected,
  checkTimedBasicsSubmission,
} from './_drills.js';

function sendJson(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

async function readJsonBody(req) {
  if (req && req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (req && typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  return UUID_REGEX.test(trimmed) || /^[a-zA-Z0-9_-]{2,64}$/.test(trimmed);
}

/**
 * Handles `POST { action: 'start', test_id, category_id }`.
 */
export async function handleStartWeeklyTestSection({
  student,
  body,
  adminSupabase,
  now = new Date(),
}) {
  const testId = typeof body?.test_id === 'string' ? body.test_id.trim() : '';
  const categoryId = typeof body?.category_id === 'string' ? body.category_id.trim() : '';

  if (!isValidId(testId)) {
    return {
      statusCode: 400,
      payload: { error: 'A valid weekly test ID is required.' },
    };
  }

  if (!isValidId(categoryId)) {
    return {
      statusCode: 400,
      payload: { error: 'A valid basics category ID is required.' },
    };
  }

  // 1. Authoritative DB check via weekly_test_check(p_test, p_student, p_category)
  const { data: checkRaw, error: checkErr } = await adminSupabase.rpc('weekly_test_check', {
    p_test: testId,
    p_student: student.id,
    p_category: categoryId,
  });

  if (checkErr) {
    return {
      statusCode: 400,
      payload: { error: checkErr.message || 'Unable to verify weekly test section eligibility.' },
    };
  }

  const check = Array.isArray(checkRaw) ? checkRaw[0] : checkRaw;
  if (!check || check.ok !== true) {
    return {
      statusCode: 400,
      payload: { error: check?.reason || 'This weekly test section cannot be started right now.' },
    };
  }

  const seconds = Number(check.seconds);
  if (!BASICS_TIMED_SECONDS.includes(seconds)) {
    return {
      statusCode: 400,
      payload: { error: 'Invalid section duration configured for this test.' },
    };
  }

  const poolSize = BASICS_TIMED_POOLS[seconds];

  // 2. Load the basics category name
  const { data: category, error: catErr } = await adminSupabase
    .from('categories')
    .select('id, name, section, active')
    .eq('id', categoryId)
    .maybeSingle();

  if (catErr || !category) {
    return {
      statusCode: 404,
      payload: { error: 'Basics category not found.' },
    };
  }

  if (category.section !== 'basics') {
    return {
      statusCode: 400,
      payload: { error: 'Weekly test online sections only support Basics categories.' },
    };
  }

  const parsedSpec = parseBasicsCategoryName(category.name);
  if (!parsedSpec) {
    return {
      statusCode: 400,
      payload: { error: `Category "${category.name}" is not available online.` },
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(
    nowMs + (seconds + BASICS_TIMED_GRACE_SECONDS) * 1000
  ).toISOString();

  // 3. Insert weekly_test_attempts row (unique per test_id, student_id, category_id)
  const { data: attemptRow, error: attemptErr } = await adminSupabase
    .from('weekly_test_attempts')
    .insert({
      test_id: testId,
      student_id: student.id,
      category_id: categoryId,
      status: 'started',
      started_at: startedAtIso,
    })
    .select('id')
    .single();

  if (attemptErr || !attemptRow?.id) {
    const errCode = String(attemptErr?.code || '');
    const errMsg = String(attemptErr?.message || '').toLowerCase();
    if (errCode === '23505' || errMsg.includes('duplicate') || errMsg.includes('unique')) {
      return {
        statusCode: 400,
        payload: { error: 'You have already started this section.' },
      };
    }
    return {
      statusCode: 400,
      payload: { error: attemptErr?.message || 'Could not start this test section.' },
    };
  }

  // Helper to roll back the attempt row if anything after it fails
  const rollbackAttempt = async () => {
    try {
      await adminSupabase.from('weekly_test_attempts').delete().eq('id', attemptRow.id);
    } catch {
      // Best-effort cleanup
    }
  };

  try {
    // 4. Generate Basics question pool on the server
    const generated = generateBasicsSet(category.name, poolSize);
    const displayQuestions = stripBasicsExpected(generated);
    const expectedAnswers = generated.map((q) => q.expected);

    const sessionSettings = {
      kind: 'weekly_test',
      mode: 'timed',
      test_id: testId,
      category_id: categoryId,
      category_name: category.name,
      title: check.title || 'Weekly Test',
      seconds,
      pool: poolSize,
    };

    // 5. Insert open drill_sessions row
    const { data: sessionRow, error: sessionErr } = await adminSupabase
      .from('drill_sessions')
      .insert({
        student_id: student.id,
        activity_type: 'basics',
        activity_name: category.name,
        settings: sessionSettings,
        questions: displayQuestions,
        expected: expectedAnswers,
        min_seconds: 1,
        started_at: startedAtIso,
        expires_at: expiresAtIso,
        status: 'open',
      })
      .select('id')
      .single();

    if (sessionErr || !sessionRow?.id) {
      await rollbackAttempt();
      return {
        statusCode: 500,
        payload: { error: 'Failed to create weekly test session. Please try again.' },
      };
    }

    // 6. Link session_id on weekly_test_attempts
    const { error: linkErr } = await adminSupabase
      .from('weekly_test_attempts')
      .update({ session_id: sessionRow.id })
      .eq('id', attemptRow.id);

    if (linkErr) {
      await adminSupabase.from('drill_sessions').delete().eq('id', sessionRow.id);
      await rollbackAttempt();
      return {
        statusCode: 500,
        payload: { error: 'Failed to link weekly test session. Please try again.' },
      };
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        session_id: sessionRow.id,
        title: check.title || 'Weekly Test',
        category_name: category.name,
        seconds,
        questions: displayQuestions,
      },
    };
  } catch {
    await rollbackAttempt();
    return {
      statusCode: 500,
      payload: { error: 'Failed to start weekly test section. Please try again.' },
    };
  }
}

/**
 * Handles `POST { action: 'submit', session_id, answers }`.
 */
export async function handleSubmitWeeklyTestSection({
  student,
  body,
  adminSupabase,
  now = new Date(),
}) {
  const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
  const answers = body?.answers;

  if (!isValidId(sessionId)) {
    return {
      statusCode: 400,
      payload: { error: 'A valid session_id is required.' },
    };
  }

  if (!Array.isArray(answers)) {
    return {
      statusCode: 400,
      payload: { error: 'Answers must be provided as a list.' },
    };
  }

  // 1. Load student's own drill_sessions row
  const { data: sessionRow, error: loadErr } = await adminSupabase
    .from('drill_sessions')
    .select(
      'id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, expires_at, status'
    )
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .maybeSingle();

  if (loadErr || !sessionRow) {
    return {
      statusCode: 404,
      payload: { error: 'Weekly test session not found.' },
    };
  }

  const settings =
    sessionRow.settings && typeof sessionRow.settings === 'object' ? sessionRow.settings : {};

  if (settings.kind !== 'weekly_test') {
    return {
      statusCode: 400,
      payload: { error: 'This session is not a weekly test section.' },
    };
  }

  if (sessionRow.status && sessionRow.status !== 'open') {
    return {
      statusCode: 400,
      payload: { error: 'This weekly test section has already been submitted.' },
    };
  }

  const testId = settings.test_id;
  const categoryId = settings.category_id;
  const sectionSeconds = Number(settings.seconds) || 60;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowIso = new Date(nowMs).toISOString();

  // Check expiration
  if (sessionRow.expires_at !== undefined && sessionRow.expires_at !== null) {
    const expiresMs = new Date(sessionRow.expires_at).getTime();
    if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
      return {
        statusCode: 400,
        payload: { error: 'Time is up for this test section.' },
      };
    }
  }

  const startedMs = new Date(sessionRow.started_at).getTime();
  const elapsedSeconds = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 1000) : 0;

  let correct = 0;
  let attempted = answers.length;
  let accuracy = 0;
  let usedSeconds = Math.max(1, Math.round(Math.min(elapsedSeconds, sectionSeconds)));

  if (attempted > 0) {
    const checkResult = checkTimedBasicsSubmission(
      {
        ...sessionRow,
        mode: 'timed',
        seconds: sectionSeconds,
      },
      answers,
      nowMs
    );

    if (!checkResult.ok) {
      return {
        statusCode: checkResult.statusCode || 400,
        payload: { error: checkResult.error },
      };
    }

    correct = checkResult.correct;
    attempted = checkResult.attempted;
    accuracy = checkResult.accuracy;
    usedSeconds = checkResult.used_seconds;
  }

  // 2. Atomically claim the open drill_sessions row (`status = 'open' -> 'submitted'`)
  const { data: claimedRows, error: claimErr } = await adminSupabase
    .from('drill_sessions')
    .update({ status: 'submitted' })
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .eq('status', 'open')
    .select('id');

  if (claimErr) {
    return {
      statusCode: 500,
      payload: { error: 'Failed to record weekly test submission.' },
    };
  }

  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    return {
      statusCode: 400,
      payload: { error: 'This weekly test section has already been submitted.' },
    };
  }

  // 3. When attempted === 0: mark attempt submitted, save no score
  if (attempted === 0) {
    await adminSupabase
      .from('weekly_test_attempts')
      .update({
        status: 'submitted',
        finished_at: nowIso,
      })
      .eq('test_id', testId)
      .eq('student_id', student.id)
      .eq('category_id', categoryId);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        correct: 0,
        attempted: 0,
        accuracy: 0,
        used_seconds: usedSeconds,
      },
    };
  }

  // 4. Otherwise insert score into weekly_test_scores and mark weekly_test_attempts submitted
  const { error: scoreErr } = await adminSupabase.from('weekly_test_scores').upsert(
    {
      test_id: testId,
      student_id: student.id,
      category_id: categoryId,
      correct,
      total: attempted,
      time_seconds: Math.round(usedSeconds),
      source: 'online',
    },
    { onConflict: 'test_id,student_id,category_id' }
  );

  if (scoreErr) {
    // Re-open session so the student can retry submitting
    await adminSupabase
      .from('drill_sessions')
      .update({ status: 'open' })
      .eq('id', sessionId)
      .eq('student_id', student.id);

    return {
      statusCode: 500,
      payload: { error: scoreErr.message || 'Failed to save weekly test score. Please try sending again.' },
    };
  }

  await adminSupabase
    .from('weekly_test_attempts')
    .update({
      status: 'submitted',
      finished_at: nowIso,
    })
    .eq('test_id', testId)
    .eq('student_id', student.id)
    .eq('category_id', categoryId);

  return {
    statusCode: 200,
    payload: {
      ok: true,
      correct,
      attempted,
      accuracy,
      used_seconds: usedSeconds,
    },
  };
}

/**
 * Main Vercel serverless handler for `/api/weekly-test`.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method Not Allowed. Use POST.' });
  }

  let student;
  try {
    student = await verifyStudentCaller(req);
  } catch (authErr) {
    const code = authErr.statusCode || 401;
    return sendJson(res, code, {
      error: authErr.message || 'Please sign in as an active student to continue.',
    });
  }

  let adminSupabase;
  try {
    adminSupabase = getDrillServerClient(student);
  } catch {
    return sendJson(res, 500, {
      error: 'Server configuration error: SUPABASE_SERVICE_ROLE_KEY is missing.',
    });
  }

  const body = await readJsonBody(req);
  const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';

  if (action === 'start') {
    const result = await handleStartWeeklyTestSection({
      student,
      body,
      adminSupabase,
    });
    return sendJson(res, result.statusCode, result.payload);
  }

  if (action === 'submit') {
    const result = await handleSubmitWeeklyTestSection({
      student,
      body,
      adminSupabase,
    });
    return sendJson(res, result.statusCode, result.payload);
  }

  return sendJson(res, 400, {
    error: 'Invalid action. Supported actions are "start" and "submit".',
  });
}
