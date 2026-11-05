/**
 * Trendz Tracker — Phase 17b: Authenticated JMCWC Server API & Lifecycle Engine (api/_jmcwcServer.js)
 *
 * Implements the authoritative server-side session lifecycle and admin APIs
 * backed by the deployed PostgreSQL contract (docs/JMCWC_DATABASE_CONTRACT.json):
 *   1. jmcwc_check_student(uuid)
 *   2. jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb)
 *   3. jmcwc_act(uuid, uuid, text, uuid, bigint, jsonb)
 *   4. jmcwc_list(uuid, integer)
 *   5. jmcwc_finalize(uuid, uuid, bigint, jsonb)
 *   6. jmcwc_validate_marks(text, jsonb, numeric)
 *   (Plus internal database helpers/triggers: jmcwc_tick, jmcwc_assignment_guard, jmcwc_paper_guard)
 *
 * Security & Lifecycle Guarantees:
 * - Every response sets `Cache-Control: no-store`.
 * - Rejects any request passing auth tokens in the URL query string.
 * - Verifies Bearer token via Supabase Auth `getUser`, loads active `profiles` row, and enforces role.
 * - Derives student identity strictly from the verified token; never trusts client-supplied identity,
 *   group, elapsed time, marks, generated questions, or expected answers.
 * - Never exposes `jmcwc_payloads.questions[*].answer_key` to clients.
 * - List and paused responses omit `questions`, `answers`, and `lease_id`.
 * - `lease_id` is returned only to the active caller on explicit `resume` or when the caller already
 *   proves possession of the matching `lease_id`.
 */

import { generateQuestionsFromBlueprint, toPublicQuestions } from './_jmcwcGenerate.js';
import { grade } from './_jmcwcGrade.js';
import { JMCWC_CATEGORY_KEYS, JMCWC_GROUPS as JMCWC_GROUP_KEYS } from './_jmcwcMath.js';
import {
  JMCWC_MAX_PAUSE_BODY_BYTES,
  buildPauseKeepalivePayload,
  sanitizeAnswerPatchObject,
} from './_jmcwcSaveQueue.js';
import { getAdminClient } from './_supabaseAdmin.js';

export { JMCWC_MAX_PAUSE_BODY_BYTES, buildPauseKeepalivePayload };
export const JMCWC_MAX_BODY_BYTES = 256 * 1024; // 256 KB

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HIGH_FREQ_ACTIONS = new Set(['heartbeat', 'save', 'pause', 'read']);

const STUDENT_ACTIONS = new Set([
  'status',
  'init',
  'get_practice_overview',
  'list',
  'list_attempts',
  'create',
  'read',
  'get_attempt_review',
  'resume',
  'save',
  'heartbeat',
  'pause',
  'submit',
]);

const ADMIN_ACTIONS = new Set([
  'admin_get_overview',
  'admin_set_assignment',
  'admin_set_target',
  'admin_set_category_mapping',
  'admin_get_papers',
  'admin_list_attempts',
  'admin_get_attempt_review',
  'admin_get_student_deletion_preview',
  'admin_delete_student_jmcwc_data',
]);

export function isUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val.trim());
}

