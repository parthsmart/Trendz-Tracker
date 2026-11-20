/**
 * Trendz Tracker — Staging Weekly Test Contract Verification & Regression Tests
 * File: tests/stagingWeeklyTestContract.test.js
 *
 * Verifies:
 * 1. Exact reproduction: on baseline staging schema without tries_started,
 *    admin query from js/weeklyTests.js:906 fails with:
 *    "column weekly_test_attempts.tries_started does not exist".
 * 2. Pre-flight guardrails:
 *    - Fails if operator latch `app.target_environment` is unset or mismatched.
 *    - Fails if Mumbai production data tripwire (`STU101` / `Riya`) is triggered.
 * 3. Migration application:
 *    - Applies `supabase/staging_weekly_test_contract_prerequisite.sql` cleanly.
 *    - Idempotency: re-applying the script a second time succeeds with zero errors.
 * 4. Schema extensions & constraints:
 *    - Adds tries_started, tries_correct, seconds_used, claim_token, updated_at.
 *    - Creates unique indexes on attempts and scores.
 * 5. Data preservation & backfill:
 *    - Pre-existing submitted and in-progress attempts are preserved and backfilled.
 *    - Pre-existing scores are preserved and linked.
 * 6. Admin online results contract:
 *    - Admin query (js/weeklyTests.js:906) executes cleanly and returns all fields.
 * 7. Authoritative reservation & rollback routines:
 *    - `weekly_test_reserve_section_start` works for single-try and flash sections.
 *    - `weekly_test_rollback_start_reservation` decrements multi-try and cleans up unlinked starts.
 * 8. Student list compatibility (`my_weekly_tests()`):
 *    - Returns accurate section attempts, counters, and scores without drill_sessions workarounds.
 *    - Enforces authentication and denies anonymous callers.
 * 9. Review Correction 1 (Zero Data Loss):
 *    - Detects duplicate attempt and score groups for (test_id, student_id, section_id).
 *    - Aborts transaction with diagnostic details, preserving 100% of records (zero deletions).
 * 10. Review Correction 2 (Validated Flash Progress & Ambiguity Reporting):
 *    - Recovers progress from validated session/storage evidence (try_no=3 linked session).
 *    - Next reservation correctly returns try 4 (NOT resetting to try 2).
 *    - Aborts with diagnostic error when encountering ambiguous Flash records lacking evidence.
 * 11. Review Correction 3 (Safe Repeated Application):
 *    - Reapplying the patch preserves existing timestamps, counters, session links, and active claims.
 *    - Fresh reservation timestamp is NOT overwritten with older started_at; competing reservation is blocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PREREQ_PATH = path.join(ROOT_DIR, 'supabase', 'staging_weekly_test_contract_prerequisite.sql');

async function createBaselineStagingDb() {
  const db = new PGlite();

  // 1. Roles and auth helpers
  await db.exec(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    $$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object(
        'role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated')
      );
    $$;

    -- Base tables first
    CREATE TABLE IF NOT EXISTS public.profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name TEXT NOT NULL,
      student_code TEXT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      level TEXT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        (SELECT role = 'admin' AND active = true FROM public.profiles WHERE id = auth.uid()),
        false
      );
    $$;

    CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID DEFAULT auth.uid()) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        (SELECT role = 'teacher' AND active = true FROM public.profiles WHERE id = p_uid),
        false
      );
    $$;

    CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id UUID, p_perm TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT true;
    $$;

    CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT true;
    $$;

    CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE LANGUAGE sql STABLE AS $$
      SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
    $$;

    CREATE TABLE IF NOT EXISTS public.categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'basics',
      sort_order INT NOT NULL DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS public.weekly_tests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      notes TEXT NULL,
      test_date DATE NOT NULL,
      test_type TEXT NOT NULL DEFAULT 'online',
      audience_level TEXT NULL,
      target_scope TEXT NOT NULL DEFAULT 'all',
      opens_at TIMESTAMPTZ NULL,
      closes_at TIMESTAMPTZ NULL,
      remind_days_before INT NOT NULL DEFAULT 7,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      position INT NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'basics',
      category_id UUID NULL REFERENCES public.categories(id),
      seconds INT NULL,
      activity_key TEXT NULL,
      flash_digits INT NULL,
      flash_count INT NULL,
      flash_speed_ms INT NULL,
      flash_mode TEXT NULL,
      question_count INT NULL
    );

    CREATE TABLE IF NOT EXISTS public.weekly_test_recipients (
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (test_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS public.drill_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      activity_name TEXT NOT NULL,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      expected JSONB NOT NULL DEFAULT '[]'::jsonb,
      min_seconds NUMERIC NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
      status TEXT NOT NULL DEFAULT 'open',
      submitted_at TIMESTAMPTZ,
      result_id UUID,
      result_row_id UUID
    );

    -- ACTUAL INCOMPLETE STAGING SCHEMA: NO tries_started, tries_correct, seconds_used, claim_token, updated_at
    CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      section_id UUID NULL REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
      category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
      session_id UUID NULL REFERENCES public.drill_sessions(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'submitted')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ NULL
    );

    CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      section_id UUID NULL REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
      category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
      correct INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      time_seconds INT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      source TEXT NOT NULL DEFAULT 'online'
    );
  `);

  return db;
}

function setCaller(db, userId, jwtRole = 'authenticated') {
  return db.exec(`
    SELECT set_config('app.current_user_id', '${userId || ''}', false);
    SELECT set_config('app.current_jwt_role', '${jwtRole || ''}', false);
  `);
}

describe('Staging Weekly Test Contract Prerequisite', () => {
  it('1. Exact reproduction: admin query fails on baseline staging schema without tries_started', async () => {
    const db = await createBaselineStagingDb();

    // Verify baseline schema lacks tries_started
    const colRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts' AND column_name = 'tries_started'
    `);
    assert.equal(colRes.rows.length, 0, 'Baseline schema must not have tries_started');

    // Admin query from js/weeklyTests.js:906
    let threw = false;
    try {
      await db.query(`
        SELECT id, test_id, student_id, section_id, category_id, session_id, status,
               tries_started, tries_correct, seconds_used, started_at, finished_at
        FROM public.weekly_test_attempts
        WHERE test_id = '00000000-0000-0000-0000-000000000000'
      `);
    } catch (err) {
      threw = true;
      assert.match(
        err.message,
        /column weekly_test_attempts\.tries_started does not exist|column "tries_started" does not exist/i,
        'Must fail with missing tries_started column error'
      );
    }
    assert.ok(threw, 'Admin query must fail on baseline staging schema before prerequisite patch');
  });

  it('2. Pre-flight checks: operator latch and production tripwire', async () => {
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');

    // 2a. Unset latch fails
    const db1 = await createBaselineStagingDb();
    let threwLatch = false;
    try {
      // Execute the script body without setting the latch
      const sqlWithoutLatch = patchSql.replace(/SET\s+app\.target_environment\s*=\s*'staging_xhgzbbkvwojwfbexvcmh';/gi, '-- latch removed');
      await db1.exec(sqlWithoutLatch);
    } catch (err) {
      threwLatch = true;
      assert.match(err.message, /OPERATOR SAFETY HALT/i, 'Must fail when latch is unset');
    }
    assert.ok(threwLatch, 'Must enforce operator intent latch');

    // 2b. Production data tripwire fails if STU101 / Riya exists
    const db2 = await createBaselineStagingDb();
    await db2.query(`
      INSERT INTO public.profiles (student_code, full_name, role, level)
      VALUES ('STU101', 'Riya Sharma', 'student', 'Level 4');
    `);
    let threwTripwire = false;
    try {
      await db2.exec(patchSql);
    } catch (err) {
      threwTripwire = true;
      assert.match(err.message, /SECONDARY SAFEGUARD TRIPWIRE.*Mumbai production/i, 'Must abort on Mumbai production data');
    }
    assert.ok(threwTripwire, 'Must trigger production tripwire');
  });

  it('3. Full application, data preservation, backfill, and idempotency', async () => {
    const db = await createBaselineStagingDb();

    // Seed existing pre-patch data
    const student1Id = '11111111-1111-1111-1111-111111111111';
    const student2Id = '22222222-2222-2222-2222-222222222222';
    const testId = '33333333-3333-3333-3333-333333333333';
    const secBasicsId = '44444444-4444-4444-4444-444444444444';
    const secFlashId = '55555555-5555-5555-5555-555555555555';
    const flashSessId = '66666666-6666-6666-6666-666666666666';

    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level) VALUES
        ('${student1Id}', 'Alice Student', 'STG-001', 'student', 'Level 1'),
        ('${student2Id}', 'Bob Student', 'STG-002', 'student', 'Level 1');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at) VALUES
        ('${testId}', 'QA Phase 19 Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '2 days');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, seconds, question_count) VALUES
        ('${secBasicsId}', '${testId}', 1, 'basics', 60, NULL),
        ('${secFlashId}', '${testId}', 2, 'flash', NULL, 5);

      -- Existing attempt 1: Alice submitted Basics with linked score
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at, finished_at) VALUES
        ('a1111111-1111-1111-1111-111111111111', '${testId}', '${student1Id}', '${secBasicsId}', 'submitted', now() - interval '30 minutes', now() - interval '25 minutes');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source) VALUES
        ('${testId}', '${student1Id}', '${secBasicsId}', 18, 20, 55, 'online');

      -- Existing attempt 2: Bob submitted Flash with linked session (try_no: 5) and score (correct: 4 of 5)
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status) VALUES
        ('${flashSessId}', '${student2Id}', 'flash_anzan', 'Flash 5', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 5, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at, finished_at) VALUES
        ('a2222222-2222-2222-2222-222222222222', '${testId}', '${student2Id}', '${secFlashId}', '${flashSessId}', 'submitted', now() - interval '20 minutes', now() - interval '15 minutes');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source) VALUES
        ('${testId}', '${student2Id}', '${secFlashId}', 4, 5, 42, 'online');
    `);

    // Apply prerequisite SQL patch
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');
    await db.exec(patchSql);

    // Verify columns exist
    const cols = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts'
      ORDER BY column_name;
    `);
    const colMap = new Map(cols.rows.map(r => [r.column_name, r]));
    assert.ok(colMap.has('tries_started'), 'tries_started must exist');
    assert.ok(colMap.has('tries_correct'), 'tries_correct must exist');
    assert.ok(colMap.has('seconds_used'), 'seconds_used must exist');
    assert.ok(colMap.has('claim_token'), 'claim_token must exist');
    assert.ok(colMap.has('updated_at'), 'updated_at must exist');

    // Verify backfill on Alice's submitted Basics attempt
    const aliceAtt = await db.query(`
      SELECT tries_started, tries_correct, seconds_used, status
      FROM public.weekly_test_attempts
      WHERE id = 'a1111111-1111-1111-1111-111111111111'
    `);
    assert.equal(aliceAtt.rows[0].status, 'submitted');
    assert.equal(aliceAtt.rows[0].tries_started, 1);
    assert.equal(aliceAtt.rows[0].tries_correct, 18);
    assert.equal(aliceAtt.rows[0].seconds_used, 55);

    // Verify backfill on Bob's submitted Flash attempt from validated session try_no: 5
    const bobAtt = await db.query(`
      SELECT tries_started, tries_correct, seconds_used, status
      FROM public.weekly_test_attempts
      WHERE id = 'a2222222-2222-2222-2222-222222222222'
    `);
    assert.equal(bobAtt.rows[0].status, 'submitted');
    assert.equal(bobAtt.rows[0].tries_started, 5); // Recovered from session try_no: 5
    assert.equal(bobAtt.rows[0].tries_correct, 4); // Preserved correct: 4
    assert.equal(bobAtt.rows[0].seconds_used, 42);

    // Verify Admin query (js/weeklyTests.js:906) succeeds without error
    const adminRes = await db.query(`
      SELECT id, test_id, student_id, section_id, category_id, session_id, status,
             tries_started, tries_correct, seconds_used, started_at, finished_at
      FROM public.weekly_test_attempts
      WHERE test_id = $1
      ORDER BY tries_started ASC
    `, [testId]);
    assert.equal(adminRes.rows.length, 2, 'Admin query must return all attempts');
    assert.equal(adminRes.rows[0].tries_started, 1);
    assert.equal(adminRes.rows[1].tries_started, 5);

    // Verify Idempotency: re-running patch succeeds cleanly
    await db.exec(patchSql);
  });

  it('4. Atomic reservation (weekly_test_reserve_section_start) and safe rollback (weekly_test_rollback_start_reservation)', async () => {
    const db = await createBaselineStagingDb();
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');
    await db.exec(patchSql);

    const studentId = '00000000-0000-0000-0000-000000000001';
    const testId = '11111111-1111-1111-1111-111111111111';
    const secBasicsId = '22222222-2222-2222-2222-222222222222';
    const secFlashId = '33333333-3333-3333-3333-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Student Tester', 'STG-003', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Live Reservation Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, seconds)
      VALUES ('${secBasicsId}', '${testId}', 1, 'basics', 60);

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 2, 'flash', 3);
    `);

    // Set caller as service_role (how api/weekly-test.js calls reservation RPC)
    await setCaller(db, studentId, 'service_role');

    // 4a. Reserve single-try Basics section
    const resv1 = await db.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secBasicsId]);
    const r1 = resv1.rows[0].res;
    assert.equal(r1.ok, true);
    assert.equal(r1.is_first_start, true);
    assert.ok(r1.attempt_id);
    assert.ok(r1.claim_token);

    // Verify attempt row in DB
    const attCheck1 = await db.query(`
      SELECT tries_started, claim_token, status
      FROM public.weekly_test_attempts
      WHERE id = $1
    `, [r1.attempt_id]);
    assert.equal(attCheck1.rows[0].tries_started, 1);
    assert.equal(attCheck1.rows[0].status, 'started');
    assert.equal(attCheck1.rows[0].claim_token, r1.claim_token);

    // 4b. Rollback unlinked Basics reservation (e.g. session creation failed)
    const roll1 = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation($1, $2, $3) AS res
    `, [r1.attempt_id, studentId, r1.claim_token]);
    assert.equal(roll1.rows[0].res.ok, true);
    assert.equal(roll1.rows[0].res.rolled_back, true);
    assert.equal(roll1.rows[0].res.action, 'attempt_deleted');

    // Verify unstarted attempt was deleted
    const attAfterRoll = await db.query(`
      SELECT id FROM public.weekly_test_attempts WHERE id = $1
    `, [r1.attempt_id]);
    assert.equal(attAfterRoll.rows.length, 0, 'Unstarted attempt must be cleaned up on rollback');

    // 4c. Flash multi-try atomic flow:
    // Try 1
    const resvFlash1 = await db.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashId]);
    const rf1 = resvFlash1.rows[0].res;
    assert.equal(rf1.ok, true);
    assert.equal(rf1.is_first_start, true);
    assert.equal(rf1.next_try_no, 1);

    // Link session 1 and simulate try 1 completion
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('00000000-0000-0000-0000-000000000010', '${studentId}', 'flash_anzan', 'Flash Try 1', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 1, 'question_count', 3), 'submitted');
    `);

    await db.query(`
      UPDATE public.weekly_test_attempts
      SET session_id = '00000000-0000-0000-0000-000000000010',
          tries_started = 1,
          tries_correct = 1,
          seconds_used = 15,
          claim_token = NULL
      WHERE id = $1;
    `, [rf1.attempt_id]);

    // Try 2
    const resvFlash2 = await db.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashId]);
    const rf2 = resvFlash2.rows[0].res;
    assert.equal(rf2.ok, true);
    assert.equal(rf2.is_first_start, false);
    assert.equal(rf2.next_try_no, 2);
    assert.equal(rf2.tries_started, 1);

    // If try 2 fails before session link, rollback must decrement tries_started to 1 and preserve attempt!
    const rollFlash2 = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation($1, $2, $3) AS res
    `, [rf2.attempt_id, studentId, rf2.claim_token]);
    assert.equal(rollFlash2.rows[0].res.ok, true);
    assert.equal(rollFlash2.rows[0].res.rolled_back, true);
    assert.equal(rollFlash2.rows[0].res.action, 'try_decremented');

    const flashAttCheck = await db.query(`
      SELECT tries_started, tries_correct, claim_token FROM public.weekly_test_attempts WHERE id = $1
    `, [rf2.attempt_id]);
    assert.equal(flashAttCheck.rows[0].tries_started, 1, 'tries_started must be decremented back to 1');
    assert.equal(flashAttCheck.rows[0].tries_correct, 1, 'Previous correct tries must be preserved');
    assert.equal(flashAttCheck.rows[0].claim_token, null, 'claim_token must be cleared');
  });

  it('5. Student listing (my_weekly_tests) reads directly from attempts columns', async () => {
    const db = await createBaselineStagingDb();
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');
    await db.exec(patchSql);

    const studentId = '99999999-9999-9999-9999-999999999999';
    const testId = '88888888-8888-8888-8888-888888888888';
    const sec1 = '77777777-7777-7777-7777-777777777771';
    const sec2 = '77777777-7777-7777-7777-777777777772';

    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Student Lister', 'STG-004', 'student', 'Level 3', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, target_scope, opens_at, closes_at)
      VALUES ('${testId}', 'My Tests Flow', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', 'all', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, seconds)
      VALUES ('${sec1}', '${testId}', 1, 'basics', 60);

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${sec2}', '${testId}', 2, 'flash', 5);

      -- Section 1: submitted basics
      INSERT INTO public.weekly_test_attempts (test_id, student_id, section_id, status, tries_started, tries_correct, seconds_used)
      VALUES ('${testId}', '${studentId}', '${sec1}', 'submitted', 1, 19, 58);

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${sec1}', 19, 20, 58, 'online');

      -- Section 2: in-progress flash with 3 of 5 tries started
      INSERT INTO public.weekly_test_attempts (test_id, student_id, section_id, status, tries_started, tries_correct, seconds_used)
      VALUES ('${testId}', '${studentId}', '${sec2}', 'started', 3, 2, 35);
    `);

    // Call as authenticated student
    await setCaller(db, studentId, 'authenticated');

    const res = await db.query(`SELECT public.my_weekly_tests() AS tests`);
    const tests = res.rows[0].tests;
    assert.equal(Array.isArray(tests), true);
    assert.equal(tests.length, 1);

    const testItem = tests[0];
    assert.equal(testItem.id, testId);
    assert.equal(testItem.state, 'open');
    assert.equal(testItem.sections.length, 2);

    const s1 = testItem.sections[0];
    assert.equal(s1.section_id, sec1);
    assert.equal(s1.attempt, 'submitted');
    assert.equal(s1.correct, 19);
    assert.equal(s1.total, 20);

    const s2 = testItem.sections[1];
    assert.equal(s2.section_id, sec2);
    assert.equal(s2.attempt, 'started');
    assert.equal(s2.tries_started, 3, 'Must directly reflect tries_started = 3 from weekly_test_attempts');
    assert.equal(s2.tries_correct, 2, 'Must directly reflect tries_correct = 2 from weekly_test_attempts');
    assert.equal(s2.question_count, 5);

    // Call without authentication fails
    await setCaller(db, null, 'anon');
    let unauthErr = false;
    try {
      await db.query(`SELECT public.my_weekly_tests() AS tests`);
    } catch (err) {
      unauthErr = true;
      assert.match(err.message, /Authentication required/i);
    }
    assert.ok(unauthErr, 'my_weekly_tests must reject unauthenticated callers');
  });

  it('6. Review Correction 1: Conflicting duplicate records abort transaction with diagnostics and ZERO data loss', async () => {
    const db = await createBaselineStagingDb();

    const studentId = '11111111-2222-3333-4444-555555555555';
    const testId = '22222222-3333-4444-5555-666666666666';
    const sec1 = '33333333-4444-5555-6666-777777777771';
    const sec2 = '33333333-4444-5555-6666-777777777772';

    // Seed 3 attempts: 2 duplicate attempts for sec1, 1 attempt for sec2
    // Seed 3 scores: 2 duplicate scores for sec1, 1 score for sec2
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Dup Student', 'STG-DUP', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Duplicate Check Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind)
      VALUES ('${sec1}', '${testId}', 1, 'basics'),
             ('${sec2}', '${testId}', 2, 'basics');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('a1111111-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${sec1}', 'started', now() - interval '1 hour'),
             ('a1111111-0000-0000-0000-000000000002', '${testId}', '${studentId}', '${sec1}', 'submitted', now() - interval '30 minutes'),
             ('a1111111-0000-0000-0000-000000000003', '${testId}', '${studentId}', '${sec2}', 'started', now() - interval '10 minutes');

      INSERT INTO public.weekly_test_scores (id, test_id, student_id, section_id, correct, total)
      VALUES ('b1111111-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${sec1}', 10, 10),
             ('b1111111-0000-0000-0000-000000000002', '${testId}', '${studentId}', '${sec1}', 9, 10),
             ('b1111111-0000-0000-0000-000000000003', '${testId}', '${studentId}', '${sec2}', 8, 10);
    `);

    // Verify initial count is exactly 3 attempts and 3 scores
    const countBeforeAtt = await db.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_attempts`);
    const countBeforeSc = await db.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_scores`);
    assert.equal(countBeforeAtt.rows[0].cnt, 3, 'Must start with 3 attempts');
    assert.equal(countBeforeSc.rows[0].cnt, 3, 'Must start with 3 scores');

    // Executing prerequisite patch MUST abort due to duplicate conflict detection
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');
    let threwConflict = false;
    try {
      await db.exec(patchSql);
    } catch (err) {
      threwConflict = true;
      assert.match(err.message, /CONFLICTING ATTEMPTS DETECTED/i, 'Must report conflicting duplicate attempts');
      assert.match(err.message, /a1111111-0000-0000-0000-000000000001/i, 'Must include diagnostic record IDs');
      assert.match(err.message, /a1111111-0000-0000-0000-000000000002/i, 'Must include diagnostic record IDs');
      await db.exec('ROLLBACK;');
    }
    assert.ok(threwConflict, 'Prerequisite patch must abort on duplicate records');

    // CRITICAL: ZERO DATA LOSS — assert every single record is preserved, exactly 3 attempts and 3 scores!
    const countAfterAtt = await db.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_attempts`);
    const countAfterSc = await db.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_scores`);
    assert.equal(countAfterAtt.rows[0].cnt, 3, 'ZERO DATA LOSS: all 3 attempts must be preserved, none deleted');
    assert.equal(countAfterSc.rows[0].cnt, 3, 'ZERO DATA LOSS: all 3 scores must be preserved, none deleted');

    // 6b. Verify duplicate scores conflict detection when attempts are unique
    const dbScores = await createBaselineStagingDb();
    await dbScores.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Dup Student', 'STG-DUP', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Duplicate Check Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind)
      VALUES ('${sec1}', '${testId}', 1, 'basics'),
             ('${sec2}', '${testId}', 2, 'basics');

      -- Unique attempts (1 per section)
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('a1111111-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${sec1}', 'started', now() - interval '1 hour'),
             ('a1111111-0000-0000-0000-000000000003', '${testId}', '${studentId}', '${sec2}', 'started', now() - interval '10 minutes');

      -- Duplicate scores for sec1 (2 scores) and 1 score for sec2 (total 3 scores)
      INSERT INTO public.weekly_test_scores (id, test_id, student_id, section_id, correct, total)
      VALUES ('b1111111-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${sec1}', 10, 10),
             ('b1111111-0000-0000-0000-000000000002', '${testId}', '${studentId}', '${sec1}', 9, 10),
             ('b1111111-0000-0000-0000-000000000003', '${testId}', '${studentId}', '${sec2}', 8, 10);
    `);

    let threwScoreConflict = false;
    try {
      await dbScores.exec(patchSql);
    } catch (err) {
      threwScoreConflict = true;
      assert.match(err.message, /CONFLICTING SCORES DETECTED/i, 'Must report conflicting duplicate scores');
      assert.match(err.message, /b1111111-0000-0000-0000-000000000001/i, 'Must include diagnostic record IDs');
      assert.match(err.message, /b1111111-0000-0000-0000-000000000002/i, 'Must include diagnostic record IDs');
      await dbScores.exec('ROLLBACK;');
    }
    assert.ok(threwScoreConflict, 'Prerequisite patch must abort on duplicate score records');

    const scCountAtt = await dbScores.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_attempts`);
    const scCountSc = await dbScores.query(`SELECT count(*)::int AS cnt FROM public.weekly_test_scores`);
    assert.equal(scCountAtt.rows[0].cnt, 2, 'ZERO DATA LOSS: all 2 attempts preserved');
    assert.equal(scCountSc.rows[0].cnt, 3, 'ZERO DATA LOSS: all 3 scores preserved');
  });

  it('7. Review Corrections: Flash authoritative recovery, active session protection, and evidence validation', async () => {
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');

    // 7a. Validated completed-try-3 -> try-4 path
    const db1 = await createBaselineStagingDb();
    const studentId = '44444444-5555-6666-7777-888888888888';
    const testId = '55555555-6666-7777-8888-999999999999';
    const secFlashId = '66666666-7777-8888-9999-000000000000';
    const sess3Id = '77777777-8888-9999-0000-111111111111';

    await db1.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Flash Student', 'STG-FL3', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Flash Backfill Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Valid completed try 3 matching real api/weekly-test.js payload
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sess3Id}', '${studentId}', 'flash_anzan', 'Flash Try 3', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 3, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('a3333333-3333-3333-3333-333333333333', '${testId}', '${studentId}', '${secFlashId}', '${sess3Id}', 'started', now() - interval '30 minutes');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashId}', 2, 5, 45, 'online');
    `);

    await db1.exec(patchSql);

    // Verify backfilled attempt: tries_started must be 3, tries_correct = 2, claim_token = null, session_id retained
    const attCheck = await db1.query(`
      SELECT tries_started, tries_correct, seconds_used, claim_token, session_id, status
      FROM public.weekly_test_attempts
      WHERE id = 'a3333333-3333-3333-3333-333333333333'
    `);
    assert.equal(attCheck.rows[0].tries_started, 3, 'Must recover tries_started = 3 from validated session storage evidence');
    assert.equal(attCheck.rows[0].tries_correct, 2, 'Must preserve tries_correct = 2 without conflating with tries_started');
    assert.equal(attCheck.rows[0].claim_token, null, 'Claim token must be null on completed try backfill');
    assert.equal(attCheck.rows[0].session_id, sess3Id, 'Session ID must remain linked to completed try 3');

    // Next reservation for this Flash section MUST return try 4 (NOT try 2!)
    await setCaller(db1, studentId, 'service_role');
    const resvNext = await db1.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashId]);
    const nextR = resvNext.rows[0].res;
    assert.equal(nextR.ok, true);
    assert.equal(nextR.next_try_no, 4, 'Authoritative reservation must calculate next try as 4');
    assert.equal(nextR.tries_started, 3, 'Previous tries_started must be reported as 3');

    // 7b. Score-only progress is NOT guessed: started attempt with score 2/5 and zero-score placeholder 0/5 abort as ambiguous
    const dbScoreOnly = await createBaselineStagingDb();
    const ambigAtt1 = 'a5555555-0000-0000-0000-000000000001';
    await dbScoreOnly.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Score Only Student', 'STG-SO', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Score Only Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Started attempt with score 2/5 but NO session evidence
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('${ambigAtt1}', '${testId}', '${studentId}', '${secFlashId}', 'started', now() - interval '1 hour');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashId}', 2, 5, 30, 'online');
    `);

    let threwScoreOnly = false;
    try {
      await dbScoreOnly.exec(patchSql);
    } catch (err) {
      threwScoreOnly = true;
      assert.match(err.message, /AMBIGUOUS FLASH ATTEMPT DETECTED/i, 'Must abort on score-only attempt lacking session evidence');
      assert.match(err.message, new RegExp(ambigAtt1, 'i'));
      await dbScoreOnly.exec('ROLLBACK;');
    }
    assert.ok(threwScoreOnly, 'Score-only attempt without session evidence must abort rather than guess tries_started');

    // Also test zero-score placeholder (0/5)
    const dbZeroScore = await createBaselineStagingDb();
    const ambigAtt2 = 'a5555555-0000-0000-0000-000000000002';
    await dbZeroScore.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Zero Score Student', 'STG-ZS', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Zero Score Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('${ambigAtt2}', '${testId}', '${studentId}', '${secFlashId}', 'started', now() - interval '1 hour');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashId}', 0, 5, 0, 'online');
    `);

    let threwZeroScore = false;
    try {
      await dbZeroScore.exec(patchSql);
    } catch (err) {
      threwZeroScore = true;
      assert.match(err.message, /AMBIGUOUS FLASH ATTEMPT DETECTED/i, 'Must abort on zero-score placeholder lacking session evidence');
      await dbZeroScore.exec('ROLLBACK;');
    }
    assert.ok(threwZeroScore, 'Zero-score placeholder must abort rather than guess tries_started');

    // 7c. Active sessions lose protection: open session at try_no=3 defers migration, and reserve_section_start blocks reserving try 4 while try 3 is open
    const dbActive = await createBaselineStagingDb();
    const activeSessId = '77777777-8888-9999-0000-222222222222';
    await dbActive.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Active Student', 'STG-ACT', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Active Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Valid linked session at try_no = 3, status = 'open' (unexpired) matching real payload
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status, expires_at)
      VALUES ('${activeSessId}', '${studentId}', 'flash_anzan', 'Flash Try 3 Open', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 3, 'question_count', 5), 'open', now() + interval '10 minutes');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('a6666666-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secFlashId}', '${activeSessId}', 'started', now() - interval '5 minutes');
    `);

    let threwActive = false;
    try {
      await dbActive.exec(patchSql);
    } catch (err) {
      threwActive = true;
      assert.match(err.message, /ACTIVE FLASH SESSIONS IN PROGRESS/i, 'Must defer migration with clear diagnostics when active sessions exist');
      await dbActive.exec('ROLLBACK;');
    }
    assert.ok(threwActive, 'Migration must abort when Flash drill sessions are actively open');

    // Runtime reservation blocking: preserve blocking until completion without detaching or inventing claim tokens
    const dbRuntime = await createBaselineStagingDb();
    await dbRuntime.exec(patchSql);
    await dbRuntime.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Active Student 2', 'STG-ACT2', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Active Runtime Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Open session at try_no 3 matching real payload
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status, expires_at)
      VALUES ('${activeSessId}', '${studentId}', 'flash_anzan', 'Flash Try 3', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 3, 'question_count', 5), 'open', now() + interval '10 minutes');

      -- Attempt with tries_started = 3, session_id linked to active try 3, claim_token = null
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, tries_started, claim_token, started_at, updated_at)
      VALUES ('a6666666-0000-0000-0000-000000000002', '${testId}', '${studentId}', '${secFlashId}', '${activeSessId}', 'started', 3, NULL, now() - interval '2 minutes', now() - interval '2 minutes');
    `);

    await setCaller(dbRuntime, studentId, 'service_role');
    let threwReserveBlocked = false;
    try {
      await dbRuntime.query(`
        SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
      `, [testId, studentId, secFlashId]);
    } catch (err) {
      threwReserveBlocked = true;
      assert.match(err.message, /A try is currently in progress for this section/i, 'Must block reserving next try while try 3 session is open');
    }
    assert.ok(threwReserveBlocked, 'Reserving must preserve blocking until completion while linked session is open');

    // Assert session_id was NOT cleared and claim_token was NOT invented
    const checkAttPreserved = await dbRuntime.query(`
      SELECT session_id, claim_token, tries_started FROM public.weekly_test_attempts
      WHERE id = 'a6666666-0000-0000-0000-000000000002'
    `);
    assert.equal(checkAttPreserved.rows[0].session_id, activeSessId, 'Active session must NOT be detached');
    assert.equal(checkAttPreserved.rows[0].claim_token, null, 'Claim token must NOT be invented');
    assert.equal(checkAttPreserved.rows[0].tries_started, 3, 'tries_started must remain 3');

    // 7d. Linked session evidence validation: rejects sessions belonging to another student, try_no = 99, or mismatched activity
    const dbInconsistent = await createBaselineStagingDb();
    const otherStudentId = '88888888-8888-8888-8888-888888888888';
    const badSessId = '99999999-9999-9999-9999-999999999999';
    await dbInconsistent.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Student A', 'STG-A', 'student', 'Level 2'),
             ('${otherStudentId}', 'Student B', 'STG-B', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Inconsistent Evidence Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Session belonging to another student (Student B) with try_no = 99
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${badSessId}', '${otherStudentId}', 'flash_anzan', 'Alien Session', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 99, 'question_count', 5), 'submitted');

      -- Student A's attempt links to Student B's session with try_no 99
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('a7777777-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secFlashId}', '${badSessId}', 'started', now() - interval '1 hour');
    `);

    let threwInconsistent = false;
    try {
      await dbInconsistent.exec(patchSql);
    } catch (err) {
      threwInconsistent = true;
      assert.match(err.message, /(CONTRADICTORY SESSION METADATA|INCONSISTENT SESSION EVIDENCE)/i, 'Must reject inconsistent session evidence belonging to another student with try_no 99');
      await dbInconsistent.exec('ROLLBACK;');
    }
    assert.ok(threwInconsistent, 'Must transactionally reject sessions belonging to another student with try_no = 99');

    // 7e. Duplicate ordinal evidence: multiple sessions with identical try_no abort transactionally
    const dbDupOrd = await createBaselineStagingDb();
    const dupSess1 = 'dddddddd-0000-0000-0000-111111111111';
    const dupSess2 = 'dddddddd-0000-0000-0000-222222222222';
    await dbDupOrd.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Dup Ord Student', 'STG-DORD', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Dup Ord Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Two sessions both claiming try_no = 2 matching real payload
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${dupSess1}', '${studentId}', 'flash_anzan', 'Try 2 A', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 2, 'question_count', 5), 'submitted'),
             ('${dupSess2}', '${studentId}', 'flash_anzan', 'Try 2 B', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 2, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('a8888888-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secFlashId}', '${dupSess1}', 'started', now() - interval '1 hour');
    `);

    let threwDupOrd = false;
    try {
      await dbDupOrd.exec(patchSql);
    } catch (err) {
      threwDupOrd = true;
      assert.match(err.message, /DUPLICATE ORDINAL EVIDENCE DETECTED/i, 'Must reject duplicate ordinal evidence');
      await dbDupOrd.exec('ROLLBACK;');
    }
    assert.ok(threwDupOrd, 'Must abort when multiple sessions claim the same try_no');

    // 7f. Contradictory metadata: another submitted session has same student & section_id but test_id identifies test B
    const dbContradict = await createBaselineStagingDb();
    const testA_id = 'aaaaaaaa-1111-1111-1111-111111111111';
    const testB_id = 'bbbbbbbb-2222-2222-2222-222222222222';
    const secFlashA = 'cccccccc-3333-3333-3333-333333333333';
    const sessA3 = 'dddddddd-4444-4444-4444-444444444444';
    const sessB4 = 'eeeeeeee-5555-5555-5555-555555555555';

    await dbContradict.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Contradict Student', 'STG-CON', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testA_id}', 'Test A', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day'),
             ('${testB_id}', 'Test B', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashA}', '${testA_id}', 1, 'flash', 5);

      -- Valid completed try 3 belonging to Test A
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sessA3}', '${studentId}', 'flash_anzan', 'Try 3 Test A', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testA_id}', 'section_id', '${secFlashA}', 'try_no', 3, 'question_count', 5), 'submitted');

      -- Attempt for Test A linked to try 3
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('a9999999-0000-0000-0000-000000000001', '${testA_id}', '${studentId}', '${secFlashA}', '${sessA3}', 'started', now() - interval '30 minutes');

      -- Contradictory session: same student and section_id, but settings.test_id identifies Test B and try_no=4
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sessB4}', '${studentId}', 'flash_anzan', 'Try 4 Test B', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testB_id}', 'section_id', '${secFlashA}', 'try_no', 4, 'question_count', 5), 'submitted');
    `);

    let threwContradict = false;
    try {
      await dbContradict.exec(patchSql);
    } catch (err) {
      threwContradict = true;
      assert.match(err.message, /CONTRADICTORY SESSION METADATA DETECTED/i, 'Must reject contradictory metadata transactionally');
      assert.match(err.message, new RegExp(testB_id, 'i'), 'Diagnostics must report conflicting test_id');
      await dbContradict.exec('ROLLBACK;');
    }
    assert.ok(threwContradict, 'Patch must abort on contradictory session metadata without setting tries_started=4 or replacing session_id');

    // Confirm zero data loss: attempt still exists and is untouched
    const attAfter = await dbContradict.query(`
      SELECT session_id, status FROM public.weekly_test_attempts WHERE id = 'a9999999-0000-0000-0000-000000000001'
    `);
    assert.equal(attAfter.rows[0].session_id, sessA3, 'Session ID must remain linked to Test A try 3');

    // 7g. Missing identifying evidence: session missing kind/section_kind/test_id/section_id must abort as ambiguous
    const dbMissing = await createBaselineStagingDb();
    const missingSessId = 'eeeeeeee-1111-2222-3333-444444444444';
    await dbMissing.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Missing Evidence Student', 'STG-MISS', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Missing Evidence Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      -- Session missing kind and section_kind identifying evidence
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${missingSessId}', '${studentId}', 'flash_anzan', 'Try Missing Identifiers', jsonb_build_object('test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 2), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secFlashId}', '${missingSessId}', 'started', now() - interval '1 hour');
    `);

    let threwMissing = false;
    try {
      await dbMissing.exec(patchSql);
    } catch (err) {
      threwMissing = true;
      assert.match(err.message, /AMBIGUOUS FLASH ATTEMPT DETECTED/i, 'Must abort when identifying evidence is missing');
      await dbMissing.exec('ROLLBACK;');
    }
    assert.ok(threwMissing, 'Must report sessions missing identifying evidence as ambiguous');

    // 7h. Positive test: two Flash sections in the same test for the same student
    // Flash Section A has valid completed try 3; Flash Section B has valid submitted try 1.
    // Both must be migrated independently without falsely rejecting sibling sections.
    // Section A recovers try 3 -> next try 4; Section B recovers try 1 -> next try 2.
    const dbTwoFlash = await createBaselineStagingDb();
    const secFlashA_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
    const secFlashB_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
    const sessA3_id = 'bbbbbbbb-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
    const sessB1_id = 'bbbbbbbb-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
    const attA_id = 'cccccccc-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
    const attB_id = 'cccccccc-aaaa-aaaa-aaaa-aaaaaaaaaaa2';

    await dbTwoFlash.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Two Flash Student', 'STG-2FL', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Two Flash Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashA_id}', '${testId}', 1, 'flash', 5),
             ('${secFlashB_id}', '${testId}', 2, 'flash', 5);

      -- Valid completed try 3 for Flash Section A
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sessA3_id}', '${studentId}', 'flash_anzan', 'Flash A Try 3', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashA_id}', 'try_no', 3, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('${attA_id}', '${testId}', '${studentId}', '${secFlashA_id}', '${sessA3_id}', 'started', now() - interval '30 minutes');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashA_id}', 2, 5, 45, 'online');

      -- Valid submitted session for Flash Section B (try 1)
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sessB1_id}', '${studentId}', 'flash_anzan', 'Flash B Try 1', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashB_id}', 'try_no', 1, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('${attB_id}', '${testId}', '${studentId}', '${secFlashB_id}', '${sessB1_id}', 'started', now() - interval '15 minutes');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashB_id}', 1, 5, 20, 'online');
    `);

    // Prerequisite migration must apply cleanly without falsely flagging sibling section B
    await dbTwoFlash.exec(patchSql);

    // Section A verification: tries_started = 3, next try = 4
    const attACheck = await dbTwoFlash.query(`
      SELECT tries_started, tries_correct, seconds_used, session_id FROM public.weekly_test_attempts WHERE id = '${attA_id}'
    `);
    assert.equal(attACheck.rows[0].tries_started, 3, 'Section A must recover tries_started = 3');
    assert.equal(attACheck.rows[0].tries_correct, 2, 'Section A must preserve tries_correct = 2');
    assert.equal(attACheck.rows[0].seconds_used, 45, 'Section A must preserve seconds_used = 45');
    assert.equal(attACheck.rows[0].session_id, sessA3_id, 'Section A must keep session_id linked to try 3');

    // Section B verification: tries_started = 1, next try = 2
    const attBCheck = await dbTwoFlash.query(`
      SELECT tries_started, tries_correct, seconds_used, session_id FROM public.weekly_test_attempts WHERE id = '${attB_id}'
    `);
    assert.equal(attBCheck.rows[0].tries_started, 1, 'Section B must recover tries_started = 1');
    assert.equal(attBCheck.rows[0].tries_correct, 1, 'Section B must preserve tries_correct = 1');
    assert.equal(attBCheck.rows[0].seconds_used, 20, 'Section B must preserve seconds_used = 20');
    assert.equal(attBCheck.rows[0].session_id, sessB1_id, 'Section B must keep session_id linked to try 1');

    // Test reservations: Section A reserves try 4; Section B reserves try 2
    await setCaller(dbTwoFlash, studentId, 'service_role');
    const resvA = await dbTwoFlash.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashA_id]);
    assert.equal(resvA.rows[0].res.ok, true);
    assert.equal(resvA.rows[0].res.next_try_no, 4, 'Section A must reserve try 4');
    assert.equal(resvA.rows[0].res.tries_started, 3);

    const resvB = await dbTwoFlash.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashB_id]);
    assert.equal(resvB.rows[0].res.ok, true);
    assert.equal(resvB.rows[0].res.next_try_no, 2, 'Section B must reserve try 2');
    assert.equal(resvB.rows[0].res.tries_started, 1);

    // 7i. Positive test: mixed Basics, Elements, Memoriad, and Flash sections in one test
    // Section A (Flash) must recover try 3 -> next try 4 without changing sibling records.
    const dbMixed = await createBaselineStagingDb();
    const secBasics = 'dddddddd-1111-1111-1111-111111111111';
    const secElements = 'dddddddd-2222-2222-2222-222222222222';
    const secMemoriad = 'dddddddd-3333-3333-3333-333333333333';
    const secFlash = 'dddddddd-4444-4444-4444-444444444444';
    const sessFlash3 = 'eeeeeeee-4444-4444-4444-444444444444';

    await dbMixed.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Mixed Student', 'STG-MIX', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Mixed Sections Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '1 hour', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, seconds, question_count)
      VALUES ('${secBasics}', '${testId}', 1, 'basics', 60, NULL),
             ('${secElements}', '${testId}', 2, 'elements', 60, NULL),
             ('${secMemoriad}', '${testId}', 3, 'memoriad', 120, NULL),
             ('${secFlash}', '${testId}', 4, 'flash', NULL, 5);

      -- Basics attempt and score
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('fa111111-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secBasics}', 'submitted', now() - interval '40 minutes');
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secBasics}', 18, 20, 55, 'online');

      -- Elements attempt and score
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('fa111111-0000-0000-0000-000000000002', '${testId}', '${studentId}', '${secElements}', 'submitted', now() - interval '30 minutes');
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secElements}', 9, 10, 48, 'online');

      -- Memoriad attempt and score
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, status, started_at)
      VALUES ('fa111111-0000-0000-0000-000000000003', '${testId}', '${studentId}', '${secMemoriad}', 'submitted', now() - interval '20 minutes');
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secMemoriad}', 5, 5, 70, 'online');

      -- Flash attempt (try 3)
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sessFlash3}', '${studentId}', 'flash_anzan', 'Flash Try 3', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlash}', 'try_no', 3, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('fa111111-0000-0000-0000-000000000004', '${testId}', '${studentId}', '${secFlash}', '${sessFlash3}', 'started', now() - interval '10 minutes');
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlash}', 3, 5, 40, 'online');
    `);

    await dbMixed.exec(patchSql);

    // Check Basics
    const checkBasics = await dbMixed.query(`
      SELECT tries_started, tries_correct, seconds_used FROM public.weekly_test_attempts WHERE id = 'fa111111-0000-0000-0000-000000000001'
    `);
    assert.equal(checkBasics.rows[0].tries_started, 1);
    assert.equal(checkBasics.rows[0].tries_correct, 18);
    assert.equal(checkBasics.rows[0].seconds_used, 55);

    // Check Elements
    const checkElements = await dbMixed.query(`
      SELECT tries_started, tries_correct, seconds_used FROM public.weekly_test_attempts WHERE id = 'fa111111-0000-0000-0000-000000000002'
    `);
    assert.equal(checkElements.rows[0].tries_started, 1);
    assert.equal(checkElements.rows[0].tries_correct, 9);
    assert.equal(checkElements.rows[0].seconds_used, 48);

    // Check Memoriad
    const checkMemoriad = await dbMixed.query(`
      SELECT tries_started, tries_correct, seconds_used FROM public.weekly_test_attempts WHERE id = 'fa111111-0000-0000-0000-000000000003'
    `);
    assert.equal(checkMemoriad.rows[0].tries_started, 1);
    assert.equal(checkMemoriad.rows[0].tries_correct, 5);
    assert.equal(checkMemoriad.rows[0].seconds_used, 70);

    // Check Flash: recovered try 3
    const checkFlash = await dbMixed.query(`
      SELECT tries_started, tries_correct, seconds_used, session_id FROM public.weekly_test_attempts WHERE id = 'fa111111-0000-0000-0000-000000000004'
    `);
    assert.equal(checkFlash.rows[0].tries_started, 3);
    assert.equal(checkFlash.rows[0].tries_correct, 3);
    assert.equal(checkFlash.rows[0].seconds_used, 40);
    assert.equal(checkFlash.rows[0].session_id, sessFlash3);

    // Flash next reservation yields try 4
    await setCaller(dbMixed, studentId, 'service_role');
    const resvFlash = await dbMixed.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlash]);
    assert.equal(resvFlash.rows[0].res.ok, true);
    assert.equal(resvFlash.rows[0].res.next_try_no, 4, 'Flash section must reserve try 4 without changing sibling records');
    assert.equal(resvFlash.rows[0].res.tries_started, 3);

    // 7j. Directly linked wrong-section session failure:
    // Attempt for Section Flash A has session_id directly pointing to a session whose settings specify Section Flash B
    const dbWrongSec = await createBaselineStagingDb();
    const wrongSecSessId = 'ffffffff-0000-0000-0000-111111111111';
    await dbWrongSec.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level)
      VALUES ('${studentId}', 'Wrong Section Student', 'STG-WS', 'student', 'Level 2');

      INSERT INTO public.weekly_tests (id, title, test_date, test_type)
      VALUES ('${testId}', 'Wrong Section Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashA_id}', '${testId}', 1, 'flash', 5),
             ('${secFlashB_id}', '${testId}', 2, 'flash', 5);

      -- Session belongs to same student and test, but settings explicitly identify Section B
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${wrongSecSessId}', '${studentId}', 'flash_anzan', 'Session Sec B', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashB_id}', 'try_no', 2, 'question_count', 5), 'submitted');

      -- But Attempt is for Section A and directly links to this Section B session!
      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('fa222222-0000-0000-0000-000000000001', '${testId}', '${studentId}', '${secFlashA_id}', '${wrongSecSessId}', 'started', now() - interval '1 hour');
    `);

    let threwWrongSec = false;
    try {
      await dbWrongSec.exec(patchSql);
    } catch (err) {
      threwWrongSec = true;
      assert.match(err.message, /CONTRADICTORY SESSION METADATA DETECTED/i, 'Directly linked wrong-section session must abort with diagnostics');
      assert.match(err.message, new RegExp(wrongSecSessId, 'i'));
      await dbWrongSec.exec('ROLLBACK;');
    }
    assert.ok(threwWrongSec, 'Directly linked wrong-section session must fail transactionally');
  });

  it('8. Review Correction 3: Safe repeated application preserves fresh reservation timestamps and active claims', async () => {
    const db = await createBaselineStagingDb();
    const patchSql = fs.readFileSync(PREREQ_PATH, 'utf8');

    const studentId = '12345678-1234-1234-1234-123456789012';
    const testId = '23456789-2345-2345-2345-234567890123';
    const secFlashId = '34567890-3456-3456-3456-345678901234';
    const sess1Id = '45678901-4567-4567-4567-456789012345';
    const attId = '56789012-5678-5678-5678-567890123456';

    // 1. Initial setup: older Flash attempt started 2 hours ago matching real payload
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ('${studentId}', 'Older Student', 'STG-OLD', 'student', 'Level 2', true);

      INSERT INTO public.weekly_tests (id, title, test_date, test_type, opens_at, closes_at)
      VALUES ('${testId}', 'Older Test', (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', now() - interval '3 hours', now() + interval '1 day');

      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, question_count)
      VALUES ('${secFlashId}', '${testId}', 1, 'flash', 5);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status)
      VALUES ('${sess1Id}', '${studentId}', 'flash_anzan', 'Flash Try 1', jsonb_build_object('kind', 'weekly_test', 'section_kind', 'flash', 'test_id', '${testId}', 'section_id', '${secFlashId}', 'try_no', 1, 'question_count', 5), 'submitted');

      INSERT INTO public.weekly_test_attempts (id, test_id, student_id, section_id, session_id, status, started_at)
      VALUES ('${attId}', '${testId}', '${studentId}', '${secFlashId}', '${sess1Id}', 'started', now() - interval '2 hours');

      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total, time_seconds, source)
      VALUES ('${testId}', '${studentId}', '${secFlashId}', 1, 5, 12, 'online');
    `);

    // 2. First application of prerequisite patch
    await db.exec(patchSql);

    // 3. Student reserves the next try (try 2)
    await setCaller(db, studentId, 'service_role');
    const resvTry2 = await db.query(`
      SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
    `, [testId, studentId, secFlashId]);
    const r2 = resvTry2.rows[0].res;
    assert.equal(r2.ok, true);
    assert.equal(r2.next_try_no, 2);
    const activeClaimToken = r2.claim_token;
    assert.ok(activeClaimToken, 'Active claim_token must be issued');

    // Read fresh reservation state before reapplication
    const beforeReapply = await db.query(`
      SELECT updated_at, claim_token, tries_started, started_at
      FROM public.weekly_test_attempts
      WHERE id = $1
    `, [attId]);
    const freshUpdatedAt = new Date(beforeReapply.rows[0].updated_at).getTime();
    const originalStartedAt = new Date(beforeReapply.rows[0].started_at).getTime();
    assert.ok(freshUpdatedAt > originalStartedAt, 'fresh updated_at must be much newer than 2-hour-old started_at');
    assert.equal(beforeReapply.rows[0].claim_token, activeClaimToken);

    // 4. Reapply the prerequisite patch
    await db.exec(patchSql);

    // 5. Verify the fresh reservation state was NOT overwritten by reapplication!
    const afterReapply = await db.query(`
      SELECT updated_at, claim_token, tries_started
      FROM public.weekly_test_attempts
      WHERE id = $1
    `, [attId]);
    const reapplyUpdatedAt = new Date(afterReapply.rows[0].updated_at).getTime();

    // updated_at must be preserved (must NOT be set back to started_at 2 hours ago!)
    assert.equal(reapplyUpdatedAt, freshUpdatedAt, 'Reapplication must preserve fresh updated_at timestamp');
    assert.equal(afterReapply.rows[0].claim_token, activeClaimToken, 'Reapplication must preserve active claim_token');
    assert.equal(afterReapply.rows[0].tries_started, 2, 'Reapplication must preserve tries_started = 2');

    // 6. Verify an immediate competing reservation fails because active claim_token and fresh updated_at were preserved
    let threwCompeting = false;
    try {
      await db.query(`
        SELECT public.weekly_test_reserve_section_start($1, $2, $3, NULL) AS res
      `, [testId, studentId, secFlashId]);
    } catch (err) {
      threwCompeting = true;
      assert.match(err.message, /A try reservation is currently in progress for this section/i, 'Competing reservation must be blocked');
    }
    assert.ok(threwCompeting, 'Immediate competing reservation must be blocked, proving active claim was preserved');
  });
});
