/**
 * Trendz Tracker — Elements Drill Serverless API (api/drill.js)
 *
 * Endpoints (POST /api/drill):
 * - { action: 'start', drill }
 *   Verifies active student caller, enforces 60 sets/hour rate limit on
 *   drill_sessions (activity_type = 'element'), generates questions & canonical
 *   expected answers on the server, stores them in drill_sessions using the
 *   service role, and returns ONLY { session_id, drill, title, questions, time_limit_seconds, hint }.
 *
 * - { action: 'submit', session_id, answers }
 *   Verifies active student caller, loads the student's open session, checks
 *   expiry (started_at + time_limit_seconds + 30s) and minimum plausible completion
 *   time (attempted * 0.25s), atomically claims the session (status 'open' -> 'submitted'),
 *   inserts the result into activity_results with the service role (reopening the
 *   session if insert fails), and returns { correct, attempted, questions_total, accuracy, seconds, detail }.
 *
 * SECURITY INVARIANTS:
 * - Never logs or returns expected answers on 'start'.
 * - Never logs answers, tokens, or keys.
 */

import { getAdminClient, verifyStudentCaller } from './_supabaseAdmin.js';
import {
  DRILLS,
  buildDrillStartResponse,
  gradeDrillSubmission,
} from './_drills.js';

export const RATE_LIMIT_SETS_PER_HOUR = 60;
export const EXPIRY_GRACE_SECONDS = 30;
export const MIN_SECONDS_PER_ATTEMPT = 0.25;
export const MAX_ANSWER_LENGTH = 40;

