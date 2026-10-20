/**
 * Vercel Serverless Function: POST /api/memoriad
 *
 * Server-authoritative Memoriad competition practice endpoint:
 * - Authenticates active students via `verifyStudentCaller(req)`
 * - Rate-limits `start` to at most 60 sessions per hour per student
 * - `start`: validates module & settings, generates questions & expected answers,
 *   stores session in `public.drill_sessions` (`activity_type = 'memoriad'`),
 *   and returns display questions ONLY (never `expected`).
 * - `submit`: loads student's own open session, checks 3-hour expiry, computes
 *   `used_seconds = max(0, (now - started_at) - concentration_seconds)`, checks
 *   plausibility, atomically claims the session (`status = 'open' -> 'submitted'`),
 *   saves non-zero attempts to `public.activity_results` via the service role,
 *   and returns the evaluation + `used_seconds` rounded to 2 decimal places.
 * - Never logs answers, expected answers, or auth tokens.
 */

import { getDrillServerClient, verifyStudentCaller } from './_supabaseAdmin.js';
import {
  MODULES,
  validateMemoriadSettings,
  generateMemoriadSet,
  buildMemoriadStartResponse,
  evaluateMemoriadSubmission,
  computeMemoriadExpiresAtMs,
  computeMemoriadUsedSeconds,
  validateFinishedBy,
} from './_memoriad.js';

