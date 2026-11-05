/**
 * Trendz Tracker - Online Weekly Test Serverless Endpoint (api/weekly-test.js)
 *
 * Phase 13a + Phase 16a + Phase 16b:
 * Supports online weekly test sections of kind:
 * - 'basics'
 * - 'elements'
 * - 'memoriad'
 * - 'flash' (multi-try, resumable while tries_started < question_count)
 *
 * Security & Data Isolation:
 * - Verifies active student caller via `verifyStudentCaller(req)`.
 * - Enforces rate limit of max 60 section starts per hour per student across `drill_sessions`.
 * - Coordinates with DB via `weekly_test_reserve_section_start(p_test, p_student, ...)` on `start`.
 * - Stores expected answers server-side only in `drill_sessions.expected`.
 * - Writes results ONLY to `weekly_test_scores` and `weekly_test_attempts`
 *   (NEVER writes to `activity_results` or `results`).
 * - Never logs answers, expected answers, or tokens.
 */

import { getDrillServerClient, verifyStudentCaller } from './_supabaseAdmin.js';
import {
  DRILLS,
  BASICS_TIMED_POOLS,
  BASICS_TIMED_SECONDS,
  BASICS_TIMED_GRACE_SECONDS,
  parseBasicsCategoryName,
  generateBasicsSet,
  stripBasicsExpected,
  checkTimedBasicsSubmission,
  gradeDrillSubmission,
} from './_drills.js';
import {
  MODULES,
  generateMemoriadSet,
  computeMemoriadUsedSeconds,
  evaluateMemoriadSubmission,
} from './_memoriad.js';
import {
  isWeeklyTestSession,
  computeFlashMinSeconds,
  computeFlashExpirySeconds,
  getMemoriadTestFixedSettings,
  applyFlashTry,
  finalScore,
} from './_weeklyTest.js';

const MAX_STARTS_PER_HOUR = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const SECTION_GRACE_SECONDS = 60;

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
 * Checks that the student has not started more than 60 drill_sessions in the last hour.
 */
async function checkStartRateLimit(adminSupabase, studentId, nowMs) {
  try {
    const oneHourAgoIso = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();
    const query = adminSupabase
      .from('drill_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', studentId);

    if (typeof query?.gte !== 'function') {
      return { allowed: true };
    }

    const { count, error } = await query.gte('started_at', oneHourAgoIso);
    if (!error && typeof count === 'number' && count >= MAX_STARTS_PER_HOUR) {
      return {
        allowed: false,
        error: 'Too many section starts in the last hour. Please wait a moment and try again.',
      };
    }
  } catch {
    // Allow when test mock does not implement count query on drill_sessions
  }
  return { allowed: true };
}

/**
 * Extracts signed integer array from `flash_generate_question` RPC output.
 */
function extractFlashNumbers(rpcData) {
  if (Array.isArray(rpcData)) {
    if (rpcData.length > 0 && typeof rpcData[0] === 'number') {
      return rpcData.map((n) => Number(n));
    }
    if (rpcData[0] && Array.isArray(rpcData[0].numbers)) {
      return rpcData[0].numbers.map((n) => Number(n));
    }
  }
  if (rpcData && typeof rpcData === 'object' && Array.isArray(rpcData.numbers)) {
    return rpcData.numbers.map((n) => Number(n));
  }
  return null;
}

/**
 * Handles `POST { action: 'start', test_id, section_id, category_id? }`.
 */