/**
 * Pure validation helper for the `answers` payload on submit.
 *
 * @param {unknown} answers
 * @param {number} expectedCount
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateSubmittedAnswersArray(answers, expectedCount) {
  if (!Array.isArray(answers)) {
    return { ok: false, error: 'Answers must be provided as a list.' };
  }
  if (answers.length !== expectedCount) {
    return {
      ok: false,
      error: `Expected ${expectedCount} answers, but received ${answers.length}.`,
    };
  }
  for (let i = 0; i < answers.length; i++) {
    const item = answers[i];
    if (item === null) continue;
    if (typeof item !== 'string') {
      return {
        ok: false,
        error: `Answer for question ${i + 1} must be text or blank.`,
      };
    }
    if (item.length > MAX_ANSWER_LENGTH) {
      return {
        ok: false,
        error: `Answer for question ${i + 1} is too long (maximum ${MAX_ANSWER_LENGTH} characters).`,
      };
    }
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let student;
  try {
    student = await verifyStudentCaller(req);
  } catch (authErr) {
    const code = authErr.statusCode || 401;
    return res.status(code).json({
      error: authErr.message || 'Please sign in as an active student to continue.',
    });
  }

  let adminSupabase;
  try {
    adminSupabase = getAdminClient();
  } catch {
    return res.status(500).json({
      error: 'Server database configuration is missing. Please contact your teacher.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '').trim();

  if (action === 'start') {
    return handleStartDrill({ body, student, adminSupabase, res });
  }

  if (action === 'submit') {
    return handleSubmitDrill({ body, student, adminSupabase, res });
  }

  return res.status(400).json({ error: 'Invalid action. Use "start" or "submit".' });
}

async function handleStartDrill({ body, student, adminSupabase, res }) {
  const drillKey = String(body.drill || '').trim();
  const drillObj = DRILLS[drillKey];

  if (!drillObj) {
    return res.status(400).json({ error: 'Unknown drill selected.' });
  }

  if (!drillObj.enabled) {
    return res.status(400).json({
      error: 'This drill is coming soon and is not enabled yet.',
    });
  }

  // Rate limit: max 60 started sets per hour per student (activity_type = 'element')
  const oneHourAgoIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count: recentCount, error: countErr } = await adminSupabase
    .from('drill_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', student.id)
    .eq('activity_type', 'element')
    .gte('started_at', oneHourAgoIso);

  if (countErr) {
    return res.status(500).json({
      error: 'Could not check your recent practice sessions. Please try again.',
    });
  }

  if ((recentCount || 0) >= RATE_LIMIT_SETS_PER_HOUR) {
    return res.status(429).json({
      error: 'You have started 60 sets in the past hour. Please take a short break and try again soon.',
    });
  }

  // Generate questions and canonical expected answers on the server
  const generated = drillObj.generate();
  const questionTexts = generated.map((q) => q.text);
  const expectedAnswers = generated.map((q) => q.expected);

  const nowMs = Date.now();
  const startedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(
    nowMs + (drillObj.time_limit_seconds + EXPIRY_GRACE_SECONDS) * 1000
  ).toISOString();

  const { data: sessionRow, error: insertErr } = await adminSupabase
    .from('drill_sessions')
    .insert({
      student_id: student.id,
      activity_type: 'element',
      activity_name: drillObj.title,
      settings: {
        drill: drillKey,
        questions: drillObj.questions,
        time_limit_seconds: drillObj.time_limit_seconds,
      },
      questions: questionTexts,
      expected: expectedAnswers,
      min_seconds: 1,
      started_at: startedAtIso,
      expires_at: expiresAtIso,
      status: 'open',
    })
    .select('id')
    .single();

  if (insertErr || !sessionRow) {
    return res.status(500).json({
      error: 'Could not start the drill session. Please try again.',
    });
  }

  const safeResponse = buildDrillStartResponse({
    sessionId: sessionRow.id,
    drillKey,
    drill: drillObj,
    generated,
  });

  return res.status(200).json(safeResponse);
}

async function handleSubmitDrill({ body, student, adminSupabase, res }) {
  const sessionId = String(body.session_id || '').trim();
  const answers = body.answers;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing drill session ID.' });
  }

  // Load the student's own session
  const { data: session, error: sessionErr } = await adminSupabase
    .from('drill_sessions')
    .select(
      'id, student_id, activity_type, activity_name, settings, questions, expected, started_at, expires_at, status'
    )
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .eq('activity_type', 'element')
    .single();

  if (sessionErr || !session) {
    return res.status(404).json({
      error: 'Drill session not found. Please start a new set.',
    });
  }

  if (session.status !== 'open') {
    return res.status(400).json({
      error: 'already submitted',
    });
  }

  const drillKey = session.settings?.drill;
  const drillObj = DRILLS[drillKey];
  if (!drillObj) {
    return res.status(400).json({
      error: 'This drill session references an unknown drill.',
    });
  }

  const questions = Array.isArray(session.questions) ? session.questions : [];
  const expected = Array.isArray(session.expected) ? session.expected : [];

  const validation = validateSubmittedAnswersArray(answers, questions.length);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const nowMs = Date.now();
  const expiresMs = new Date(session.expires_at).getTime();
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    return res.status(400).json({
      error: 'Time is up, please start a new set',
    });
  }

  const startedMs = new Date(session.started_at).getTime();
  const elapsedSeconds = Number.isFinite(startedMs)
    ? Math.max(0, (nowMs - startedMs) / 1000)
    : drillObj.time_limit_seconds;

  const timeLimitSeconds =
    Number(session.settings?.time_limit_seconds) || drillObj.time_limit_seconds;

  const graded = gradeDrillSubmission({
    drillKey,
    questions,
    expected,
    answers,
    elapsedSeconds,
    timeLimitSeconds,
  });

  // Reject a set where attempted > 0 and elapsed < attempted * 0.25 seconds
  if (graded.attempted > 0 && elapsedSeconds < graded.attempted * MIN_SECONDS_PER_ATTEMPT) {
    return res.status(400).json({
      error: 'finished faster than possible, not saved',
    });
  }

  // If attempted is 0, save nothing and say so
  if (graded.attempted === 0) {
    return res.status(400).json({
      error: 'No questions were attempted, so nothing was saved.',
    });
  }

  // Claim the session atomically (update only where status is 'open')
  const nowIso = new Date(nowMs).toISOString();
  const { data: claimedRows, error: claimErr } = await adminSupabase
    .from('drill_sessions')
    .update({
      status: 'submitted',
      submitted_at: nowIso,
    })
    .eq('id', session.id)
    .eq('student_id', student.id)
    .eq('status', 'open')
    .select('id');

  if (claimErr || !claimedRows || claimedRows.length === 0) {
    return res.status(400).json({
      error: 'already submitted',
    });
  }

  // Insert into activity_results with the service role
  const { data: insertedResult, error: insertErr } = await adminSupabase
    .from('activity_results')
    .insert({
      student_id: student.id,
      activity_type: 'element',
      activity_name: drillObj.title,
      correct: graded.correct,
      total: graded.attempted,
      time_seconds: graded.seconds,
      settings: {
        drill: drillKey,
        questions: questions.length,
        time_limit_seconds: timeLimitSeconds,
        attempted: graded.attempted,
        session_id: session.id,
      },
    })
    .select('id')
    .single();

  if (insertErr || !insertedResult) {
    // Reopen the session if the insert fails
    await adminSupabase
      .from('drill_sessions')
      .update({
        status: 'open',
        submitted_at: null,
      })
      .eq('id', session.id);

    return res.status(500).json({
      error: 'Could not save your drill results. Please try sending again.',
    });
  }

  // Link result_id on drill_sessions (best-effort)
  await adminSupabase
    .from('drill_sessions')
    .update({ result_id: insertedResult.id })
    .eq('id', session.id);

  return res.status(200).json(graded);
}
