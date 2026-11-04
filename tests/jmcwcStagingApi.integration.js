/**
 * Trendz Tracker — Real Staging PostgreSQL + HTTP API Integration & Concurrency Harness
 * File: tests/jmcwcStagingApi.integration.js
 *
 * IMPORTANT:
 * - This harness runs ONLY against an isolated STAGING Supabase project and HTTP server.
 * - It NEVER substitutes the in-memory contract emulator.
 * - Separate HTTP API requests execute in independent database transactions and therefore
 *   require COMMITTED staging fixtures (`supabase/tests/jmcwc_staging_api_fixtures_setup.sql`).
 * - Credentials must be supplied exclusively through environment variables (never in chat or committed files):
 *     STAGING_SUPABASE_URL              (required: https://<staging-project-ref>.supabase.co)
 *     STAGING_SUPABASE_ANON_KEY         (required when signing in via email/password)
 *     STAGING_SUPABASE_SERVICE_ROLE_KEY (required: used to verify PostgreSQL rows directly)
 *     STAGING_API_BASE_URL              (required: e.g. http://localhost:3000 or your staging preview URL)
 *     STAGING_TEST_STUDENT_EMAIL        (recommended: dedicated staging Auth user email)
 *     STAGING_TEST_STUDENT_PASSWORD     (recommended: dedicated staging Auth user password)
 *     STAGING_TEST_STUDENT_TOKEN        (optional alternative: pre-fetched Bearer access_token from Supabase Auth)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it, before } from 'node:test';
import { createClient } from '@supabase/supabase-js';

const STAGING_SUPABASE_URL = (process.env.STAGING_SUPABASE_URL || '').trim();
const STAGING_SUPABASE_ANON_KEY = (process.env.STAGING_SUPABASE_ANON_KEY || '').trim();
const STAGING_SUPABASE_SERVICE_ROLE_KEY = (
  process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const STAGING_API_BASE_URL = (process.env.STAGING_API_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const STAGING_TEST_STUDENT_EMAIL = (process.env.STAGING_TEST_STUDENT_EMAIL || '').trim();
const STAGING_TEST_STUDENT_PASSWORD = process.env.STAGING_TEST_STUDENT_PASSWORD || '';
const STAGING_TEST_STUDENT_TOKEN_ENV = (process.env.STAGING_TEST_STUDENT_TOKEN || '').trim();

const SYNTHETIC_FIXTURE_PAPER_ID = '00000000-0000-4000-8000-000000172098';

const HAS_AUTH_CREDENTIALS = Boolean(
  STAGING_TEST_STUDENT_TOKEN_ENV ||
    (STAGING_SUPABASE_ANON_KEY && STAGING_TEST_STUDENT_EMAIL && STAGING_TEST_STUDENT_PASSWORD)
);

const HAS_STAGING_ENV = Boolean(
  STAGING_SUPABASE_URL &&
    STAGING_SUPABASE_SERVICE_ROLE_KEY &&
    STAGING_API_BASE_URL &&
    HAS_AUTH_CREDENTIALS
);

function assertNoAnswerKeysExposed(payload, contextLabel) {
  const serialized = JSON.stringify(payload || {});
  assert.equal(
    serialized.includes('"answer_key"'),
    false,
    `Security violation: answer_key leaked in ${contextLabel}`
  );
}

describe('JMCWC Real Staging PostgreSQL + HTTP API Integration & Concurrency Harness', () => {
  if (!HAS_STAGING_ENV) {
    it('reports staging blocker clearly when STAGING_* environment variables are absent (no emulator substitution)', () => {
      console.warn(
        '[BLOCKED / NOT EXECUTED] Real staging environment variables (STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY, STAGING_API_BASE_URL, and STAGING_TEST_STUDENT_EMAIL + STAGING_TEST_STUDENT_PASSWORD + STAGING_SUPABASE_ANON_KEY) are not set. Skipping live PostgreSQL HTTP API integration harness without substituting any in-memory emulator.'
      );
      assert.equal(HAS_STAGING_ENV, false);
    });
    return;
  }

  const adminSupabase = createClient(STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let studentAccessToken = STAGING_TEST_STUDENT_TOKEN_ENV;
  let studentUserId = null;

  async function callStagingHttpApi(body, token = studentAccessToken) {
    const response = await fetch(`${STAGING_API_BASE_URL}/api/jmcwc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: json,
    };
  }

  before(async () => {
    if (!studentAccessToken) {
      const anonSupabase = createClient(STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anonSupabase.auth.signInWithPassword({
        email: STAGING_TEST_STUDENT_EMAIL,
        password: STAGING_TEST_STUDENT_PASSWORD,
      });
      assert.equal(
        error,
        null,
        `Failed signing in dedicated staging test student via Supabase Auth: ${error?.message}`
      );
      assert.ok(data?.session?.access_token, 'Expected access_token from Supabase Auth sign-in');
      studentAccessToken = data.session.access_token;
      studentUserId = data.user.id;
    } else {
      const { data, error } = await adminSupabase.auth.getUser(studentAccessToken);
      assert.equal(error, null, `Invalid STAGING_TEST_STUDENT_TOKEN: ${error?.message}`);
      studentUserId = data.user.id;
    }

    // Verify this user is the dedicated staging test student ('JMCWC_STAGE_TEST_01')
    const { data: profile, error: profErr } = await adminSupabase
      .from('profiles')
      .select('id, student_code, role, active')
      .eq('id', studentUserId)
      .single();

    assert.equal(profErr, null, `Failed loading staging test student profile: ${profErr?.message}`);
    assert.equal(
      profile.student_code,
      'JMCWC_STAGE_TEST_01',
      'Safety check failed: authenticated user must have student_code = "JMCWC_STAGE_TEST_01"'
    );
  });

  it('1. verifies committed staging fixtures and clean starting state for dedicated test student', async () => {
    // Delete only prior test attempts created against the synthetic fixture paper for this test student
    const { error: delErr } = await adminSupabase
      .from('jmcwc_attempts')
      .delete()
      .eq('student_id', studentUserId)
      .eq('paper_id', SYNTHETIC_FIXTURE_PAPER_ID);
    assert.equal(delErr, null, `Failed cleaning prior fixture attempts: ${delErr?.message}`);

    const statusRes = await callStagingHttpApi({ action: 'status' });
    assert.equal(
      statusRes.status,
      200,
      `Unexpected status response: ${JSON.stringify(statusRes.body)}`
    );
    assert.equal(statusRes.headers['cache-control'], 'no-store');
    assert.equal(statusRes.body.error, undefined);
    assert.equal(statusRes.body.assigned, true);
    assert.equal(statusRes.body.paper_available, true);
    assertNoAnswerKeysExposed(statusRes.body, 'status');
  });

  it('2. enforces the 3-unfinished-flat-round cap under 4 concurrent create requests against real PostgreSQL', async () => {
    const reqIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];

    const responses = await Promise.all(
      reqIds.map((request_id) =>
        callStagingHttpApi({
          action: 'create',
          mode: 'flat',
          paper_id: SYNTHETIC_FIXTURE_PAPER_ID,
          request_id,
        })
      )
    );

    const succeeded = responses.filter((r) => r.status === 200 && !r.body?.error);
    const rejectedCap = responses.filter(
      (r) => r.status === 409 && r.body?.code === 'FLAT_CAP_REACHED'
    );

    assert.equal(
      succeeded.length,
      3,
      `Expected exactly 3 of 4 concurrent flat creations to succeed, got ${succeeded.length}: ${JSON.stringify(
        responses.map((r) => ({ status: r.status, code: r.body?.code }))
      )}`
    );
    assert.equal(
      rejectedCap.length,
      1,
      'Expected exactly 1 of 4 concurrent flat creations to fail with 409 FLAT_CAP_REACHED'
    );

    for (const s of succeeded) {
      assertNoAnswerKeysExposed(s.body, 'concurrent create');
    }

    const { data: dbAttempts, error: dbErr } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id, status, mode, lease_id')
      .eq('student_id', studentUserId)
      .eq('paper_id', SYNTHETIC_FIXTURE_PAPER_ID)
      .eq('mode', 'flat')
      .neq('status', 'submitted');

    assert.equal(dbErr, null);
    assert.equal(dbAttempts.length, 3);
  });

  it('3. verifies competing resumes, single running attempt, paused-attempt save no-op, and stale-lease rejection on running attempt', async () => {
    const { data: dbAttempts } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id')
      .eq('student_id', studentUserId)
      .eq('paper_id', SYNTHETIC_FIXTURE_PAPER_ID)
      .eq('mode', 'flat')
      .neq('status', 'submitted')
      .order('created_at', { ascending: true });

    assert.ok(dbAttempts && dbAttempts.length >= 2, 'Expected at least 2 unfinished flat attempts');
    const [attA, attB] = [dbAttempts[0].id, dbAttempts[1].id];

    // Step 3a: Fire competing resumes on Attempt A and Attempt B simultaneously
    const [resA, resB] = await Promise.all([
      callStagingHttpApi({
        action: 'resume',
        attempt_id: attA,
        confirm_takeover: true,
      }),
      callStagingHttpApi({
        action: 'resume',
        attempt_id: attB,
        confirm_takeover: true,
      }),
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assertNoAnswerKeysExposed(resA.body, 'resume A');
    assertNoAnswerKeysExposed(resB.body, 'resume B');

    const leaseFromResumeA = resA.body?.attempt?.lease_id;
    const leaseFromResumeB = resB.body?.attempt?.lease_id;
    assert.ok(leaseFromResumeA, 'Resume A must return a lease_id');
    assert.ok(leaseFromResumeB, 'Resume B must return a lease_id');

    // Step 3b: Verify in PostgreSQL that there is EXACTLY ONE running attempt
    const { data: postResumeRows, error: postErr } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id, status, lease_id, answers, save_seq')
      .eq('student_id', studentUserId)
      .in('id', [attA, attB]);

    assert.equal(postErr, null);
    const runningRows = postResumeRows.filter((r) => r.status === 'running');
    const pausedRows = postResumeRows.filter((r) => r.status === 'paused');

    assert.equal(
      runningRows.length,
      1,
      `Expected exactly 1 running attempt in PostgreSQL after competing resumes, found ${runningRows.length}`
    );
    assert.equal(
      pausedRows.length,
      1,
      'Expected the other attempt to be paused by switching'
    );

    const runningRow = runningRows[0];
    const switchedPausedRow = pausedRows[0];
    const oldPausedLease = switchedPausedRow.id === attA ? leaseFromResumeA : leaseFromResumeB;

    // Step 3c: A save to the attempt already paused by switching (switchedPausedRow)
    // may return its paused state (or 409 SESSION_PAUSED at the HTTP wrapper layer)
    // rather than 409 LEASE_MISMATCH, and MUST NOT alter answers, save_seq, or restart it.
    const saveToPausedRes = await callStagingHttpApi({
      action: 'save',
      attempt_id: switchedPausedRow.id,
      lease_id: oldPausedLease,
      save_seq: 1,
      answers: { addition_s1: '999' },
    });

    assert.notEqual(
      saveToPausedRes.body?.code,
      'LEASE_MISMATCH',
      'Attempt already paused by switching must not fail with LEASE_MISMATCH'
    );

    const { data: verifyPausedAfterSave } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id, status, lease_id, answers, save_seq')
      .eq('id', switchedPausedRow.id)
      .single();

    assert.equal(
      verifyPausedAfterSave.status,
      'paused',
      'Save to an attempt paused by switching must not restart it'
    );
    assert.equal(verifyPausedAfterSave.lease_id, null);
    assert.equal(
      verifyPausedAfterSave.save_seq,
      switchedPausedRow.save_seq,
      'Save to an attempt paused by switching must not alter save_seq'
    );
    assert.deepEqual(
      verifyPausedAfterSave.answers,
      switchedPausedRow.answers,
      'Save to an attempt paused by switching must not alter answers'
    );

    // Step 3d: Two competing resumes on the SAME running attempt (two tabs resuming same round)
    const [tab1, tab2] = await Promise.all([
      callStagingHttpApi({
        action: 'resume',
        attempt_id: runningRow.id,
        confirm_takeover: true,
      }),
      callStagingHttpApi({
        action: 'resume',
        attempt_id: runningRow.id,
        confirm_takeover: true,
      }),
    ]);

    assert.equal(tab1.status, 200);
    assert.equal(tab2.status, 200);

    const { data: currentRunningRow } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id, status, lease_id')
      .eq('id', runningRow.id)
      .single();

    assert.equal(currentRunningRow.status, 'running');
    const winningLease = currentRunningRow.lease_id;
    const tab1Lease = tab1.body?.attempt?.lease_id;
    const tab2Lease = tab2.body?.attempt?.lease_id;
    const losingLease = tab1Lease === winningLease ? tab2Lease : tab1Lease;

    assert.notEqual(winningLease, losingLease, 'Each resume must mint a distinct lease_id');

    // Writes (`save` and `heartbeat`) with an old lease to a currently running attempt MUST be rejected
    const staleSaveOnRunning = await callStagingHttpApi({
      action: 'save',
      attempt_id: runningRow.id,
      lease_id: losingLease,
      save_seq: 1,
      answers: { addition_s1: '42' },
    });
    assert.equal(staleSaveOnRunning.status, 409);
    assert.equal(staleSaveOnRunning.body?.code, 'LEASE_MISMATCH');
  });

  it('4. completes an attempt via ordered saves and early submit, freeing a flat-round slot in PostgreSQL', async () => {
    const { data: runningRow } = await adminSupabase
      .from('jmcwc_attempts')
      .select('id')
      .eq('student_id', studentUserId)
      .eq('paper_id', SYNTHETIC_FIXTURE_PAPER_ID)
      .eq('status', 'running')
      .single();

    assert.ok(runningRow, 'Expected an active running attempt');

    const resumeRes = await callStagingHttpApi({
      action: 'resume',
      attempt_id: runningRow.id,
      confirm_takeover: true,
    });
    assert.equal(resumeRes.status, 200);
    const leaseId = resumeRes.body?.attempt?.lease_id;
    const firstQuestion = resumeRes.body?.attempt?.questions?.[0];
    assert.ok(leaseId, 'Expected lease_id on resumed attempt');
    assert.ok(firstQuestion?.id, 'Expected public questions on resumed attempt');
    assertNoAnswerKeysExposed(resumeRes.body, 'resume before save');

    // Ordered save seq=1
    const saveRes = await callStagingHttpApi({
      action: 'save',
      attempt_id: runningRow.id,
      lease_id: leaseId,
      save_seq: 1,
      answers: { [firstQuestion.id]: '42' },
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body?.attempt?.save_seq, 1);

    // Submit early -> triggers server-side grading and jmcwc_finalize
    const submitRes = await callStagingHttpApi({
      action: 'submit',
      attempt_id: runningRow.id,
      lease_id: leaseId,
      save_seq: 2,
      answers: { [firstQuestion.id]: '42' },
    });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.body?.attempt?.status, 'submitted');
    assert.ok(submitRes.body?.attempt?.score, 'Expected finalized score in submit response');

    // Verify 1 slot is now free -> creating a new flat round succeeds
    const newFlatRes = await callStagingHttpApi({
      action: 'create',
      mode: 'flat',
      paper_id: SYNTHETIC_FIXTURE_PAPER_ID,
      request_id: crypto.randomUUID(),
    });
    assert.equal(newFlatRes.status, 200);
    assert.equal(newFlatRes.body.error, undefined);
  });
});