export async function handleStartWeeklyTestSection({
  student,
  body,
  adminSupabase,
  now = new Date(),
}) {
  const testId = typeof body?.test_id === 'string' ? body.test_id.trim() : '';
  const rawSectionId = typeof body?.section_id === 'string' ? body.section_id.trim() : '';
  const rawCategoryId = typeof body?.category_id === 'string' ? body.category_id.trim() : '';

  if (!isValidId(testId)) {
    return {
      statusCode: 400,
      payload: { error: 'A valid weekly test ID is required.' },
    };
  }

  let sectionId = isValidId(rawSectionId) ? rawSectionId : '';
  const categoryIdArg = isValidId(rawCategoryId) ? rawCategoryId : '';

  if (!sectionId && !categoryIdArg) {
    return {
      statusCode: 400,
      payload: { error: 'A valid weekly test section ID is required.' },
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startedAtIso = new Date(nowMs).toISOString();

  // Rate limit: max 60 starts per hour per student across drill_sessions
  const rateCheck = await checkStartRateLimit(adminSupabase, student.id, nowMs);
  if (!rateCheck.allowed) {
    return {
      statusCode: 429,
      payload: { error: rateCheck.error },
    };
  }

  // Resolve section_id from category_id if legacy caller only passed category_id
  if (!sectionId && categoryIdArg) {
    try {
      const { data: secRow } = await adminSupabase
        .from('weekly_test_sections')
        .select('id')
        .eq('test_id', testId)
        .eq('category_id', categoryIdArg)
        .maybeSingle();
      if (secRow?.id) {
        sectionId = String(secRow.id);
      }
    } catch {
      // Optional lookup
    }
  }

  // 1. Authoritative DB reservation & row lock via weekly_test_reserve_section_start
  //    Coordinates with save_weekly_test_sections_atomic to eliminate student-start / admin-edit race.
  const { data: resData, error: resErr } = await adminSupabase.rpc(
    'weekly_test_reserve_section_start',
    {
      p_test_id: testId,
      p_student_id: student.id,
      p_section_id: sectionId || null,
      p_category_id: categoryIdArg || null,
    }
  );

  if (resErr) {
    const errCode = String(resErr?.code || '');
    const errMsg = String(resErr?.message || '');

    // Recognize missing RPC in Postgres/PostgREST explicitly: return MIGRATION_REQUIRED
    // Never fall back to uncoordinated start flow
    if (
      errCode === 'PGRST202' ||
      errCode === '42883' ||
      errMsg.includes('does not exist') ||
      errMsg.includes('function weekly_test_reserve_section_start')
    ) {
      return {
        statusCode: 500,
        payload: {
          error:
            'Atomic weekly test reservation migration required: function weekly_test_reserve_section_start is not installed in the database. Please have the database owner run migration 14_phase16d_atomic_weekly_test_reservation.sql before starting online sections.',
          code: 'MIGRATION_REQUIRED',
        },
      };
    }

    return {
      statusCode: 400,
      payload: {
        error: errMsg || 'Unable to reserve weekly test section.',
      },
    };
  }

  const reservation = Array.isArray(resData) ? resData[0] : resData;
  const check = reservation;

  if (!check || check.ok !== true) {
    return {
      statusCode: 400,
      payload: {
        error: check?.reason || 'This weekly test section cannot be started right now.',
      },
    };
  }

  if (!sectionId && check.section_id && isValidId(String(check.section_id))) {
    sectionId = String(check.section_id);
  }

  const kind = String(check.kind || 'basics').trim().toLowerCase();
  const testTitle = check.test_title || check.title || 'Weekly Test';
  const claimToken = check.claim_token;
  const attemptId = check.attempt_id;

  // ==========================================================================
  // KIND 1: BASICS
  // ==========================================================================
  if (kind === 'basics') {
    const categoryId = String(check.category_id || categoryIdArg || '').trim();
    if (!isValidId(categoryId)) {
      return {
        statusCode: 400,
        payload: { error: 'A valid basics category ID is required.' },
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
        payload: { error: 'Weekly test basics sections only support Basics categories.' },
      };
    }

    const parsedSpec = parseBasicsCategoryName(category.name);
    if (!parsedSpec) {
      return {
        statusCode: 400,
        payload: { error: `Category "${category.name}" is not available online.` },
      };
    }

    const expiresAtIso = new Date(
      nowMs + (seconds + BASICS_TIMED_GRACE_SECONDS) * 1000
    ).toISOString();

    const rollbackAttempt = async () => {
      try {
        if (attemptId && claimToken) {
          await adminSupabase.rpc('weekly_test_rollback_start_reservation', {
            p_attempt_id: attemptId,
            p_student_id: student.id,
            p_claim_token: claimToken,
          });
        }
      } catch {
        // Best-effort cleanup
      }
    };

    try {
      const generated = generateBasicsSet(category.name, poolSize);
      const displayQuestions = stripBasicsExpected(generated);
      const expectedAnswers = generated.map((q) => q.expected);

      const sessionSettings = {
        kind: 'weekly_test',
        section_kind: 'basics',
        mode: 'timed',
        test_id: testId,
        section_id: sectionId || null,
        category_id: categoryId,
        category_name: category.name,
        title: testTitle,
        seconds,
        pool: poolSize,
      };

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

      const { data: updatedAtt, error: linkErr } = await adminSupabase
        .from('weekly_test_attempts')
        .update({ session_id: sessionRow.id })
        .eq('id', attemptId)
        .eq('claim_token', claimToken)
        .select('id');

      const linkedCount = Array.isArray(updatedAtt) ? updatedAtt.length : (updatedAtt ? 1 : 0);
      if (linkErr || linkedCount !== 1) {
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
          kind: 'basics',
          session_id: sessionRow.id,
          section_id: sectionId || null,
          category_id: categoryId,
          title: testTitle,
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

  // ==========================================================================
  // KIND 2: ELEMENTS WORKSHEET
  // ==========================================================================
  if (kind === 'elements') {
    const drillKey = String(check.activity_key || '').trim();
    const drill = DRILLS[drillKey];
    if (!drill || !drill.enabled || typeof drill.generate !== 'function') {
      return {
        statusCode: 400,
        payload: { error: 'This Elements drill is not available for online weekly tests.' },
      };
    }

    const timeLimitSeconds = Number(drill.time_limit_seconds) || 60;
    const expiresAtIso = new Date(
      nowMs + (timeLimitSeconds + SECTION_GRACE_SECONDS) * 1000
    ).toISOString();

    const rollbackAttempt = async () => {
      try {
        if (attemptId && claimToken) {
          await adminSupabase.rpc('weekly_test_rollback_start_reservation', {
            p_attempt_id: attemptId,
            p_student_id: student.id,
            p_claim_token: claimToken,
          });
        }
      } catch {
        // Best-effort cleanup
      }
    };

    try {
      const generatedSet = drill.generate();
      const questionTexts = generatedSet.map((item) =>
        item && item.q !== undefined ? String(item.q) : String(item?.text ?? item ?? '')
      );
      const expectedAnswers = generatedSet.map((item) => item.expected);

      const sessionSettings = {
        kind: 'weekly_test',
        section_kind: 'elements',
        test_id: testId,
        section_id: sectionId,
        drill: drillKey,
        drill_title: drill.title,
        title: testTitle,
        time_limit_seconds: timeLimitSeconds,
        questions_count: questionTexts.length,
      };

      const { data: sessionRow, error: sessionErr } = await adminSupabase
        .from('drill_sessions')
        .insert({
          student_id: student.id,
          activity_type: 'element',
          activity_name: drillKey,
          settings: sessionSettings,
          questions: questionTexts,
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

      const { data: updatedAtt, error: linkErr } = await adminSupabase
        .from('weekly_test_attempts')
        .update({ session_id: sessionRow.id })
        .eq('id', attemptId)
        .eq('claim_token', claimToken)
        .select('id');

      const linkedCount = Array.isArray(updatedAtt) ? updatedAtt.length : (updatedAtt ? 1 : 0);
      if (linkErr || linkedCount !== 1) {
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
          kind: 'elements',
          session_id: sessionRow.id,
          section_id: sectionId,
          title: testTitle,
          drill: drillKey,
          drill_title: drill.title,
          questions: questionTexts,
          time_limit_seconds: timeLimitSeconds,
          hint: drill.hint,
          inputmode: drill.inputmode || 'numeric',
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

  // ==========================================================================
  // KIND 3: MEMORIAD STAGE
  // ==========================================================================
  if (kind === 'memoriad') {
    const moduleKey = String(check.activity_key || '').trim().toLowerCase();
    const modSpec = MODULES[moduleKey];
    if (!modSpec) {
      return {
        statusCode: 400,
        payload: { error: 'This Memoriad module is not available for online weekly tests.' },
      };
    }

    const fixedSettings = getMemoriadTestFixedSettings(moduleKey);
    const limitSec = Number(modSpec.time_limit_seconds) || 60;
    const concSec = Number(fixedSettings.concentration_seconds) || 5;
    const expiresAtIso = new Date(
      nowMs + (limitSec + concSec + SECTION_GRACE_SECONDS) * 1000
    ).toISOString();

    const rollbackAttempt = async () => {
      try {
        if (attemptId && claimToken) {
          await adminSupabase.rpc('weekly_test_rollback_start_reservation', {
            p_attempt_id: attemptId,
            p_student_id: student.id,
            p_claim_token: claimToken,
          });
        }
      } catch {
        // Best-effort cleanup
      }
    };

    try {
      const generated = generateMemoriadSet(moduleKey, fixedSettings);
      const sessionSettings = {
        ...generated.settings,
        ...fixedSettings,
        kind: 'weekly_test',
        section_kind: 'memoriad',
        test_id: testId,
        section_id: sectionId,
        module: moduleKey,
        module_title: generated.title,
        title: testTitle,
        time_limit_seconds: limitSec,
      };

      const { data: sessionRow, error: sessionErr } = await adminSupabase
        .from('drill_sessions')
        .insert({
          student_id: student.id,
          activity_type: 'memoriad',
          activity_name: moduleKey,
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

      if (sessionErr || !sessionRow?.id) {
        await rollbackAttempt();
        return {
          statusCode: 500,
          payload: { error: 'Failed to create weekly test session. Please try again.' },
        };
      }

      const { data: updatedAtt, error: linkErr } = await adminSupabase
        .from('weekly_test_attempts')
        .update({ session_id: sessionRow.id })
        .eq('id', attemptId)
        .eq('claim_token', claimToken)
        .select('id');

      const linkedCount = Array.isArray(updatedAtt) ? updatedAtt.length : (updatedAtt ? 1 : 0);
      if (linkErr || linkedCount !== 1) {
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
          kind: 'memoriad',
          session_id: sessionRow.id,
          section_id: sectionId,
          title: testTitle,
          module: moduleKey,
          module_title: generated.title,
          questions: generated.questions,
          limits: {
            time_limit_seconds: limitSec,
            concentration_seconds: concSec,
            grace_seconds: SECTION_GRACE_SECONDS,
          },
          settings: fixedSettings,
          started_at: startedAtIso,
          expires_at: expiresAtIso,
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

  // ==========================================================================
  // KIND 4: FLASH ANZAN (Multi-try section)
  // ==========================================================================
  if (kind === 'flash') {
    const digits = Math.max(1, Math.min(5, Number(check.flash_digits) || 1));
    const count = Math.max(2, Math.min(1000, Number(check.flash_count) || 10));
    const speedMs = Math.max(200, Math.min(5000, Number(check.flash_speed_ms) || 1000));
    const mode = check.flash_mode === 'add_sub' ? 'add_sub' : 'add';
    const questionCount = Math.max(1, Math.min(10, Number(check.question_count) || 5));

    const nextTryNo = Number(reservation?.next_try_no) || 1;

    const rollbackFlash = async () => {
      try {
        if (attemptId && claimToken) {
          await adminSupabase.rpc('weekly_test_rollback_start_reservation', {
            p_attempt_id: attemptId,
            p_student_id: student.id,
            p_claim_token: claimToken,
          });
        }
      } catch {
        // Best-effort cleanup
      }
    };

    // Generate the Flash question numbers via service-role RPC flash_generate_question
    const { data: flashGenData, error: flashGenErr } = await adminSupabase.rpc(
      'flash_generate_question',
      {
        p_digits: digits,
        p_count: count,
        p_mode: mode,
      }
    );

    const numbers = extractFlashNumbers(flashGenData);
    if (flashGenErr || !Array.isArray(numbers) || numbers.length === 0) {
      await rollbackFlash();
      return {
        statusCode: 500,
        payload: {
          error: flashGenErr?.message || 'Could not generate Flash Anzan numbers. Please try again.',
        },
      };
    }

    const expectedSum = numbers.reduce((acc, n) => acc + Number(n), 0);
    const minSeconds = computeFlashMinSeconds(count, speedMs);
    const expirySeconds = computeFlashExpirySeconds(count, speedMs);
    const expiresAtIso = new Date(nowMs + expirySeconds * 1000).toISOString();

    const sessionSettings = {
      kind: 'weekly_test',
      section_kind: 'flash',
      test_id: testId,
      section_id: sectionId,
      title: testTitle,
      digits,
      count,
      speed_ms: speedMs,
      mode,
      try_no: nextTryNo,
      question_count: questionCount,
    };

    const { data: sessionRow, error: sessionErr } = await adminSupabase
      .from('drill_sessions')
      .insert({
        student_id: student.id,
        activity_type: 'flash_anzan',
        activity_name: `${digits}d_${count}n_${speedMs}ms_${mode}`,
        settings: sessionSettings,
        questions: [numbers],
        expected: [expectedSum],
        min_seconds: minSeconds,
        started_at: startedAtIso,
        expires_at: expiresAtIso,
        status: 'open',
      })
      .select('id')
      .single();

    if (sessionErr || !sessionRow?.id) {
      await rollbackFlash();
      return {
        statusCode: 500,
        payload: { error: 'Failed to create Flash try session. Please try again.' },
      };
    }

    // Link session_id (tries_started was already incremented atomically in DB reservation)
    const { data: updatedAtt, error: updAttErr } = await adminSupabase
      .from('weekly_test_attempts')
      .update({
        session_id: sessionRow.id,
      })
      .eq('id', attemptId)
      .eq('claim_token', claimToken)
      .select('id');

    const linkedCount = Array.isArray(updatedAtt) ? updatedAtt.length : (updatedAtt ? 1 : 0);
    if (updAttErr || linkedCount !== 1) {
      await adminSupabase.from('drill_sessions').delete().eq('id', sessionRow.id);
      await rollbackFlash();
      return {
        statusCode: 500,
        payload: { error: 'Failed to record Flash try start. Please try again.' },
      };
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        kind: 'flash',
        session_id: sessionRow.id,
        section_id: sectionId,
        title: testTitle,
        numbers,
        settings: {
          digits,
          count,
          speed_ms: speedMs,
          mode,
        },
        try_no: nextTryNo,
        question_count: questionCount,
      },
    };
  }

  return {
    statusCode: 400,
    payload: { error: `Unsupported weekly test section kind "${kind}".` },
  };
}

/**
 * Handles `POST { action: 'submit', session_id, answers, answer }`.
 */
export async function handleSubmitWeeklyTestSection({
  student,
  body,
  adminSupabase,
  now = new Date(),
}) {
  const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';

  if (!isValidId(sessionId)) {
    return {
      statusCode: 400,
      payload: { error: 'A valid session_id is required.' },
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

  if (!isWeeklyTestSession(sessionRow)) {
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

  const settings =
    sessionRow.settings && typeof sessionRow.settings === 'object' ? sessionRow.settings : {};
  const testId = settings.test_id;
  const sectionId = settings.section_id || null;
  const categoryId = settings.category_id || null;
  const testTitle = settings.title || 'Weekly Test';

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

  const sectionKind = String(
    settings.section_kind ||
      (sessionRow.activity_type === 'element'
        ? 'elements'
        : sessionRow.activity_type === 'memoriad'
          ? 'memoriad'
          : sessionRow.activity_type === 'flash_anzan'
            ? 'flash'
            : 'basics')
  )
    .trim()
    .toLowerCase();

  // Helper to reopen a claimed drill_sessions row if a DB write fails
  const reopenSession = async () => {
    try {
      await adminSupabase
        .from('drill_sessions')
        .update({ status: 'open' })
        .eq('id', sessionId)
        .eq('student_id', student.id);
    } catch {
      // Best-effort
    }
  };

  // Helper to atomically claim the open drill_sessions row
  const claimSession = async () => {
    const { data: claimedRows, error: claimErr } = await adminSupabase
      .from('drill_sessions')
      .update({ status: 'submitted' })
      .eq('id', sessionId)
      .eq('student_id', student.id)
      .eq('status', 'open')
      .select('id');

    if (claimErr) {
      return {
        ok: false,
        statusCode: 500,
        error: 'Failed to record weekly test submission.',
      };
    }
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      return {
        ok: false,
        statusCode: 400,
        error: 'This weekly test section has already been submitted.',
      };
    }
    return { ok: true };
  };

  // ==========================================================================
  // SUBMIT KIND 1: BASICS
  // ==========================================================================
  if (sectionKind === 'basics') {
    const answers = body?.answers;
    if (!Array.isArray(answers)) {
      return {
        statusCode: 400,
        payload: { error: 'Answers must be provided as a list.' },
      };
    }

    const sectionSeconds = Number(settings.seconds) || 60;
    let correct = 0;
    let attempted = answers.length;
    let accuracy = 0;
    let usedSeconds = Math.max(1, Math.round(Math.min(elapsedSeconds, sectionSeconds)));
    let detail = [];

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
      detail = Array.isArray(checkResult.detail) ? checkResult.detail : [];
    }

    const claim = await claimSession();
    if (!claim.ok) {
      return { statusCode: claim.statusCode, payload: { error: claim.error } };
    }

    const scoreInfo = finalScore('basics', {
      correct,
      attempted,
      used_seconds: usedSeconds,
    });

    if (!scoreInfo.shouldSave) {
      const q = adminSupabase
        .from('weekly_test_attempts')
        .update({
          status: 'submitted',
          finished_at: nowIso,
          seconds_used: scoreInfo.time_seconds,
        })
        .eq('test_id', testId)
        .eq('student_id', student.id);
      await (sectionId ? q.eq('section_id', sectionId) : q.eq('category_id', categoryId));

      return {
        statusCode: 200,
        payload: {
          ok: true,
          kind: 'basics',
          title: testTitle,
          correct: 0,
          attempted: 0,
          accuracy: 0,
          used_seconds: usedSeconds,
          detail: [],
        },
      };
    }

    const scorePayload = {
      test_id: testId,
      student_id: student.id,
      category_id: categoryId,
      correct: scoreInfo.correct,
      total: scoreInfo.total,
      time_seconds: scoreInfo.time_seconds,
      source: 'online',
    };
    if (sectionId) {
      scorePayload.section_id = sectionId;
    }

    const { error: scoreErr } = await adminSupabase.from('weekly_test_scores').upsert(
      scorePayload,
      {
        onConflict: sectionId
          ? 'test_id,student_id,section_id'
          : 'test_id,student_id,category_id',
      }
    );

    if (scoreErr) {
      await reopenSession();
      return {
        statusCode: 500,
        payload: {
          error: scoreErr.message || 'Failed to save weekly test score. Please try sending again.',
        },
      };
    }

    const attUpdateQ = adminSupabase
      .from('weekly_test_attempts')
      .update({
        status: 'submitted',
        finished_at: nowIso,
        seconds_used: scoreInfo.time_seconds,
      })
      .eq('test_id', testId)
      .eq('student_id', student.id);
    await (sectionId
      ? attUpdateQ.eq('section_id', sectionId)
      : attUpdateQ.eq('category_id', categoryId));

    return {
      statusCode: 200,
      payload: {
        ok: true,
        kind: 'basics',
        title: testTitle,
        correct,
        attempted,
        accuracy,
        used_seconds: usedSeconds,
        detail,
      },
    };
  }

  // ==========================================================================
  // SUBMIT KIND 2: ELEMENTS WORKSHEET
  // ==========================================================================
  if (sectionKind === 'elements') {
    const answers = body?.answers;
    if (!Array.isArray(answers)) {
      return {
        statusCode: 400,
        payload: { error: 'Answers must be provided as a list.' },
      };
    }

    const minSec = Number(sessionRow.min_seconds) || 1;
    if (elapsedSeconds < minSec) {
      return {
        statusCode: 400,
        payload: { error: 'Finished faster than possible.' },
      };
    }

    const drillKey = String(settings.drill || sessionRow.activity_name || '').trim();
    const drill = DRILLS[drillKey];
    const timeLimitSeconds =
      Number(settings.time_limit_seconds || drill?.time_limit_seconds) || 60;

    let graded;
    try {
      graded = gradeDrillSubmission({
        drillKey,
        questions: sessionRow.questions,
        expected: sessionRow.expected,
        answers,
        elapsedSeconds,
        timeLimitSeconds,
      });
    } catch (gradeErr) {
      return {
        statusCode: 400,
        payload: { error: gradeErr.message || 'Invalid worksheet answers.' },
      };
    }

    const claim = await claimSession();
    if (!claim.ok) {
      return { statusCode: claim.statusCode, payload: { error: claim.error } };
    }

    const scoreInfo = finalScore('elements', graded);

    if (!scoreInfo.shouldSave) {
      await adminSupabase
        .from('weekly_test_attempts')
        .update({
          status: 'submitted',
          finished_at: nowIso,
          seconds_used: scoreInfo.time_seconds,
        })
        .eq('test_id', testId)
        .eq('student_id', student.id)
        .eq('section_id', sectionId);

      return {
        statusCode: 200,
        payload: {
          ok: true,
          kind: 'elements',
          saved: false,
          title: testTitle,
          drill: drillKey,
          drill_title: settings.drill_title || drill?.title || drillKey,
          ...graded,
        },
      };
    }

    const { error: scoreErr } = await adminSupabase.from('weekly_test_scores').upsert(
      {
        test_id: testId,
        student_id: student.id,
        section_id: sectionId,
        correct: scoreInfo.correct,
        total: scoreInfo.total,
        time_seconds: scoreInfo.time_seconds,
        source: 'online',
      },
      { onConflict: 'test_id,student_id,section_id' }
    );

    if (scoreErr) {
      await reopenSession();
      return {
        statusCode: 500,
        payload: {
          error: scoreErr.message || 'Failed to save weekly test score. Please try sending again.',
        },
      };
    }

    await adminSupabase
      .from('weekly_test_attempts')
      .update({
        status: 'submitted',
        finished_at: nowIso,
        seconds_used: scoreInfo.time_seconds,
      })
      .eq('test_id', testId)
      .eq('student_id', student.id)
      .eq('section_id', sectionId);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        kind: 'elements',
        saved: true,
        title: testTitle,
        drill: drillKey,
        drill_title: settings.drill_title || drill?.title || drillKey,
        ...graded,
      },
    };
  }

  // ==========================================================================
  // SUBMIT KIND 3: MEMORIAD STAGE
  // ==========================================================================
  if (sectionKind === 'memoriad') {
    const answers = body?.answers;
    if (!Array.isArray(answers)) {
      return {
        statusCode: 400,
        payload: { error: 'Answers must be provided as a list.' },
      };
    }

    const moduleKey = String(settings.module || sessionRow.activity_name || '')
      .trim()
      .toLowerCase();
    const modSpec = MODULES[moduleKey];
    if (!modSpec) {
      return {
        statusCode: 400,
        payload: { error: 'Unknown Memoriad module on session.' },
      };
    }

    const minSec = Number(sessionRow.min_seconds) || 1;
    if (elapsedSeconds < minSec) {
      return {
        statusCode: 400,
        payload: { error: 'Submission was faster than the minimum allowed duration.' },
      };
    }

    const concSec = Number(settings.concentration_seconds) || 5;
    const usedSeconds = computeMemoriadUsedSeconds(startedMs, nowMs, concSec, moduleKey);

    const evalRes = evaluateMemoriadSubmission(
      {
        module: moduleKey,
        questions: sessionRow.questions,
        expected: sessionRow.expected,
        settings,
      },
      answers,
      usedSeconds
    );

    if (!evalRes.ok) {
      return {
        statusCode: 400,
        payload: { error: evalRes.error },
      };
    }

    const evaluation = evalRes.evaluation;
    const claim = await claimSession();
    if (!claim.ok) {
      return { statusCode: claim.statusCode, payload: { error: claim.error } };
    }

    const scoreInfo = finalScore('memoriad', {
      ...evaluation,
      used_seconds: usedSeconds,
    });

    if (!scoreInfo.shouldSave) {
      await adminSupabase
        .from('weekly_test_attempts')
        .update({
          status: 'submitted',
          finished_at: nowIso,
          seconds_used: scoreInfo.time_seconds,
        })
        .eq('test_id', testId)
        .eq('student_id', student.id)
        .eq('section_id', sectionId);

      return {
        statusCode: 200,
        payload: {
          ok: true,
          kind: 'memoriad',
          saved: false,
          module: moduleKey,
          title: settings.module_title || modSpec.title,
          test_title: testTitle,
          used_seconds: usedSeconds,
          ...evaluation,
        },
      };
    }

    const { error: scoreErr } = await adminSupabase.from('weekly_test_scores').upsert(
      {
        test_id: testId,
        student_id: student.id,
        section_id: sectionId,
        correct: scoreInfo.correct,
        total: scoreInfo.total,
        time_seconds: scoreInfo.time_seconds,
        source: 'online',
      },
      { onConflict: 'test_id,student_id,section_id' }
    );

    if (scoreErr) {
      await reopenSession();
      return {
        statusCode: 500,
        payload: {
          error: scoreErr.message || 'Failed to save weekly test score. Please try sending again.',
        },
      };
    }

    await adminSupabase
      .from('weekly_test_attempts')
      .update({
        status: 'submitted',
        finished_at: nowIso,
        seconds_used: scoreInfo.time_seconds,
      })
      .eq('test_id', testId)
      .eq('student_id', student.id)
      .eq('section_id', sectionId);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        kind: 'memoriad',
        saved: true,
        module: moduleKey,
        title: settings.module_title || modSpec.title,
        test_title: testTitle,
        used_seconds: usedSeconds,
        ...evaluation,
      },
    };
  }

  // ==========================================================================
  // SUBMIT KIND 4: FLASH ANZAN (Multi-try section)
  // ==========================================================================
  if (sectionKind === 'flash') {
    const rawAnswer =
      body?.answer !== undefined
        ? body.answer
        : Array.isArray(body?.answers)
          ? body.answers[0]
          : null;

    let givenInt = null;
    if (rawAnswer !== null && rawAnswer !== undefined && String(rawAnswer).trim() !== '') {
      const parsed = Number(String(rawAnswer).trim());
      if (!Number.isInteger(parsed)) {
        return {
          statusCode: 400,
          payload: { error: 'Flash Anzan answer must be a whole number or empty.' },
        };
      }
      givenInt = parsed;
    }

    const minSec =
      Number(sessionRow.min_seconds) ||
      computeFlashMinSeconds(settings.count, settings.speed_ms);
    if (elapsedSeconds < minSec) {
      return {
        statusCode: 400,
        payload: { error: 'This try finished too quickly to be valid.' },
      };
    }

    const expectedVal = Array.isArray(sessionRow.expected)
      ? Number(sessionRow.expected[0])
      : Number(sessionRow.expected);
    const isCorrect =
      givenInt !== null && Number.isFinite(expectedVal) && givenInt === expectedVal;

    // Load the student's weekly_test_attempts row for this section
    const { data: attemptRow, error: attLoadErr } = await adminSupabase
      .from('weekly_test_attempts')
      .select('id, status, tries_started, tries_correct, seconds_used')
      .eq('test_id', testId)
      .eq('student_id', student.id)
      .eq('section_id', sectionId)
      .maybeSingle();

    if (attLoadErr || !attemptRow) {
      return {
        statusCode: 404,
        payload: { error: 'Weekly test attempt record not found for this Flash section.' },
      };
    }

    const questionCount = Math.max(1, Number(settings.question_count) || 5);
    const effectiveTriesStarted = Math.max(
      Number(attemptRow.tries_started) || 0,
      Number(settings.try_no) || 1
    );

    const nextState = applyFlashTry(
      {
        ...attemptRow,
        tries_started: effectiveTriesStarted,
      },
      { question_count: questionCount },
      isCorrect,
      Math.max(1, Math.round(elapsedSeconds))
    );

    const claim = await claimSession();
    if (!claim.ok) {
      return { statusCode: claim.statusCode, payload: { error: claim.error } };
    }

    const { error: scoreErr } = await adminSupabase.from('weekly_test_scores').upsert(
      {
        test_id: testId,
        student_id: student.id,
        section_id: sectionId,
        correct: nextState.score_row.correct,
        total: nextState.score_row.total,
        time_seconds: nextState.score_row.time_seconds,
        source: 'online',
      },
      { onConflict: 'test_id,student_id,section_id' }
    );

    if (scoreErr) {
      await reopenSession();
      return {
        statusCode: 500,
        payload: {
          error: scoreErr.message || 'Failed to save Flash section score. Please try sending again.',
        },
      };
    }

    const attUpdatePayload = {
      tries_started: nextState.tries_started,
      tries_correct: nextState.tries_correct,
      seconds_used: nextState.seconds_used,
      status: nextState.status,
      claim_token: null,
    };
    if (nextState.done) {
      attUpdatePayload.finished_at = nowIso;
    }

    const { error: attUpdErr } = await adminSupabase
      .from('weekly_test_attempts')
      .update(attUpdatePayload)
      .eq('id', attemptRow.id);

    if (attUpdErr) {
      await reopenSession();
      return {
        statusCode: 500,
        payload: {
          error: attUpdErr.message || 'Failed to update Flash section attempt. Please try again.',
        },
      };
    }

    if (!nextState.done) {
      // Non-final try: return ONLY that the answer was recorded (never reveal correctness or expected sum)
      return {
        statusCode: 200,
        payload: {
          ok: true,
          kind: 'flash',
          recorded: true,
          done: false,
          try_no: nextState.tries_started,
          question_count: questionCount,
          title: testTitle,
        },
      };
    }

    // Final try: return final section score
    return {
      statusCode: 200,
      payload: {
        ok: true,
        kind: 'flash',
        recorded: true,
        done: true,
        try_no: nextState.tries_started,
        question_count: questionCount,
        tries_correct: nextState.tries_correct,
        correct: nextState.score_row.correct,
        total: nextState.score_row.total,
        seconds_used: nextState.seconds_used,
        title: testTitle,
      },
    };
  }

  return {
    statusCode: 400,
    payload: { error: `Unsupported weekly test section kind "${sectionKind}".` },
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