const RATE_LIMIT_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  let student;
  try {
    student = await verifyStudentCaller(req);
  } catch (authErr) {
    const code = authErr?.statusCode || 401;
    return res.status(code).json({
      error: authErr?.message || 'Please sign in as an active student to continue.',
    });
  }

  let adminClient;
  try {
    adminClient = getDrillServerClient(student);
  } catch {
    return res.status(500).json({
      error: 'Server database configuration is missing. Please contact your teacher.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';

  try {
    if (action === 'start') {
      return await handleStart(body, student, adminClient, res);
    }
    if (action === 'submit') {
      return await handleSubmit(body, student, adminClient, res);
    }
    return res.status(400).json({
      error: 'Invalid action. Expected "start" or "submit".',
    });
  } catch {
    return res.status(500).json({
      error: 'An unexpected server error occurred. Please try again.',
    });
  }
}

async function handleStart(body, student, adminClient, res) {
  const moduleKey = typeof body.module === 'string' ? body.module.trim().toLowerCase() : '';
  const validation = validateMemoriadSettings(moduleKey, body.settings);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  // Rate limit: at most 60 starts per hour per student
  const oneHourAgoIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count: recentCount, error: countError } = await adminClient
    .from('drill_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', student.id)
    .eq('activity_type', 'memoriad')
    .gte('started_at', oneHourAgoIso);

  if (countError) {
    return res.status(500).json({
      error: 'Could not verify practice rate limit. Please try again.',
    });
  }

  if ((recentCount || 0) >= RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({
      error: 'You have started 60 practice sets in the last hour. Please take a short break and try again soon.',
    });
  }

  const generated = generateMemoriadSet(moduleKey, validation.settings);
  const nowMs = Date.now();
  const startedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(
    computeMemoriadExpiresAtMs(
      nowMs,
      generated.settings.concentration_seconds,
      generated.module
    )
  ).toISOString();

  const sessionSettings = {
    module: generated.module,
    ...generated.settings,
  };

  const { data: sessionRow, error: insertError } = await adminClient
    .from('drill_sessions')
    .insert({
      student_id: student.id,
      activity_type: 'memoriad',
      activity_name: generated.title,
      settings: sessionSettings,
      questions: generated.questions,
      expected: generated.expected,
      min_seconds: 1,
      started_at: startedAtIso,
      expires_at: expiresAtIso,
      status: 'open',
    })
    .select('id')
    .single();

  if (insertError || !sessionRow) {
    return res.status(500).json({
      error: 'Could not start the competition practice session. Please try again.',
    });
  }

  return res.status(200).json(
    buildMemoriadStartResponse({
      session_id: sessionRow.id,
      module: generated.module,
      title: generated.title,
      questions: generated.questions,
      settings: generated.settings,
    })
  );
}

async function handleSubmit(body, student, adminClient, res) {
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  const rawAnswers = body.answers;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing session_id.' });
  }
  if (!Array.isArray(rawAnswers)) {
    return res.status(400).json({ error: 'Answers must be provided as an array.' });
  }
  const finishedCheck = validateFinishedBy(body.finished_by);
  if (!finishedCheck.ok) {
    return res.status(400).json({ error: finishedCheck.error });
  }
  const finishedBy = finishedCheck.finishedBy;

  // Load the student's own session
  const { data: session, error: sessionErr } = await adminClient
    .from('drill_sessions')
    .select(
      'id, student_id, activity_type, activity_name, settings, questions, expected, started_at, expires_at, status'
    )
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .eq('activity_type', 'memoriad')
    .maybeSingle();

  if (sessionErr || !session) {
    return res.status(404).json({
      error: 'Practice session not found.',
    });
  }

  if (session.status !== 'open') {
    return res.status(409).json({
      error: 'This practice session has already been submitted.',
    });
  }

  const nowMs = Date.now();
  const expiresAtMs = new Date(session.expires_at).getTime();
  if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs) {
    await adminClient
      .from('drill_sessions')
      .update({ status: 'expired' })
      .eq('id', session.id)
      .eq('status', 'open');

    return res.status(410).json({
      error: 'Time is up — this practice session has expired. Please start a new try.',
    });
  }

  const moduleKey =
    session.settings?.module ||
    (session.activity_name === MODULES.calendar.title
      ? 'calendar'
      : session.activity_name === MODULES.multiplications.title
        ? 'multiplications'
        : session.activity_name === MODULES.square_roots.title
          ? 'square_roots'
          : 'additions');

  const startedAtMs = new Date(session.started_at).getTime();
  const concentrationSeconds = Number(session.settings?.concentration_seconds) || 0;
  const usedSeconds = computeMemoriadUsedSeconds(
    startedAtMs,
    nowMs,
    concentrationSeconds,
    moduleKey
  );

  const evalResult = evaluateMemoriadSubmission(
    {
      module: moduleKey,
      questions: session.questions,
      expected: session.expected,
      settings: session.settings,
    },
    rawAnswers,
    usedSeconds
  );

  if (!evalResult.ok) {
    return res.status(400).json({ error: evalResult.error });
  }

  const { evaluation } = evalResult;
  const submittedAtIso = new Date(nowMs).toISOString();

  // Claim the session atomically (update only where status is 'open')
  const { data: claimedRows, error: claimErr } = await adminClient
    .from('drill_sessions')
    .update({
      status: 'submitted',
      submitted_at: submittedAtIso,
    })
    .eq('id', session.id)
    .eq('student_id', student.id)
    .eq('status', 'open')
    .select('id');

  if (claimErr || !Array.isArray(claimedRows) || claimedRows.length === 0) {
    return res.status(409).json({
      error: 'This practice session has already been submitted.',
    });
  }

  // If attempted is 0, save nothing in activity_results and inform the student
  if (evaluation.attempted === 0) {
    return res.status(200).json({
      ...evaluation,
      used_seconds: usedSeconds,
      finished_by: finishedBy,
      saved: false,
      result_id: null,
      message: 'No questions were attempted, so no score was saved.',
    });
  }

  const resultSettings = {
    module: moduleKey,
    questions: evaluation.questions_total,
    attempted: evaluation.attempted,
    correct: evaluation.correct,
    wrong: evaluation.wrong,
    score: evaluation.score,
    used_seconds: usedSeconds,
    concentration_seconds: concentrationSeconds,
    finished_by: finishedBy,
  };
  if (moduleKey === 'calendar') {
    resultSettings.dates = Number(session.settings?.dates) || evaluation.questions_total;
  }
  if (moduleKey === 'square_roots') {
    resultSettings.digits_total = Number(evaluation.digits_total) || 0;
  }

  const { data: resultRow, error: resultErr } = await adminClient
    .from('activity_results')
    .insert({
      student_id: student.id,
      activity_type: 'memoriad',
      activity_name: evaluation.title,
      correct: evaluation.correct,
      total: evaluation.attempted,
      time_seconds: Math.round(usedSeconds),
      settings: resultSettings,
    })
    .select('id')
    .single();

  if (resultErr || !resultRow) {
    // Reopen session so a transient DB error lets the student retry
    await adminClient
      .from('drill_sessions')
      .update({ status: 'open', submitted_at: null })
      .eq('id', session.id);

    return res.status(500).json({
      error: 'Could not save your competition practice result. Please try submitting again.',
    });
  }

  await adminClient
    .from('drill_sessions')
    .update({ result_id: resultRow.id })
    .eq('id', session.id);

  return res.status(200).json({
    ...evaluation,
    used_seconds: usedSeconds,
    finished_by: finishedBy,
    saved: true,
    result_id: resultRow.id,
    activity_row: {
      id: resultRow.id,
      student_id: student.id,
      activity_type: 'memoriad',
      activity_name: evaluation.title,
      correct: evaluation.correct,
      total: evaluation.attempted,
      time_seconds: Math.round(usedSeconds),
      settings: resultSettings,
      created_at: submittedAtIso,
    },
    message: 'Saved to your scores.',
  });
}
