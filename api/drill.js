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

import { getDrillServerClient, verifyStudentCaller } from './_supabaseAdmin.js';
import {
  DRILLS,
  buildDrillStartResponse,
  gradeDrillSubmission,
  parseBasicsCategoryName,
  generateBasicsSet,
  stripBasicsExpected,
  resolveBasicsModeSpec,
  checkTimedBasicsSubmission,
  checkSubmission,
} from './_drills.js';

export const RATE_LIMIT_SETS_PER_HOUR = 60;
export const EXPIRY_GRACE_SECONDS = 30;
export const MIN_SECONDS_PER_ATTEMPT = 0.25;
export const MAX_ANSWER_LENGTH = 40;

/**
 * Pure validation helper for the `answers` payload on Elements submit.
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

/**
 * Fallback IST YYYY-MM-DD formatter if today_ist() RPC is unavailable.
 */
function fallbackTodayIst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
    adminSupabase = getDrillServerClient(student);
  } catch {
    return res.status(500).json({
      error: 'Server database configuration is missing. Please contact your teacher.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '').trim();

  if (action === 'start') {
    if (String(body.kind || '').trim() === 'basics') {
      return handleStartBasicsDrill({ body, student, adminSupabase, res });
    }
    return handleStartDrill({ body, student, adminSupabase, res });
  }

  if (action === 'submit') {
    return handleSubmitDrill({ body, student, adminSupabase, res });
  }

  if (action === 'task_leaderboard') {
    return handleTaskLeaderboard({ body, student, adminSupabase, res });
  }

  return res.status(400).json({ error: 'Invalid action. Use "start" or "submit".' });
}

async function handleStartBasicsDrill({ body, student, adminSupabase, res }) {
  const categoryId = String(body.category_id || '').trim();
  if (!categoryId) {
    return res.status(400).json({ error: 'Please select a basics category.' });
  }

  const modeSpec = resolveBasicsModeSpec(body.mode, body.seconds);
  if (!modeSpec.ok) {
    return res.status(400).json({ error: modeSpec.error });
  }

  // Validate category: section === 'basics', active === true, supported name
  const { data: category, error: catErr } = await adminSupabase
    .from('categories')
    .select('id, name, section, active')
    .eq('id', categoryId)
    .single();

  if (catErr || !category) {
    return res.status(404).json({ error: 'Basics category not found.' });
  }

  if (category.section !== 'basics' || category.active === false) {
    return res.status(400).json({
      error: 'This category is not available for online practice.',
    });
  }

  const spec = parseBasicsCategoryName(category.name);
  if (!spec) {
    return res.status(400).json({
      error: 'This category is not available online and uses typed entry only.',
    });
  }

  // Rate limit: 60 starts per hour per student (activity_type = 'basics')
  const oneHourAgoIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count: recentCount, error: countErr } = await adminSupabase
    .from('drill_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', student.id)
    .eq('activity_type', 'basics')
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

  // Generate the entire question pool and expected answers on the server
  const generated = generateBasicsSet(category.name, modeSpec.pool);
  const displayQuestions = stripBasicsExpected(generated);
  const expectedAnswers = generated.map((q) => q.expected);

  const nowMs = Date.now();
  const startedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + modeSpec.expirySeconds * 1000).toISOString();

  const { data: sessionRow, error: insertErr } = await adminSupabase
    .from('drill_sessions')
    .insert({
      student_id: student.id,
      activity_type: 'basics',
      activity_name: category.name,
      settings: {
        kind: 'basics',
        category_id: category.id,
        mode: modeSpec.mode,
        seconds: modeSpec.seconds,
        pool: modeSpec.pool,
      },
      questions: displayQuestions,
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
      error: 'Could not start the basics practice session. Please try again.',
    });
  }

  // Look up target from basics_thresholds for the student's level (or default)
  let target = null;
  try {
    const { data: thresholds } = await adminSupabase
      .from('basics_thresholds')
      .select('category_id, level, min_accuracy, min_questions_per_minute, active')
      .eq('category_id', category.id)
      .eq('active', true);

    if (Array.isArray(thresholds) && thresholds.length > 0) {
      const studentLevel = String(student.level || '').trim().toLowerCase();
      let matched = null;
      if (studentLevel) {
        matched = thresholds.find(
          (t) => t.level && String(t.level).trim().toLowerCase() === studentLevel
        );
      }
      if (!matched) {
        matched = thresholds.find((t) => !t.level || !String(t.level).trim());
      }
      if (matched) {
        target = {
          min_accuracy:
            matched.min_accuracy !== null && matched.min_accuracy !== undefined
              ? Number(matched.min_accuracy)
              : null,
          min_questions_per_minute:
            matched.min_questions_per_minute !== null &&
            matched.min_questions_per_minute !== undefined
              ? Number(matched.min_questions_per_minute)
              : null,
        };
      }
    }
  } catch {
    // Non-fatal: target stays null
  }

  return res.status(200).json({
    session_id: sessionRow.id,
    title: category.name,
    questions: displayQuestions,
    mode: modeSpec.mode,
    seconds: modeSpec.seconds,
    pool: modeSpec.pool,
    target,
  });
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

  // Load the student's own session (supports both 'element' and 'basics')
  const { data: session, error: sessionErr } = await adminSupabase
    .from('drill_sessions')
    .select(
      'id, student_id, activity_type, activity_name, settings, questions, expected, started_at, expires_at, status'
    )
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .single();

  if (sessionErr || !session) {
    return res.status(404).json({
      error: 'Drill session not found. Please start a new set.',
    });
  }

  if (session.activity_type === 'basics') {
    return handleSubmitBasicsSession({ session, answers, student, adminSupabase, res });
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

async function handleSubmitBasicsSession({
  session,
  answers,
  student,
  adminSupabase,
  res,
}) {
  const nowMs = Date.now();
  const check = checkTimedBasicsSubmission(session, answers, nowMs);

  if (!check.ok) {
    return res.status(check.statusCode || 400).json({
      error: check.error,
    });
  }

  const categoryId = session.settings?.category_id;
  if (!categoryId) {
    return res.status(400).json({
      error: 'Session is missing a basics category reference.',
    });
  }

  const practiceMode =
    session.settings?.mode === 'unlimited' || session.mode === 'unlimited'
      ? 'unlimited'
      : 'timed';

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

  // Obtain today in India time via database RPC today_ist()
  let entryDate = fallbackTodayIst();
  try {
    const { data: istDate, error: rpcErr } = await adminSupabase.rpc('today_ist');
    if (!rpcErr && istDate) {
      entryDate = String(istDate).trim();
    }
  } catch {
    // Keep fallbackTodayIst()
  }

  // Insert into results with the service role:
  // student_id, category_id, correct, total = attempted, time_seconds = round(used_seconds),
  // entry_date = today in India time, verified: true, source: 'site', practice_mode: mode
  const { data: insertedResult, error: insertErr } = await adminSupabase
    .from('results')
    .insert({
      student_id: student.id,
      category_id: categoryId,
      correct: check.correct,
      total: check.attempted,
      time_seconds: check.time_seconds,
      entry_date: entryDate,
      verified: true,
      source: 'site',
      practice_mode: practiceMode,
      verified_by: null,
      student_round_id: null,
    })
    .select('id')
    .single();

  if (insertErr || !insertedResult) {
    // Reopen session if insert fails
    await adminSupabase
      .from('drill_sessions')
      .update({
        status: 'open',
        submitted_at: null,
      })
      .eq('id', session.id);

    return res.status(500).json({
      error: 'Could not save your basics practice score. Please try sending again.',
    });
  }

  // Update the session with status and result_row_id
  await adminSupabase
    .from('drill_sessions')
    .update({
      status: 'submitted',
      result_row_id: insertedResult.id,
    })
    .eq('id', session.id);

  return res.status(200).json({
    correct: check.correct,
    attempted: check.attempted,
    accuracy: check.accuracy,
    used_seconds: check.used_seconds,
    correct_per_minute: check.correct_per_minute,
    attempted_per_minute: check.attempted_per_minute,
    detail: check.detail,
    result_id: insertedResult.id,
  });
}

function toIstDateStr(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function addDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function resolveIstPeriodBounds(periodRaw, todayIst) {
  const clean = String(periodRaw || 'week').trim().toLowerCase();
  if (clean === 'all') {
    return { startDate: '2020-01-01', endDate: todayIst };
  }
  if (clean === 'today') {
    return { startDate: todayIst, endDate: todayIst };
  }
  if (clean === 'yesterday') {
    const yest = addDaysYmd(todayIst, -1);
    return { startDate: yest, endDate: yest };
  }
  if (clean === 'week') {
    const [y, m, d] = todayIst.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay(); // 0 = Sun, 1 = Mon ...
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const mon = addDaysYmd(todayIst, diffToMonday);
    return { startDate: mon, endDate: todayIst };
  }
  if (clean === 'month') {
    return { startDate: `${todayIst.slice(0, 7)}-01`, endDate: todayIst };
  }
  if (clean === 'year') {
    return { startDate: `${todayIst.slice(0, 4)}-01-01`, endDate: todayIst };
  }
  if (clean.startsWith('date:')) {
    const datePart = clean.slice(5).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      throw new Error('Invalid date format.');
    }
    if (datePart < '2020-01-01') {
      throw new Error('The date cannot be before 2020-01-01.');
    }
    if (datePart > todayIst) {
      throw new Error('The date cannot be in the future.');
    }
    return { startDate: datePart, endDate: datePart };
  }
  return { startDate: '2020-01-01', endDate: todayIst };
}

function formatLeaderboardDisplayName(profile, nameMode) {
  const code = String(profile?.student_code || 'TRAINEE').trim();
  if (nameMode === 'student_code') {
    return code;
  }
  const fullName = String(profile?.full_name || '').trim();
  if (!fullName) return code;
  if (nameMode === 'full_name') {
    return fullName;
  }
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

async function handleTaskLeaderboard({ body, student, adminSupabase, res }) {
  const taskId = String(body.task_id || '').trim();
  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required.' });
  }

  const period = String(body.period || 'week').trim();
  const scope = String(body.scope || 'level').trim().toLowerCase() === 'global' ? 'global' : 'level';
  const requestedLevel = body.level ? String(body.level).trim() : null;
  const rawLimit = Number(body.limit) || 10;
  const isAdmin = student.role === 'admin';

  // Check global leaderboard switch when a student requests global scope
  if (!isAdmin && scope === 'global') {
    try {
      const { data: globalEnabled } = await adminSupabase.rpc('global_leaderboard_enabled');
      const enabled = Array.isArray(globalEnabled) ? Boolean(globalEnabled[0]) : Boolean(globalEnabled);
      if (!enabled) {
        return res.status(400).json({ error: 'The global leaderboard is switched off.' });
      }
    } catch {
      // Allow if RPC check fails
    }
  }

  let todayIst = fallbackTodayIst();
  try {
    const { data: istDate, error: rpcErr } = await adminSupabase.rpc('today_ist');
    if (!rpcErr && istDate) {
      todayIst = String(istDate).trim();
    }
  } catch {
    // Keep fallbackTodayIst()
  }

  let bounds;
  try {
    bounds = resolveIstPeriodBounds(period, todayIst);
  } catch (boundErr) {
    return res.status(400).json({ error: boundErr.message || 'Invalid period.' });
  }

  const { data: task, error: taskErr } = await adminSupabase
    .from('daily_tasks')
    .select('id, title, section, category_id, activity_key, flash_digits, flash_count, flash_speed_ms, flash_mode, level, active')
    .eq('id', taskId)
    .single();

  if (taskErr || !task) {
    return res.status(404).json({ error: 'Daily task not found.' });
  }

  const section = String(task.section || '').trim().toLowerCase();
  if (section !== 'elements' && section !== 'flash') {
    return res.status(400).json({
      error: 'Speed ranking is available for basics, elements, and flash tasks only.',
    });
  }

  // Fetch competition rules for display name mode
  let nameMode = 'first_name_initial';
  try {
    const { data: rulesData } = await adminSupabase.rpc('competition_rules');
    const ruleRow = Array.isArray(rulesData) ? rulesData[0] : rulesData;
    if (ruleRow?.leaderboard_names) {
      nameMode = String(ruleRow.leaderboard_names).trim();
    }
  } catch {
    // Keep default first_name_initial
  }

  // Fetch caller's level when student is in 'level' scope
  let callerLevel = null;
  if (!isAdmin && scope === 'level') {
    const { data: myProf } = await adminSupabase
      .from('profiles')
      .select('level')
      .eq('id', student.id)
      .single();
    callerLevel = myProf?.level ? String(myProf.level).trim() : null;
  }

  // Fetch eligible student profiles (active = true, role = 'student', leaderboard_visible != false)
  const { data: profiles, error: profErr } = await adminSupabase
    .from('profiles')
    .select('id, student_code, full_name, level, active, leaderboard_visible, role')
    .eq('role', 'student')
    .eq('active', true);

  if (profErr || !Array.isArray(profiles)) {
    return res.status(500).json({ error: 'Could not load student profiles for leaderboard.' });
  }

  const eligibleProfiles = new Map();
  for (const p of profiles) {
    if (p.leaderboard_visible === false) continue;
    const pLevel = p.level ? String(p.level).trim() : '';
    if (!isAdmin) {
      if (scope === 'level') {
        if (callerLevel && pLevel.toLowerCase() !== callerLevel.toLowerCase()) continue;
        if (!callerLevel && pLevel) continue;
      }
    } else if (requestedLevel && requestedLevel.toLowerCase() !== 'all') {
      if (pLevel.toLowerCase() !== requestedLevel.toLowerCase()) continue;
    }
    eligibleProfiles.set(p.id, p);
  }

  if (eligibleProfiles.size === 0) {
    return res.status(200).json({ rows: [] });
  }

  const activityType = section === 'elements' ? 'element' : 'flash_anzan';
  const startIso = `${bounds.startDate}T00:00:00+05:30`;

  const { data: actRows, error: actErr } = await adminSupabase
    .from('activity_results')
    .select('id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
    .eq('activity_type', activityType)
    .gte('created_at', startIso);

  if (actErr || !Array.isArray(actRows)) {
    return res.status(500).json({ error: 'Could not load activity results for leaderboard.' });
  }

  const targetDrillKey = task.activity_key ? String(task.activity_key).trim() : '';
  const targetDrillTitle = targetDrillKey && DRILLS[targetDrillKey] ? DRILLS[targetDrillKey].title : '';

  // Group matching rows by student_id within [bounds.startDate, bounds.endDate] in IST
  const byStudent = new Map();
  for (const r of actRows) {
    if (!eligibleProfiles.has(r.student_id)) continue;
    const istDate = toIstDateStr(r.created_at);
    if (!istDate || istDate < bounds.startDate || istDate > bounds.endDate) continue;

    const settings = r.settings && typeof r.settings === 'object' ? r.settings : {};

    if (section === 'elements') {
      const rowDrill = settings.drill ? String(settings.drill).trim() : '';
      const rowName = r.activity_name ? String(r.activity_name).trim() : '';
      const matchesDrill =
        (targetDrillKey && rowDrill === targetDrillKey) ||
        (targetDrillTitle && rowName.toLowerCase() === targetDrillTitle.toLowerCase());
      if (!matchesDrill) continue;
    } else if (section === 'flash') {
      if (task.flash_digits !== null && task.flash_digits !== undefined) {
        if (Number(settings.digits) !== Number(task.flash_digits)) continue;
      }
      if (task.flash_count !== null && task.flash_count !== undefined) {
        if (Number(settings.count) !== Number(task.flash_count)) continue;
      }
      if (task.flash_speed_ms !== null && task.flash_speed_ms !== undefined) {
        if (Number(settings.speed_ms) !== Number(task.flash_speed_ms)) continue;
      }
      if (task.flash_mode !== null && task.flash_mode !== undefined && String(task.flash_mode).trim()) {
        if (String(settings.mode || '').trim() !== String(task.flash_mode).trim()) continue;
      }
    }

    if (!byStudent.has(r.student_id)) {
      byStudent.set(r.student_id, []);
    }
    byStudent.get(r.student_id).push(r);
  }

  const summaries = [];
  for (const [stuId, rows] of byStudent.entries()) {
    const prof = eligibleProfiles.get(stuId);
    if (!prof || rows.length === 0) continue;

    if (section === 'elements') {
      let bestRow = null;
      let bestPerMin = -1;
      for (const r of rows) {
        const corr = Math.max(0, Number(r.correct) || 0);
        const tot = Math.max(corr, Number(r.total) || 0);
        const sec = Math.max(1, Number(r.time_seconds) || 1);
        const cpm = Math.round(((corr * 60) / sec) * 10) / 10;
        if (!bestRow) {
          bestRow = { corr, tot, sec };
          bestPerMin = cpm;
        } else {
          const bestWrong = bestRow.tot - bestRow.corr;
          const currWrong = tot - corr;
          if (
            cpm > bestPerMin ||
            (cpm === bestPerMin && corr > bestRow.corr) ||
            (cpm === bestPerMin && corr === bestRow.corr && currWrong < bestWrong) ||
            (cpm === bestPerMin && corr === bestRow.corr && currWrong === bestWrong && sec < bestRow.sec)
          ) {
            bestRow = { corr, tot, sec };
            bestPerMin = cpm;
          }
        }
      }
      if (bestRow) {
        summaries.push({
          student_id: stuId,
          profile: prof,
          best_per_minute: bestPerMin,
          correct: bestRow.corr,
          attempted: bestRow.tot,
          seconds: bestRow.sec,
          attempts: rows.length,
        });
      }
    } else if (section === 'flash') {
      const totalTries = rows.length;
      let totalCorrect = 0;
      let bestCorrectSec = null;
      let bestAnySec = null;
      for (const r of rows) {
        const corr = Math.max(0, Number(r.correct) || 0);
        const sec = Math.max(1, Number(r.time_seconds) || 1);
        totalCorrect += corr;
        if (bestAnySec === null || sec < bestAnySec) {
          bestAnySec = sec;
        }
        if (corr > 0 && (bestCorrectSec === null || sec < bestCorrectSec)) {
          bestCorrectSec = sec;
        }
      }
      const chosenSec = bestCorrectSec !== null ? bestCorrectSec : (bestAnySec || 1);
      const bestPerMin =
        bestCorrectSec !== null
          ? Math.round((60 / bestCorrectSec) * 10) / 10
          : 0;

      summaries.push({
        student_id: stuId,
        profile: prof,
        best_per_minute: bestPerMin,
        correct: totalCorrect,
        attempted: totalTries,
        seconds: chosenSec,
        attempts: totalTries,
      });
    }
  }

  summaries.sort((a, b) => {
    if (b.best_per_minute !== a.best_per_minute) return b.best_per_minute - a.best_per_minute;
    if (b.correct !== a.correct) return b.correct - a.correct;
    const aWrong = a.attempted - a.correct;
    const bWrong = b.attempted - b.correct;
    if (aWrong !== bWrong) return aWrong - bWrong;
    if (a.seconds !== b.seconds) return a.seconds - b.seconds;
    return String(a.profile.student_code || '').localeCompare(String(b.profile.student_code || ''));
  });

  const ranked = summaries.map((item, idx) => ({
    rank: idx + 1,
    student_id: isAdmin ? item.student_id : null,
    display_name: formatLeaderboardDisplayName(item.profile, nameMode),
    level: item.profile.level || null,
    best_per_minute: item.best_per_minute,
    correct: item.correct,
    attempted: item.attempted,
    seconds: item.seconds,
    attempts: item.attempts,
    is_me: !isAdmin && item.student_id === student.id,
  }));

  if (isAdmin) {
    const cap = Math.min(200, Math.max(1, rawLimit));
    return res.status(200).json({ rows: ranked.slice(0, cap) });
  }

  const topLimit = Math.min(10, Math.max(1, rawLimit));
  const topRows = ranked.slice(0, topLimit);
  const ownRow = ranked.find((r) => r.is_me);
  if (ownRow && !topRows.some((r) => r.is_me)) {
    topRows.push(ownRow);
  }

  return res.status(200).json({ rows: topRows });
}