export function createHttpError(statusCode, message, code = 'JMCWC_ERROR', extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Map database contract exceptions from PostgreSQL RPCs/triggers to accurate HTTP status codes.
 */
export function mapDatabaseErrorToHttp(dbErr) {
  const msg = String(dbErr?.message || dbErr?.details || dbErr || 'Database operation failed.');

  if (msg.includes('An active student account is required.')) {
    return createHttpError(403, 'An active student account is required.', 'INACTIVE_OR_NON_STUDENT');
  }
  if (msg.includes('Ask your teacher to assign your JMCWC group.')) {
    return createHttpError(403, 'Ask your teacher to assign your JMCWC group.', 'GROUP_UNASSIGNED');
  }
  if (msg.includes('No published paper for your assigned group.')) {
    return createHttpError(409, 'No published paper for your assigned group.', 'NO_PUBLISHED_PAPER');
  }
  if (msg.includes('You have three unfinished flat rounds. Complete one before starting another.')) {
    return createHttpError(
      409,
      'You have three unfinished flat rounds. Complete one before starting another.',
      'FLAT_CAP_REACHED'
    );
  }
  if (msg.includes('Round not found.')) {
    return createHttpError(404, 'Round not found.', 'ROUND_NOT_FOUND');
  }
  if (msg.includes('This round belongs to a different assigned group.')) {
    return createHttpError(
      409,
      'This round belongs to a different assigned group.',
      'GROUP_MISMATCH'
    );
  }
  if (msg.includes('Session changed. Reload this round.')) {
    return createHttpError(409, 'Session changed. Reload this round.', 'LEASE_MISMATCH');
  }
  if (msg.includes('Grading snapshot changed.')) {
    return createHttpError(409, 'Grading snapshot changed.', 'GRADING_SNAPSHOT_CHANGED');
  }
  if (msg.includes("Complete this student's unfinished simulator attempts before changing group.")) {
    return createHttpError(
      409,
      "Complete this student's unfinished simulator attempts before changing group.",
      'UNFINISHED_ATTEMPTS_EXIST'
    );
  }
  if (msg.includes('Assign a student account only.')) {
    return createHttpError(400, 'Assign a student account only.', 'INVALID_STUDENT_TARGET');
  }
  if (msg.includes('Published papers are immutable; create a new version.')) {
    return createHttpError(
      409,
      'Published papers are immutable; create a new version.',
      'PAPER_IMMUTABLE'
    );
  }
  if (
    msg.includes('Invalid request.') ||
    msg.includes('Invalid category.') ||
    msg.includes('Unknown action.') ||
    msg.includes('Invalid answer patch.') ||
    msg.includes('Invalid question or answer.') ||
    msg.includes('Invalid generated paper.') ||
    msg.includes('Paper size mismatch.') ||
    msg.includes('Duplicate question IDs or slots.') ||
    msg.includes('Invalid generated question.') ||
    msg.includes('Question does not match the published blueprint.') ||
    msg.includes('Invalid grading output.') ||
    msg.includes('Grade every question exactly once.') ||
    msg.includes('Invalid mark.') ||
    msg.includes('Inconsistent mark or blank-answer classification.')
  ) {
    return createHttpError(400, msg, 'INVALID_REQUEST');
  }

  return createHttpError(500, 'Failed to process JMCWC request.', 'DATABASE_ERROR');
}

/**
 * Grade a frozen attempt's answers in strict alignment with `jmcwc_finalize` in PostgreSQL:
 *   blank := coalesce(btrim(a.answers->>(q->>'id')), '') = ''
 */
export function gradeFrozenAttemptForFinalize(privateQuestions, frozenAnswers = {}) {
  if (!Array.isArray(privateQuestions)) {
    throw new Error('privateQuestions must be an array');
  }
  const safeAnswers =
    frozenAnswers && typeof frozenAnswers === 'object' && !Array.isArray(frozenAnswers)
      ? frozenAnswers
      : {};

  const items = [];
  let marks = 0;
  let maxMarks = 0;
  let correct = 0;
  let partial = 0;
  let wrong = 0;
  let skipped = 0;

  for (const q of privateQuestions) {
    const qId = String(q.id);
    const rawVal = Object.prototype.hasOwnProperty.call(safeAnswers, qId) ? safeAnswers[qId] : null;
    // Match PostgreSQL `coalesce(btrim(a.answers->>(q->>'id')), '') = ''`
    const btrimmed =
      rawVal === null || rawVal === undefined ? '' : String(rawVal).replace(/^ +| +$/g, '');
    const isPgBlank = btrimmed === '';

    let item;
    if (isPgBlank) {
      item = grade(q, '');
    } else {
      const graded = grade(q, String(rawVal));
      // Guarantee non-blank according to Postgres btrim is never classified as 'skipped'
      if (graded.verdict === 'skipped') {
        item = {
          ...graded,
          verdict: 'wrong',
          award: 0,
        };
      } else {
        item = graded;
      }
    }

    items.push({
      question_id: item.question_id,
      award: Number(item.award),
      verdict: item.verdict,
      expected: String(item.expected ?? ''),
      explanation: String(item.explanation ?? ''),
    });

    marks += Number(item.award);
    maxMarks += Number(q.max_marks ?? 0);
    if (item.verdict === 'correct') correct += 1;
    else if (item.verdict === 'partial') partial += 1;
    else if (item.verdict === 'skipped') skipped += 1;
    else wrong += 1;
  }

  return {
    marks,
    max_marks: maxMarks,
    correct,
    partial,
    wrong,
    skipped,
    items,
  };
}

// ============================================================================
// Response Whitelisting Helpers
// ============================================================================

export function computeQuestionsMaxMarks(questions) {
  if (!Array.isArray(questions)) return null;
  return questions.reduce((sum, q) => sum + Number(q?.max_marks ?? 0), 0);
}

/**
 * Count non-blank answers in an answers object (`coalesce(btrim(val), '') <> ''`)
 * without exposing the underlying answer values.
 */
export function countAnsweredEntries(answersObj) {
  if (!answersObj || typeof answersObj !== 'object' || Array.isArray(answersObj)) {
    return 0;
  }
  let count = 0;
  for (const val of Object.values(answersObj)) {
    if (val === null || val === undefined) continue;
    if (String(val).replace(/^ +| +$/g, '') !== '') {
      count += 1;
    }
  }
  return count;
}

export function formatScoreSummary(scoreRow) {
  if (!scoreRow) return null;
  return {
    marks: Number(scoreRow.marks),
    max_marks: Number(scoreRow.max_marks),
    correct: Number(scoreRow.correct),
    partial: Number(scoreRow.partial),
    wrong: Number(scoreRow.wrong),
    skipped: Number(scoreRow.skipped),
    created_at: scoreRow.created_at || null,
  };
}

/**
 * Whitelist an attempt row for list responses.
 * Strictly omits `questions`, `answers`, `last_seen_at`, and `lease_id`.
 */
export function whitelistAttemptForList(
  attempt,
  maxMarks = null,
  scoreRow = null,
  questionCount = null
) {
  const resolvedMaxMarks =
    scoreRow?.max_marks !== undefined
      ? Number(scoreRow.max_marks)
      : maxMarks !== null && maxMarks !== undefined
        ? Number(maxMarks)
        : null;
  const resolvedQuestionCount =
    questionCount !== null && questionCount !== undefined
      ? Number(questionCount)
      : attempt.mode === 'flat'
        ? 230
        : 10;
  const scoreSummary = attempt.status === 'submitted' ? formatScoreSummary(scoreRow) : null;

  const base = {
    id: attempt.id,
    student_id: attempt.student_id,
    request_id: attempt.request_id,
    paper_id: attempt.paper_id,
    group_key: attempt.group_key,
    mode: attempt.mode,
    category_key: attempt.category_key ?? null,
    status: attempt.status,
    active_ms: Number(attempt.active_ms ?? 0),
    target_seconds: attempt.target_seconds ?? null,
    save_seq: Number(attempt.save_seq ?? -1),
    revision: Number(attempt.revision ?? 0),
    answered_count: countAnsweredEntries(attempt.answers),
    question_count: resolvedQuestionCount,
    created_at: attempt.created_at,
    finished_at: attempt.finished_at ?? null,
    submitted_reason: attempt.submitted_reason ?? null,
    max_marks: resolvedMaxMarks,
    score_summary: scoreSummary,
    score: scoreSummary,
  };
  return base;
}

/**
 * Whitelist a paused attempt response.
 * Strictly omits `questions`, `answers`, `last_seen_at`, and `lease_id`.
 */
export function whitelistAttemptForPaused(attempt, maxMarks = null, questionCount = null) {
  const resolvedQuestionCount =
    questionCount !== null && questionCount !== undefined
      ? Number(questionCount)
      : attempt.mode === 'flat'
        ? 230
        : 10;
  return {
    id: attempt.id,
    student_id: attempt.student_id,
    request_id: attempt.request_id,
    paper_id: attempt.paper_id,
    group_key: attempt.group_key,
    mode: attempt.mode,
    category_key: attempt.category_key ?? null,
    status: 'paused',
    active_ms: Number(attempt.active_ms ?? 0),
    target_seconds: attempt.target_seconds ?? null,
    save_seq: Number(attempt.save_seq ?? -1),
    revision: Number(attempt.revision ?? 0),
    answered_count: countAnsweredEntries(attempt.answers),
    question_count: resolvedQuestionCount,
    created_at: attempt.created_at,
    finished_at: attempt.finished_at ?? null,
    submitted_reason: attempt.submitted_reason ?? null,
    max_marks: maxMarks !== null && maxMarks !== undefined ? Number(maxMarks) : null,
  };
}

/**
 * Whitelist a running attempt response.
 * `lease_id`, public `questions`, and `answers` are included ONLY when `includeLeaseAndPayload` is true
 * (i.e. on explicit `resume` or when the caller already proved possession of the active `lease_id`).
 */
export function whitelistAttemptForRunning(
  attempt,
  maxMarks = null,
  { includeLeaseAndPayload = false, privateQuestions = null } = {}
) {
  const resolvedQuestionCount = Array.isArray(privateQuestions)
    ? privateQuestions.length
    : attempt.mode === 'flat'
      ? 230
      : 10;
  const base = {
    id: attempt.id,
    student_id: attempt.student_id,
    request_id: attempt.request_id,
    paper_id: attempt.paper_id,
    group_key: attempt.group_key,
    mode: attempt.mode,
    category_key: attempt.category_key ?? null,
    status: 'running',
    active_ms: Number(attempt.active_ms ?? 0),
    target_seconds: attempt.target_seconds ?? null,
    save_seq: Number(attempt.save_seq ?? -1),
    revision: Number(attempt.revision ?? 0),
    answered_count: countAnsweredEntries(attempt.answers),
    question_count: resolvedQuestionCount,
    created_at: attempt.created_at,
    finished_at: attempt.finished_at ?? null,
    submitted_reason: attempt.submitted_reason ?? null,
    max_marks: maxMarks !== null && maxMarks !== undefined ? Number(maxMarks) : null,
  };

  if (!includeLeaseAndPayload) {
    return {
      ...base,
      has_active_lease: Boolean(attempt.lease_id),
    };
  }

  return {
    ...base,
    lease_id: attempt.lease_id,
    answers: attempt.answers ? { ...attempt.answers } : {},
    ...(Array.isArray(privateQuestions) ? { questions: toPublicQuestions(privateQuestions) } : {}),
  };
}

/**
 * Whitelist a submitted attempt response with full review details.
 * Never includes `answer_key` or `lease_id`.
 */
export function whitelistAttemptForSubmitted(attempt, scoreRow, privateQuestions = []) {
  const publicQuestions = Array.isArray(privateQuestions)
    ? toPublicQuestions(privateQuestions)
    : [];
  const scoreItemsMap = new Map();
  if (scoreRow && Array.isArray(scoreRow.items)) {
    for (const item of scoreRow.items) {
      scoreItemsMap.set(String(item.question_id), item);
    }
  }
  const savedAnswers = attempt.answers && typeof attempt.answers === 'object' ? attempt.answers : {};

  const review = publicQuestions.map((pubQ) => {
    const graded = scoreItemsMap.get(pubQ.id) || {
      question_id: pubQ.id,
      award: 0,
      verdict: 'skipped',
      expected: '',
      explanation: '',
    };
    return {
      id: pubQ.id,
      category_key: pubQ.category_key,
      slot: pubQ.slot,
      max_marks: pubQ.max_marks,
      prompt: pubQ.prompt,
      input: pubQ.input,
      student_answer: Object.prototype.hasOwnProperty.call(savedAnswers, pubQ.id)
        ? savedAnswers[pubQ.id]
        : null,
      award: Number(graded.award ?? 0),
      verdict: graded.verdict,
      expected: String(graded.expected ?? ''),
      explanation: String(graded.explanation ?? ''),
    };
  });

  const scoreSummary = formatScoreSummary(scoreRow);

  return {
    id: attempt.id,
    student_id: attempt.student_id,
    request_id: attempt.request_id,
    paper_id: attempt.paper_id,
    group_key: attempt.group_key,
    mode: attempt.mode,
    category_key: attempt.category_key ?? null,
    status: 'submitted',
    active_ms: Number(attempt.active_ms ?? 0),
    target_seconds: attempt.target_seconds ?? null,
    save_seq: Number(attempt.save_seq ?? -1),
    revision: Number(attempt.revision ?? 0),
    created_at: attempt.created_at,
    finished_at: attempt.finished_at ?? null,
    submitted_reason: attempt.submitted_reason ?? null,
    max_marks: scoreSummary ? scoreSummary.max_marks : computeQuestionsMaxMarks(privateQuestions),
    score: scoreSummary,
    questions: publicQuestions,
    answers: { ...savedAnswers },
    review,
  };
}

// ============================================================================
// Rate Limiter Factory (Compatible with 10-second heartbeats)
// ============================================================================

export function createJmcwcRateLimiter({
  windowMs = 60_000,
  maxHighFreq = 120,
  maxStandard = 40,
  nowFn = () => Date.now(),
} = {}) {
  const buckets = new Map();

  function checkLimit(userId, action) {
    const isHighFreq = HIGH_FREQ_ACTIONS.has(action);
    const key = `${userId}:${isHighFreq ? 'hf' : 'std'}`;
    const limit = isHighFreq ? maxHighFreq : maxStandard;
    const now = nowFn();

    let entry = buckets.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      throw createHttpError(
        429,
        'Too many JMCWC requests. Please wait a moment and try again.',
        'RATE_LIMITED'
      );
    }
  }

  return { checkLimit };
}

// ============================================================================
// Core Server Lifecycle & Admin Engine
// ============================================================================

export function createJmcwcServer({
  getSupabaseAdmin = () => getAdminClient(),
  rateLimiter = createJmcwcRateLimiter(),
  seedGenerator = null,
} = {}) {
  /**
   * Fetch private questions for an attempt from `jmcwc_payloads`.
   */
  async function fetchAttemptQuestions(supabase, attemptId) {
    const { data, error } = await supabase
      .from('jmcwc_payloads')
      .select('questions')
      .eq('attempt_id', attemptId)
      .single();
    if (error || !data || !Array.isArray(data.questions)) {
      throw createHttpError(500, 'Failed to load attempt question payload.', 'PAYLOAD_NOT_FOUND');
    }
    return data.questions;
  }

  /**
   * Fetch max_marks, question_count, and score maps for a list of attempt IDs from `jmcwc_payloads` and `jmcwc_scores`.
   */
  async function fetchAttemptsMetadataMaps(supabase, attempts) {
    if (!Array.isArray(attempts) || attempts.length === 0) {
      return { maxMarksMap: new Map(), scoresMap: new Map(), questionCountMap: new Map() };
    }
    const ids = attempts.map((a) => a.id);

    const [{ data: scoreRows }, { data: payloadRows }] = await Promise.all([
      supabase
        .from('jmcwc_scores')
        .select('attempt_id, marks, max_marks, correct, partial, wrong, skipped, created_at')
        .in('attempt_id', ids),
      supabase
        .from('jmcwc_payloads')
        .select('attempt_id, questions')
        .in('attempt_id', ids),
    ]);

    const scoresMap = new Map();
    if (Array.isArray(scoreRows)) {
      for (const row of scoreRows) {
        scoresMap.set(row.attempt_id, row);
      }
    }

    const maxMarksMap = new Map();
    const questionCountMap = new Map();
    if (Array.isArray(payloadRows)) {
      for (const row of payloadRows) {
        maxMarksMap.set(row.attempt_id, computeQuestionsMaxMarks(row.questions));
        questionCountMap.set(
          row.attempt_id,
          Array.isArray(row.questions) ? row.questions.length : null
        );
      }
    }

    return { maxMarksMap, scoresMap, questionCountMap };
  }

  /**
   * Settle an attempt in `status = 'grading'` by grading the frozen database `answers`
   * against persisted private `jmcwc_payloads.questions` and calling `jmcwc_finalize`.
   * Safe for idempotent retries if a previous finalize attempt failed mid-flight.
   */
  async function settleGradingAttempt(supabase, studentId, attemptObj) {
    const privateQuestions = await fetchAttemptQuestions(supabase, attemptObj.id);

    if (attemptObj.status === 'grading') {
      const graded = gradeFrozenAttemptForFinalize(privateQuestions, attemptObj.answers);
      const { error: finalizeError } = await supabase.rpc('jmcwc_finalize', {
        p_student: studentId,
        p_attempt: attemptObj.id,
        p_revision: Number(attemptObj.revision),
        p_items: graded.items,
      });
      if (finalizeError) {
        throw mapDatabaseErrorToHttp(finalizeError);
      }
    }

    const [{ data: updatedAttempt, error: attErr }, { data: scoreRow, error: scoreErr }] =
      await Promise.all([
        supabase
          .from('jmcwc_attempts')
          .select('*')
          .eq('id', attemptObj.id)
          .eq('student_id', studentId)
          .single(),
        supabase.from('jmcwc_scores').select('*').eq('attempt_id', attemptObj.id).single(),
      ]);

    if (attErr || !updatedAttempt || scoreErr || !scoreRow) {
      throw createHttpError(500, 'Failed to load finalized attempt score.', 'FINALIZE_READ_ERROR');
    }

    return {
      attempt: updatedAttempt,
      score: scoreRow,
      privateQuestions,
    };
  }

  /**
   * Verify Bearer token and load active profile from `public.profiles`.
   */
  async function authenticateCaller(supabase, req) {
    // Reject tokens in URL query parameters
    const rawUrl = String(req?.url || req?.originalUrl || '');
    const qIdx = rawUrl.indexOf('?');
    if (qIdx !== -1) {
      const searchParams = new URLSearchParams(rawUrl.slice(qIdx + 1));
      for (const key of searchParams.keys()) {
        const lower = key.toLowerCase();
        if (
          lower === 'token' ||
          lower === 'access_token' ||
          lower === 'bearer' ||
          lower === 'jwt' ||
          lower === 'auth'
        ) {
          throw createHttpError(
            400,
            'Authentication tokens must not be passed in URLs.',
            'TOKEN_IN_URL_FORBIDDEN'
          );
        }
      }
    }
    if (req?.query && typeof req.query === 'object') {
      for (const key of Object.keys(req.query)) {
        const lower = key.toLowerCase();
        if (
          lower === 'token' ||
          lower === 'access_token' ||
          lower === 'bearer' ||
          lower === 'jwt' ||
          lower === 'auth'
        ) {
          throw createHttpError(
            400,
            'Authentication tokens must not be passed in URLs.',
            'TOKEN_IN_URL_FORBIDDEN'
          );
        }
      }
    }

    let authHeader = '';
    if (req?.headers) {
      if (typeof req.headers.get === 'function') {
        authHeader = req.headers.get('authorization') || '';
      } else {
        authHeader = req.headers.authorization || req.headers.Authorization || '';
      }
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createHttpError(401, 'Unauthorized: Missing or invalid Bearer token.', 'UNAUTHORIZED');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw createHttpError(401, 'Unauthorized: Missing or invalid Bearer token.', 'UNAUTHORIZED');
    }

    const { data: authData, error: userError } = await supabase.auth.getUser(token);
    const user = authData?.user;
    if (userError || !user || !user.id) {
      throw createHttpError(
        401,
        'Unauthorized: Invalid or expired authentication session.',
        'UNAUTHORIZED'
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, student_code, full_name, role, level, active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      throw createHttpError(403, 'Forbidden: Profile not found.', 'PROFILE_NOT_FOUND');
    }

    if (!profile.active) {
      throw createHttpError(403, 'Forbidden: Account is inactive.', 'ACCOUNT_INACTIVE');
    }

    return profile;
  }

  // ==========================================================================
  // Student Lifecycle Handlers
  // ==========================================================================

  async function handleStudentList(supabase, studentId, body) {
    const offset = Math.max(0, Math.min(Number(body?.offset) || 0, 100000));
    const { data: rows, error } = await supabase.rpc('jmcwc_list', {
      p_student: studentId,
      p_offset: offset,
    });
    if (error) {
      throw mapDatabaseErrorToHttp(error);
    }

    const attemptRows = Array.isArray(rows) ? rows : [];
    const settledAttempts = [];
    for (const row of attemptRows) {
      if (row.status === 'grading') {
        const settled = await settleGradingAttempt(supabase, studentId, row);
        settledAttempts.push(settled.attempt);
      } else {
        settledAttempts.push(row);
      }
    }

    const { maxMarksMap, scoresMap, questionCountMap } = await fetchAttemptsMetadataMaps(
      supabase,
      settledAttempts
    );
    return settledAttempts.map((a) =>
      whitelistAttemptForList(
        a,
        maxMarksMap.get(a.id) ?? null,
        scoresMap.get(a.id) ?? null,
        questionCountMap.get(a.id) ?? null
      )
    );
  }

  async function handleStudentStatus(supabase, studentId, body) {
    const { data: assignmentRow } = await supabase
      .from('jmcwc_assignments')
      .select('student_id, group_key, updated_at')
      .eq('student_id', studentId)
      .maybeSingle();

    const { data: categories } = await supabase
      .from('jmcwc_categories')
      .select('key, label, workbook_sheet, position, legacy_category_id')
      .order('position', { ascending: true });

    if (!assignmentRow || !assignmentRow.group_key) {
      return {
        assigned: false,
        group_key: null,
        blocked: true,
        message: 'Ask your teacher to assign your JMCWC group.',
        paper_available: false,
        paper: null,
        categories: categories || [],
        targets: {},
        attempts: [],
      };
    }

    const { data: checkedGroup, error: checkErr } = await supabase.rpc('jmcwc_check_student', {
      p_student: studentId,
    });
    if (checkErr) {
      throw mapDatabaseErrorToHttp(checkErr);
    }

    const groupKey = checkedGroup || assignmentRow.group_key;

    const [{ data: publishedPapers }, { data: targetRows }, attempts] = await Promise.all([
      supabase
        .from('jmcwc_papers')
        .select('id, group_key, version, published, created_at, spec')
        .eq('group_key', groupKey)
        .eq('published', true)
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('jmcwc_targets')
        .select('group_key, category_key, target_seconds')
        .eq('group_key', groupKey),
      handleStudentList(supabase, studentId, body),
    ]);

    const publishedPaper =
      Array.isArray(publishedPapers) && publishedPapers.length > 0 ? publishedPapers[0] : null;

    const totalQuestions =
      Number(publishedPaper?.spec?.total_questions) ||
      (publishedPaper?.spec?.sections
        ? publishedPaper.spec.sections.reduce(
            (acc, s) =>
              acc +
              (Array.isArray(s.questions)
                ? s.questions.length
                : Array.isArray(s.slots)
                  ? s.slots.length
                  : Number(s.question_count) || 0),
            0
          )
        : null);

    const paperSections =
      publishedPaper?.spec?.sections?.map((s) => ({
        key: s.key,
        title: s.title || s.label,
        category_key: s.category_key || s.key,
        question_count: Array.isArray(s.questions)
          ? s.questions.length
          : Array.isArray(s.slots)
            ? s.slots.length
            : Number(s.question_count) || 0,
      })) || [];

    const targetsMap = {};
    if (Array.isArray(targetRows)) {
      for (const t of targetRows) {
        if (t.target_seconds !== null && t.target_seconds !== undefined) {
          targetsMap[t.category_key] = Number(t.target_seconds);
        }
      }
    }

    const unfinishedFlatCount = attempts.filter(
      (a) => a.mode === 'flat' && a.status !== 'submitted'
    ).length;

    return {
      assigned: true,
      group_key: groupKey,
      blocked: false,
      message: publishedPaper ? null : 'No published paper for your assigned group.',
      paper_available: Boolean(publishedPaper),
      paper: publishedPaper
        ? {
            id: publishedPaper.id,
            group_key: publishedPaper.group_key,
            version: publishedPaper.version,
            total_questions: totalQuestions,
            question_count: totalQuestions,
            sections: paperSections,
          }
        : null,
      unfinished_flat_count: unfinishedFlatCount,
      flat_cap_limit: 3,
      categories: categories || [],
      targets: targetsMap,
      attempts,
    };
  }

  async function handleStudentCreate(supabase, studentId, body) {
    const requestId = body?.request_id;
    const mode = body?.mode;
    const categoryKey = body?.category_key ?? null;

    if (!isUuid(requestId)) {
      throw createHttpError(400, 'Invalid request: request_id must be a UUID.', 'INVALID_REQUEST');
    }
    if (mode !== 'flat' && mode !== 'category') {
      throw createHttpError(
        400,
        'Invalid request: mode must be "flat" or "category".',
        'INVALID_REQUEST'
      );
    }
    if (mode === 'flat' && categoryKey !== null && categoryKey !== undefined) {
      throw createHttpError(400, 'Invalid category.', 'INVALID_REQUEST');
    }
    if (mode === 'category' && (!categoryKey || !JMCWC_CATEGORY_KEYS.includes(categoryKey))) {
      throw createHttpError(400, 'Invalid category.', 'INVALID_REQUEST');
    }

    // Verify active student and get assigned group via contract RPC
    const { data: assignedGroup, error: checkErr } = await supabase.rpc('jmcwc_check_student', {
      p_student: studentId,
    });
    if (checkErr) {
      throw mapDatabaseErrorToHttp(checkErr);
    }

    // Check if (student_id, request_id) already exists for idempotent retry
    const { data: existingAttempt } = await supabase
      .from('jmcwc_attempts')
      .select('*')
      .eq('student_id', studentId)
      .eq('request_id', requestId)
      .maybeSingle();

    if (existingAttempt) {
      const privateQuestions = await fetchAttemptQuestions(supabase, existingAttempt.id);
      const maxMarks = computeQuestionsMaxMarks(privateQuestions);
      return {
        idempotent_replay: true,
        attempt: whitelistAttemptForPaused(
          existingAttempt,
          maxMarks,
          Array.isArray(privateQuestions) ? privateQuestions.length : null
        ),
      };
    }

    // Select published paper for assigned group (reject unpublished papers!)
    let paperQuery = supabase
      .from('jmcwc_papers')
      .select('id, group_key, version, spec, published, created_at')
      .eq('group_key', assignedGroup)
      .eq('published', true);

    if (body?.paper_id) {
      if (!isUuid(body.paper_id)) {
        throw createHttpError(400, 'Invalid paper_id.', 'INVALID_REQUEST');
      }
      paperQuery = paperQuery.eq('id', body.paper_id);
    } else {
      paperQuery = paperQuery.order('created_at', { ascending: false }).limit(1);
    }

    const { data: paperRows, error: paperErr } = await paperQuery;
    if (paperErr || !Array.isArray(paperRows) || paperRows.length === 0) {
      throw createHttpError(
        409,
        'No published paper for your assigned group.',
        'NO_PUBLISHED_PAPER'
      );
    }
    const paper = paperRows[0];
    if (!paper.published || paper.group_key !== assignedGroup) {
      throw createHttpError(
        409,
        'No published paper for your assigned group.',
        'NO_PUBLISHED_PAPER'
      );
    }

    const seed = typeof seedGenerator === 'function' ? seedGenerator({ studentId, requestId }) : null;
    const { privateQuestions, total_max_marks } = generateQuestionsFromBlueprint(paper.spec, {
      mode,
      categoryKey: mode === 'category' ? categoryKey : null,
      seed,
    });

    const { data: attemptId, error: createErr } = await supabase.rpc('jmcwc_create_attempt', {
      p_student: studentId,
      p_request: requestId,
      p_paper: paper.id,
      p_mode: mode,
      p_category: mode === 'category' ? categoryKey : null,
      p_questions: privateQuestions,
    });
    if (createErr) {
      throw mapDatabaseErrorToHttp(createErr);
    }

    const { data: createdAttempt, error: loadErr } = await supabase
      .from('jmcwc_attempts')
      .select('*')
      .eq('id', attemptId)
      .eq('student_id', studentId)
      .single();

    if (loadErr || !createdAttempt) {
      throw createHttpError(500, 'Failed to load created attempt.', 'CREATE_LOAD_ERROR');
    }

    return {
      idempotent_replay: false,
      attempt: whitelistAttemptForPaused(
        createdAttempt,
        total_max_marks,
        privateQuestions.length
      ),
    };
  }

  async function handleStudentRead(supabase, studentId, body) {
    const attemptId = body?.attempt_id;
    const callerLeaseId = body?.lease_id ?? null;

    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }
    if (callerLeaseId !== null && !isUuid(callerLeaseId)) {
      throw createHttpError(400, 'Invalid lease_id.', 'INVALID_REQUEST');
    }

    const { data: actResult, error: actErr } = await supabase.rpc('jmcwc_act', {
      p_student: studentId,
      p_attempt: attemptId,
      p_action: 'read',
      p_lease: null,
      p_seq: null,
      p_answers: null,
    });
    if (actErr) {
      throw mapDatabaseErrorToHttp(actErr);
    }

    if (actResult.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, studentId, actResult);
      return {
        attempt: whitelistAttemptForSubmitted(
          settled.attempt,
          settled.score,
          settled.privateQuestions
        ),
      };
    }

    const privateQuestions = await fetchAttemptQuestions(supabase, actResult.id);
    const maxMarks = computeQuestionsMaxMarks(privateQuestions);

    if (actResult.status === 'submitted') {
      const { data: scoreRow, error: scoreErr } = await supabase
        .from('jmcwc_scores')
        .select('*')
        .eq('attempt_id', actResult.id)
        .single();
      if (scoreErr || !scoreRow) {
        throw createHttpError(500, 'Submitted score record not found.', 'SCORE_NOT_FOUND');
      }
      return {
        attempt: whitelistAttemptForSubmitted(actResult, scoreRow, privateQuestions),
      };
    }

    if (actResult.status === 'paused') {
      return {
        attempt: whitelistAttemptForPaused(actResult, maxMarks, privateQuestions.length),
      };
    }

    // status === 'running': only return lease_id, questions, and answers if caller already holds the active lease
    const hasMatchingLease = Boolean(
      callerLeaseId && actResult.lease_id && callerLeaseId === actResult.lease_id
    );
    return {
      attempt: whitelistAttemptForRunning(actResult, maxMarks, {
        includeLeaseAndPayload: hasMatchingLease,
        privateQuestions: hasMatchingLease ? privateQuestions : null,
      }),
    };
  }

  async function handleStudentResume(supabase, studentId, body) {
    const attemptId = body?.attempt_id;
    const confirmTakeover = body?.confirm_takeover === true;

    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }

    // Check if another attempt is currently running for this student so we can require explicit takeover confirmation
    const { data: runningRows } = await supabase
      .from('jmcwc_attempts')
      .select('id, status, lease_id')
      .eq('student_id', studentId)
      .eq('status', 'running');

    if (Array.isArray(runningRows)) {
      for (const other of runningRows) {
        // Tick the running attempt via 'read' to verify whether it is still running or already timed out / expired
        const { data: tickedOther } = await supabase.rpc('jmcwc_act', {
          p_student: studentId,
          p_attempt: other.id,
          p_action: 'read',
          p_lease: null,
          p_seq: null,
          p_answers: null,
        });
        if (tickedOther && tickedOther.status === 'grading') {
          await settleGradingAttempt(supabase, studentId, tickedOther);
        } else if (
          tickedOther &&
          tickedOther.status === 'running' &&
          !confirmTakeover &&
          (other.id !== attemptId || !body?.lease_id || body.lease_id !== tickedOther.lease_id)
        ) {
          throw createHttpError(
            409,
            'Another simulator round is currently active. Confirm takeover to pause it and resume this round.',
            'TAKEOVER_CONFIRMATION_REQUIRED',
            { running_attempt_id: other.id }
          );
        }
      }
    }

    const { data: resumed, error: resumeErr } = await supabase.rpc('jmcwc_act', {
      p_student: studentId,
      p_attempt: attemptId,
      p_action: 'resume',
      p_lease: null,
      p_seq: null,
      p_answers: null,
    });
    if (resumeErr) {
      throw mapDatabaseErrorToHttp(resumeErr);
    }

    if (resumed.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, studentId, resumed);
      return {
        attempt: whitelistAttemptForSubmitted(
          settled.attempt,
          settled.score,
          settled.privateQuestions
        ),
      };
    }

    const privateQuestions = await fetchAttemptQuestions(supabase, resumed.id);
    const maxMarks = computeQuestionsMaxMarks(privateQuestions);

    if (resumed.status === 'submitted') {
      const { data: scoreRow } = await supabase
        .from('jmcwc_scores')
        .select('*')
        .eq('attempt_id', resumed.id)
        .single();
      return {
        attempt: whitelistAttemptForSubmitted(resumed, scoreRow, privateQuestions),
      };
    }

    return {
      attempt: whitelistAttemptForRunning(resumed, maxMarks, {
        includeLeaseAndPayload: true,
        privateQuestions,
      }),
    };
  }

  async function handleStudentSaveOrHeartbeat(supabase, studentId, body, action) {
    const attemptId = body?.attempt_id;
    const leaseId = body?.lease_id;
    const rawSeq = body?.save_seq ?? body?.seq ?? null;
    const rawAnswers = body?.answers ?? body?.patch ?? null;

    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }
    if (!isUuid(leaseId)) {
      throw createHttpError(400, 'Invalid lease_id.', 'INVALID_REQUEST');
    }

    let cleanAnswers = null;
    let cleanSeq = null;
    if (rawAnswers !== null && rawAnswers !== undefined) {
      try {
        cleanAnswers = sanitizeAnswerPatchObject(rawAnswers);
      } catch (err) {
        throw createHttpError(400, err.message, 'INVALID_REQUEST');
      }
      if (rawSeq === null || rawSeq === undefined || !Number.isInteger(Number(rawSeq)) || Number(rawSeq) < 0) {
        throw createHttpError(400, 'Invalid answer patch.', 'INVALID_REQUEST');
      }
      cleanSeq = Number(rawSeq);
    } else if (action === 'save') {
      throw createHttpError(400, 'Invalid answer patch.', 'INVALID_REQUEST');
    }

    const { data: updated, error: actErr } = await supabase.rpc('jmcwc_act', {
      p_student: studentId,
      p_attempt: attemptId,
      p_action: action,
      p_lease: leaseId,
      p_seq: cleanSeq,
      p_answers: cleanAnswers,
    });
    if (actErr) {
      throw mapDatabaseErrorToHttp(actErr);
    }

    // If tick inside jmcwc_act expired a flat round to 'grading', finalize immediately
    if (updated.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, studentId, updated);
      return {
        expired: true,
        attempt: whitelistAttemptForSubmitted(
          settled.attempt,
          settled.score,
          settled.privateQuestions
        ),
      };
    }

    const privateQuestions = await fetchAttemptQuestions(supabase, updated.id);
    const maxMarks = computeQuestionsMaxMarks(privateQuestions);

    if (updated.status === 'submitted') {
      const { data: scoreRow } = await supabase
        .from('jmcwc_scores')
        .select('*')
        .eq('attempt_id', updated.id)
        .single();
      return {
        attempt: whitelistAttemptForSubmitted(updated, scoreRow, privateQuestions),
      };
    }

    if (updated.status === 'paused') {
      throw createHttpError(
        409,
        'Round is paused (heartbeat timeout or paused in another session). Resume to continue.',
        'SESSION_PAUSED',
        { attempt: whitelistAttemptForPaused(updated, maxMarks, privateQuestions.length) }
      );
    }

    return {
      attempt: whitelistAttemptForRunning(updated, maxMarks, {
        includeLeaseAndPayload: true,
        privateQuestions: null,
      }),
    };
  }

  async function handleStudentPause(supabase, studentId, body, rawBodyBytes) {
    if (rawBodyBytes > JMCWC_MAX_PAUSE_BODY_BYTES) {
      throw createHttpError(
        413,
        'Pause payload exceeds 48KB keepalive limit.',
        'PAUSE_PAYLOAD_TOO_LARGE'
      );
    }

    const attemptId = body?.attempt_id;
    const leaseId = body?.lease_id ?? null;
    const rawSeq = body?.save_seq ?? body?.seq ?? null;
    const rawAnswers = body?.answers ?? body?.patch ?? null;

    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }
    if (leaseId !== null && !isUuid(leaseId)) {
      throw createHttpError(400, 'Invalid lease_id.', 'INVALID_REQUEST');
    }

    let cleanAnswers = null;
    let cleanSeq = null;
    if (rawAnswers !== null && rawAnswers !== undefined) {
      try {
        cleanAnswers = sanitizeAnswerPatchObject(rawAnswers);
      } catch (err) {
        throw createHttpError(400, err.message, 'INVALID_REQUEST');
      }
      if (rawSeq === null || rawSeq === undefined || !Number.isInteger(Number(rawSeq)) || Number(rawSeq) < 0) {
        throw createHttpError(400, 'Invalid answer patch.', 'INVALID_REQUEST');
      }
      cleanSeq = Number(rawSeq);
    }

    const { data: updated, error: actErr } = await supabase.rpc('jmcwc_act', {
      p_student: studentId,
      p_attempt: attemptId,
      p_action: 'pause',
      p_lease: leaseId,
      p_seq: cleanSeq,
      p_answers: cleanAnswers,
    });
    if (actErr) {
      throw mapDatabaseErrorToHttp(actErr);
    }

    if (updated.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, studentId, updated);
      return {
        expired: true,
        attempt: whitelistAttemptForSubmitted(
          settled.attempt,
          settled.score,
          settled.privateQuestions
        ),
      };
    }

    const privateQuestions = await fetchAttemptQuestions(supabase, updated.id);
    const maxMarks = computeQuestionsMaxMarks(privateQuestions);

    if (updated.status === 'submitted') {
      const { data: scoreRow } = await supabase
        .from('jmcwc_scores')
        .select('*')
        .eq('attempt_id', updated.id)
        .single();
      return {
        attempt: whitelistAttemptForSubmitted(updated, scoreRow, privateQuestions),
      };
    }

    return {
      attempt: whitelistAttemptForPaused(updated, maxMarks, privateQuestions.length),
    };
  }

  async function handleStudentSubmit(supabase, studentId, body) {
    const attemptId = body?.attempt_id;
    const leaseId = body?.lease_id ?? null;
    const rawSeq = body?.save_seq ?? body?.seq ?? null;
    const rawAnswers = body?.answers ?? body?.patch ?? null;

    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }
    if (leaseId !== null && !isUuid(leaseId)) {
      throw createHttpError(400, 'Invalid lease_id.', 'INVALID_REQUEST');
    }

    let cleanAnswers = null;
    let cleanSeq = null;
    if (rawAnswers !== null && rawAnswers !== undefined) {
      try {
        cleanAnswers = sanitizeAnswerPatchObject(rawAnswers);
      } catch (err) {
        throw createHttpError(400, err.message, 'INVALID_REQUEST');
      }
      if (rawSeq === null || rawSeq === undefined || !Number.isInteger(Number(rawSeq)) || Number(rawSeq) < 0) {
        throw createHttpError(400, 'Invalid answer patch.', 'INVALID_REQUEST');
      }
      cleanSeq = Number(rawSeq);
    }

    const { data: updated, error: actErr } = await supabase.rpc('jmcwc_act', {
      p_student: studentId,
      p_attempt: attemptId,
      p_action: 'submit',
      p_lease: leaseId,
      p_seq: cleanSeq,
      p_answers: cleanAnswers,
    });
    if (actErr) {
      throw mapDatabaseErrorToHttp(actErr);
    }

    if (updated.status === 'paused') {
      const privateQuestions = await fetchAttemptQuestions(supabase, updated.id);
      const maxMarks = computeQuestionsMaxMarks(privateQuestions);
      throw createHttpError(
        409,
        'Round is paused. Resume the round before submitting.',
        'ROUND_PAUSED',
        { attempt: whitelistAttemptForPaused(updated, maxMarks, privateQuestions.length) }
      );
    }

    if (updated.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, studentId, updated);
      return {
        attempt: whitelistAttemptForSubmitted(
          settled.attempt,
          settled.score,
          settled.privateQuestions
        ),
      };
    }

    if (updated.status === 'submitted') {
      const privateQuestions = await fetchAttemptQuestions(supabase, updated.id);
      const { data: scoreRow, error: scoreErr } = await supabase
        .from('jmcwc_scores')
        .select('*')
        .eq('attempt_id', updated.id)
        .single();
      if (scoreErr || !scoreRow) {
        throw createHttpError(500, 'Submitted score record not found.', 'SCORE_NOT_FOUND');
      }
      return {
        attempt: whitelistAttemptForSubmitted(updated, scoreRow, privateQuestions),
      };
    }

    throw createHttpError(500, 'Unexpected attempt status after submit.', 'SUBMIT_STATE_ERROR');
  }

  // ==========================================================================
  // Admin Handlers
  // ==========================================================================

  function summarizePaperRow(paper) {
    const sections = Array.isArray(paper?.spec?.sections) ? paper.spec.sections : [];
    let totalSlots = 0;
    let baselineMarks = 0;
    let dynamicSlots = 0;
    for (const sec of sections) {
      const qs = Array.isArray(sec?.questions) ? sec.questions : [];
      totalSlots += qs.length;
      for (const q of qs) {
        baselineMarks += Number(q?.max_marks ?? 0);
        if (q?.parameters?.scoring_mode === 'dynamic') {
          dynamicSlots += 1;
        }
      }
    }
    return {
      id: paper.id,
      group_key: paper.group_key,
      version: paper.version,
      title: paper?.spec?.title || `${paper.group_key} (${paper.version})`,
      published: Boolean(paper.published),
      created_at: paper.created_at,
      section_count: sections.length,
      slot_count: totalSlots,
      question_count: totalSlots,
      baseline_marks: baselineMarks,
      baseline_max_marks: baselineMarks,
      dynamic_slot_count: dynamicSlots,
      source_workbook: paper?.spec?.source_workbook || 'JMCWC 2026 Simulator (version 1).xlsm',
    };
  }

  async function handleAdminOverview(supabase) {
    const [
      { data: studentProfiles },
      { data: assignments },
      { data: categories },
      { data: legacyRoundCategories },
      { data: targets },
      { data: papers },
      { data: allAttempts },
    ] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, student_code, full_name, role, level, active')
        .eq('role', 'student')
        .order('student_code', { ascending: true }),
      supabase.from('jmcwc_assignments').select('student_id, group_key, updated_at'),
      supabase
        .from('jmcwc_categories')
        .select('key, label, workbook_sheet, position, legacy_category_id')
        .order('position', { ascending: true }),
      supabase
        .from('categories')
        .select('id, name, section')
        .eq('section', 'round')
        .order('name', { ascending: true }),
      supabase.from('jmcwc_targets').select('group_key, category_key, target_seconds, updated_at'),
      supabase
        .from('jmcwc_papers')
        .select('id, group_key, version, spec, published, created_at')
        .order('group_key', { ascending: true }),
      supabase
        .from('jmcwc_attempts')
        .select('id, student_id, mode, status'),
    ]);

    const assignMap = new Map();
    if (Array.isArray(assignments)) {
      for (const a of assignments) {
        assignMap.set(a.student_id, a);
      }
    }

    const attemptStatsByStudent = new Map();
    if (Array.isArray(allAttempts)) {
      for (const att of allAttempts) {
        let st = attemptStatsByStudent.get(att.student_id);
        if (!st) {
          st = { unfinished_count: 0, unfinished_flat_count: 0, submitted_count: 0 };
          attemptStatsByStudent.set(att.student_id, st);
        }
        if (att.status === 'submitted') {
          st.submitted_count += 1;
        } else {
          st.unfinished_count += 1;
          if (att.mode === 'flat') {
            st.unfinished_flat_count += 1;
          }
        }
      }
    }

    const students = (studentProfiles || []).map((p) => {
      const assign = assignMap.get(p.id) || null;
      const stats = attemptStatsByStudent.get(p.id) || {
        unfinished_count: 0,
        unfinished_flat_count: 0,
        submitted_count: 0,
      };
      return {
        id: p.id,
        student_code: p.student_code,
        full_name: p.full_name,
        active: Boolean(p.active),
        // Never infer JMCWC group from profiles.level
        group_key: assign ? assign.group_key : null,
        assignment_updated_at: assign ? assign.updated_at : null,
        unfinished_attempts_count: stats.unfinished_count,
        unfinished_flat_count: stats.unfinished_flat_count,
        submitted_attempts_count: stats.submitted_count,
      };
    });

    const enrichedCategories = (categories || []).map((c) => ({
      ...c,
      id: c.key,
      category_slug: c.key,
      display_name: c.label,
      section_order: c.position,
    }));

    const enrichedTargets = (targets || []).map((t) => ({
      ...t,
      category_id: t.category_key,
    }));

    return {
      students,
      assignments: assignments || [],
      categories: enrichedCategories,
      legacy_round_categories: legacyRoundCategories || [],
      legacy_categories: legacyRoundCategories || [],
      targets: enrichedTargets,
      papers: (papers || []).map(summarizePaperRow),
    };
  }

  async function handleAdminSetAssignment(supabase, body) {
    const studentId = body?.student_id;
    const groupKey = body?.group_key;

    if (!isUuid(studentId)) {
      throw createHttpError(400, 'Invalid student_id.', 'INVALID_REQUEST');
    }
    if (!JMCWC_GROUP_KEYS.includes(groupKey)) {
      throw createHttpError(
        400,
        'group_key must be one of: junior1, junior2, senior.',
        'INVALID_REQUEST'
      );
    }

    const { data, error } = await supabase
      .from('jmcwc_assignments')
      .upsert(
        {
          student_id: studentId,
          group_key: groupKey,
        },
        { onConflict: 'student_id' }
      )
      .select('student_id, group_key, updated_at')
      .single();

    if (error) {
      throw mapDatabaseErrorToHttp(error);
    }

    return { assignment: data };
  }

  async function handleAdminSetTarget(supabase, body) {
    const groupKey = body?.group_key;
    const categoryKey = body?.category_key || body?.category_id;
    const rawTarget = body?.target_seconds;

    if (!JMCWC_GROUP_KEYS.includes(groupKey)) {
      throw createHttpError(
        400,
        'group_key must be one of: junior1, junior2, senior.',
        'INVALID_REQUEST'
      );
    }
    if (!JMCWC_CATEGORY_KEYS.includes(categoryKey)) {
      throw createHttpError(400, 'Invalid category_key.', 'INVALID_REQUEST');
    }

    let targetSeconds = null;
    if (rawTarget !== null && rawTarget !== undefined && rawTarget !== '') {
      const n = Number(rawTarget);
      if (!Number.isInteger(n) || n <= 0 || n > 86400) {
        throw createHttpError(
          400,
          'target_seconds must be a positive integer between 1 and 86400, or null to clear.',
          'INVALID_REQUEST'
        );
      }
      targetSeconds = n;
    }

    const { data, error } = await supabase
      .from('jmcwc_targets')
      .upsert(
        {
          group_key: groupKey,
          category_key: categoryKey,
          target_seconds: targetSeconds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_key,category_key' }
      )
      .select('group_key, category_key, target_seconds, updated_at')
      .single();

    if (error) {
      throw mapDatabaseErrorToHttp(error);
    }

    return { target: data };
  }

  async function handleAdminSetCategoryMapping(supabase, body) {
    const categoryKey = body?.category_key || body?.category_id;
    const legacyCategoryId = body?.legacy_category_id ?? null;

    if (!JMCWC_CATEGORY_KEYS.includes(categoryKey)) {
      throw createHttpError(400, 'Invalid category_key.', 'INVALID_REQUEST');
    }

    if (legacyCategoryId !== null) {
      if (!isUuid(legacyCategoryId)) {
        throw createHttpError(400, 'Invalid legacy_category_id.', 'INVALID_REQUEST');
      }
      // Enforce that legacy_category_id belongs to section = 'round' in public.categories
      const { data: legacyCat, error: catErr } = await supabase
        .from('categories')
        .select('id, name, section')
        .eq('id', legacyCategoryId)
        .maybeSingle();

      if (catErr || !legacyCat) {
        throw createHttpError(400, 'Legacy category not found.', 'INVALID_LEGACY_CATEGORY');
      }
      if (legacyCat.section !== 'round') {
        throw createHttpError(
          400,
          'Legacy category mapping must reference a category with section = "round".',
          'INVALID_LEGACY_CATEGORY_SECTION'
        );
      }
    }

    const { data, error } = await supabase
      .from('jmcwc_categories')
      .update({ legacy_category_id: legacyCategoryId })
      .eq('key', categoryKey)
      .select('key, label, workbook_sheet, position, legacy_category_id')
      .single();

    if (error || !data) {
      throw createHttpError(404, 'JMCWC category not found.', 'CATEGORY_NOT_FOUND');
    }

    return { category: data };
  }

  async function handleAdminGetPapers(supabase) {
    const { data: papers, error } = await supabase
      .from('jmcwc_papers')
      .select('id, group_key, version, spec, published, created_at')
      .order('group_key', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      throw mapDatabaseErrorToHttp(error);
    }

    return {
      papers: (papers || []).map(summarizePaperRow),
    };
  }

  async function handleAdminListAttempts(supabase, body) {
    const offset = Math.max(0, Math.min(Number(body?.offset) || 0, 100000));
    const limit = Math.max(1, Math.min(Number(body?.limit) || 50, 50));

    let query = supabase
      .from('jmcwc_attempts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (body?.student_id) {
      if (!isUuid(body.student_id)) {
        throw createHttpError(400, 'Invalid student_id filter.', 'INVALID_REQUEST');
      }
      query = query.eq('student_id', body.student_id);
    }
    if (body?.group_key) {
      if (!JMCWC_GROUP_KEYS.includes(body.group_key)) {
        throw createHttpError(400, 'Invalid group_key filter.', 'INVALID_REQUEST');
      }
      query = query.eq('group_key', body.group_key);
    }
    if (body?.mode) {
      if (body.mode !== 'flat' && body.mode !== 'category') {
        throw createHttpError(400, 'Invalid mode filter.', 'INVALID_REQUEST');
      }
      query = query.eq('mode', body.mode);
    }
    if (body?.status) {
      if (!['paused', 'running', 'grading', 'submitted'].includes(body.status)) {
        throw createHttpError(400, 'Invalid status filter.', 'INVALID_REQUEST');
      }
      query = query.eq('status', body.status);
    }

    const { data: rows, error } = await query;
    if (error) {
      throw mapDatabaseErrorToHttp(error);
    }

    const attempts = Array.isArray(rows) ? rows : [];
    const settledAttempts = [];
    for (const row of attempts) {
      if (row.status === 'grading') {
        const settled = await settleGradingAttempt(supabase, row.student_id, row);
        settledAttempts.push(settled.attempt);
      } else {
        settledAttempts.push(row);
      }
    }

    const studentIds = [...new Set(settledAttempts.map((a) => a.student_id))];
    const [{ maxMarksMap, scoresMap, questionCountMap }, { data: profiles }] = await Promise.all([
      fetchAttemptsMetadataMaps(supabase, settledAttempts),
      studentIds.length > 0
        ? supabase
            .from('profiles')
            .select('id, student_code, full_name')
            .in('id', studentIds)
        : Promise.resolve({ data: [] }),
    ]);

    const profileMap = new Map();
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        profileMap.set(p.id, p);
      }
    }

    return {
      attempts: settledAttempts.map((a) => {
        const base = whitelistAttemptForList(
          a,
          maxMarksMap.get(a.id) ?? null,
          scoresMap.get(a.id) ?? null,
          questionCountMap.get(a.id) ?? null
        );
        const studentProfile = profileMap.get(a.student_id) || null;
        return {
          ...base,
          student: studentProfile
            ? {
                id: studentProfile.id,
                student_code: studentProfile.student_code,
                full_name: studentProfile.full_name,
              }
            : null,
        };
      }),
    };
  }

  async function handleAdminGetAttemptReview(supabase, body) {
    const attemptId = body?.attempt_id;
    if (!isUuid(attemptId)) {
      throw createHttpError(400, 'Invalid attempt_id.', 'INVALID_REQUEST');
    }

    const { data: attemptRow, error: attErr } = await supabase
      .from('jmcwc_attempts')
      .select('*')
      .eq('id', attemptId)
      .maybeSingle();

    if (attErr || !attemptRow) {
      throw createHttpError(404, 'Round not found.', 'ROUND_NOT_FOUND');
    }

    let currentAttempt = attemptRow;
    if (currentAttempt.status === 'grading') {
      const settled = await settleGradingAttempt(supabase, currentAttempt.student_id, currentAttempt);
      currentAttempt = settled.attempt;
    }

    if (currentAttempt.status !== 'submitted') {
      throw createHttpError(
        409,
        'Detailed review is only available for submitted rounds.',
        'ATTEMPT_NOT_SUBMITTED'
      );
    }

    const [privateQuestions, { data: scoreRow }, { data: studentProfile }] = await Promise.all([
      fetchAttemptQuestions(supabase, currentAttempt.id),
      supabase.from('jmcwc_scores').select('*').eq('attempt_id', currentAttempt.id).single(),
      supabase
        .from('profiles')
        .select('id, student_code, full_name')
        .eq('id', currentAttempt.student_id)
        .maybeSingle(),
    ]);

    if (!scoreRow) {
      throw createHttpError(500, 'Submitted score record not found.', 'SCORE_NOT_FOUND');
    }

    return {
      student: studentProfile || null,
      attempt: whitelistAttemptForSubmitted(currentAttempt, scoreRow, privateQuestions),
    };
  }

  /**
   * Computes student-deletion preview counts across JMCWC student-scoped tables:
   * - jmcwc_assignments
   * - jmcwc_attempts
   * - jmcwc_payloads
   * - jmcwc_scores
   * Never deletes or counts shared institute tables (`jmcwc_papers`, `jmcwc_categories`, `jmcwc_targets`) for deletion.
   */
  async function handleAdminGetStudentDeletionPreview(supabase, body) {
    const studentId = body?.student_id;
    if (!isUuid(studentId)) {
      throw createHttpError(400, 'Invalid student_id.', 'INVALID_REQUEST');
    }

    const { data: studentProfile } = await supabase
      .from('profiles')
      .select('id, student_code, full_name, role')
      .eq('id', studentId)
      .maybeSingle();

    if (!studentProfile || studentProfile.role !== 'student') {
      throw createHttpError(404, 'Student account not found.', 'STUDENT_NOT_FOUND');
    }

    const [{ data: assignRow }, { data: attemptRows }] = await Promise.all([
      supabase
        .from('jmcwc_assignments')
        .select('student_id, group_key')
        .eq('student_id', studentId)
        .maybeSingle(),
      supabase
        .from('jmcwc_attempts')
        .select('id, mode, status')
        .eq('student_id', studentId),
    ]);

    const attempts = Array.isArray(attemptRows) ? attemptRows : [];
    const attemptIds = attempts.map((a) => a.id);

    let payloadCount = 0;
    let scoreCount = 0;

    if (attemptIds.length > 0) {
      const [{ data: payloadRows }, { data: scoreRows }] = await Promise.all([
        supabase
          .from('jmcwc_payloads')
          .select('attempt_id')
          .in('attempt_id', attemptIds),
        supabase
          .from('jmcwc_scores')
          .select('attempt_id')
          .in('attempt_id', attemptIds),
      ]);
      payloadCount = Array.isArray(payloadRows) ? payloadRows.length : 0;
      scoreCount = Array.isArray(scoreRows) ? scoreRows.length : 0;
    }

    const assignmentsCount = assignRow ? 1 : 0;
    const attemptsCount = attempts.length;
    const totalJmcwcRows = assignmentsCount + attemptsCount + payloadCount + scoreCount;

    return {
      student: {
        id: studentProfile.id,
        student_code: studentProfile.student_code,
        full_name: studentProfile.full_name,
      },
      counts: {
        jmcwc_assignments: assignmentsCount,
        jmcwc_attempts: attemptsCount,
        jmcwc_payloads: payloadCount,
        jmcwc_scores: scoreCount,
      },
      total_rows_to_delete: totalJmcwcRows,
      total_jmcwc_rows: totalJmcwcRows,
      preserved_shared_tables: ['jmcwc_papers', 'jmcwc_categories', 'jmcwc_targets'],
    };
  }

  /**
   * Executes full student deletion cleanup for JMCWC student-scoped records ONLY as part of
   * deleting the student account (`delete_student_account: true` or `confirm_student_account_deletion: true`).
   * Strictly forbids deleting individual attempts or clearing attempts for an active student
   * so admins cannot use deletion as a shortcut to bypass the 3-unfinished-flat-round cap.
   * Never deletes shared `jmcwc_papers`, `jmcwc_categories`, or `jmcwc_targets`.
   */
  async function handleAdminDeleteStudentJmcwcData(supabase, body) {
    const studentId = body?.student_id;
    if (!isUuid(studentId)) {
      throw createHttpError(400, 'Invalid student_id.', 'INVALID_REQUEST');
    }
    const isConfirmedAccountDeletion =
      body?.delete_student_account === true || body?.confirm_student_account_deletion === true;
    if (!isConfirmedAccountDeletion) {
      throw createHttpError(
        403,
        'Unfinished or submitted simulator attempts cannot be deleted separately to bypass the flat-round cap. Student JMCWC records are only removed when deleting the student account.',
        'ATTEMPT_DELETE_SHORTCUT_FORBIDDEN'
      );
    }

    const preview = await handleAdminGetStudentDeletionPreview(supabase, { student_id: studentId });

    const { data: attemptRows } = await supabase
      .from('jmcwc_attempts')
      .select('id')
      .eq('student_id', studentId);
    const attemptIds = Array.isArray(attemptRows) ? attemptRows.map((a) => a.id) : [];

    // Delete in strict child-to-parent FK order for this student ONLY; never touch shared tables
    if (attemptIds.length > 0) {
      await supabase.from('jmcwc_scores').delete().in('attempt_id', attemptIds);
      await supabase.from('jmcwc_payloads').delete().in('attempt_id', attemptIds);
      await supabase.from('jmcwc_attempts').delete().eq('student_id', studentId);
    }
    await supabase.from('jmcwc_assignments').delete().eq('student_id', studentId);

    return {
      deleted: true,
      student_id: studentId,
      deleted_counts: preview.counts,
      preserved_shared_tables: preview.preserved_shared_tables,
    };
  }

  // ==========================================================================
  // Main HTTP Request Handler
  // ==========================================================================

  return async function jmcwcHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const rawBodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      if (rawBodyBytes > JMCWC_MAX_BODY_BYTES) {
        throw createHttpError(413, 'Request payload too large.', 'PAYLOAD_TOO_LARGE');
      }

      const action = typeof body.action === 'string' ? body.action.trim() : '';
      if (!STUDENT_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
        throw createHttpError(400, 'Unknown action.', 'INVALID_REQUEST');
      }

      const supabase = getSupabaseAdmin();
      const caller = await authenticateCaller(supabase, req);

      rateLimiter.checkLimit(caller.id, action);

      if (ADMIN_ACTIONS.has(action)) {
        if (caller.role !== 'admin') {
          throw createHttpError(403, 'Forbidden: Admin access required.', 'ADMIN_REQUIRED');
        }

        let result;
        switch (action) {
          case 'admin_get_overview':
            result = await handleAdminOverview(supabase);
            break;
          case 'admin_set_assignment':
            result = await handleAdminSetAssignment(supabase, body);
            break;
          case 'admin_set_target':
            result = await handleAdminSetTarget(supabase, body);
            break;
          case 'admin_set_category_mapping':
            result = await handleAdminSetCategoryMapping(supabase, body);
            break;
          case 'admin_get_papers':
            result = await handleAdminGetPapers(supabase);
            break;
          case 'admin_list_attempts':
            result = await handleAdminListAttempts(supabase, body);
            break;
          case 'admin_get_attempt_review':
            result = await handleAdminGetAttemptReview(supabase, body);
            break;
          case 'admin_get_student_deletion_preview':
            result = await handleAdminGetStudentDeletionPreview(supabase, body);
            break;
          case 'admin_delete_student_jmcwc_data':
            result = await handleAdminDeleteStudentJmcwcData(supabase, body);
            break;
          default:
            throw createHttpError(400, 'Unknown admin action.', 'INVALID_REQUEST');
        }
        return res.status(200).json(result);
      }

      // Student lifecycle action: strictly require an active student account
      if (caller.role !== 'student') {
        throw createHttpError(
          403,
          'An active student account is required.',
          'INACTIVE_OR_NON_STUDENT'
        );
      }

      const studentId = caller.id;
      let result;

      switch (action) {
        case 'status':
        case 'init':
        case 'get_practice_overview':
          result = await handleStudentStatus(supabase, studentId, body);
          break;
        case 'list':
        case 'list_attempts': {
          const attempts = await handleStudentList(supabase, studentId, body);
          result = { attempts };
          break;
        }
        case 'create':
          result = await handleStudentCreate(supabase, studentId, body);
          break;
        case 'read':
        case 'get_attempt_review':
          result = await handleStudentRead(supabase, studentId, body);
          break;
        case 'resume':
          result = await handleStudentResume(supabase, studentId, body);
          break;
        case 'save':
          result = await handleStudentSaveOrHeartbeat(supabase, studentId, body, 'save');
          break;
        case 'heartbeat':
          result = await handleStudentSaveOrHeartbeat(supabase, studentId, body, 'heartbeat');
          break;
        case 'pause':
          result = await handleStudentPause(supabase, studentId, body, rawBodyBytes);
          break;
        case 'submit':
          result = await handleStudentSubmit(supabase, studentId, body);
          break;
        default:
          throw createHttpError(400, 'Unknown action.', 'INVALID_REQUEST');
      }

      return res.status(200).json(result);
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      const responsePayload = {
        error: err?.message || 'An unexpected server error occurred.',
        code: err?.code || 'INTERNAL_ERROR',
      };
      if (err?.running_attempt_id) {
        responsePayload.running_attempt_id = err.running_attempt_id;
      }
      if (err?.attempt) {
        responsePayload.attempt = err.attempt;
      }
      return res.status(status).json(responsePayload);
    }
  };
}
