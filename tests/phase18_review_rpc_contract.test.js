/**
 * Phase 18 — Review Frontend RPC Contract Verification
 * (tests/phase18_review_rpc_contract.test.js)
 *
 * Executes the actual application callers from js/review.js against the real
 * PostgreSQL database schema to verify:
 * 1. resolveCorrectionTableName maps score sources to allowed tables ('results', 'activity_results').
 * 2. executeSetVerified executes teacher_verify_scores with (p_ids, p_verified, p_reason).
 * 3. executeSetFlag executes teacher_flag_score with (p_id, p_flagged, p_note).
 * 4. executeCorrectResult executes teacher_request_score_correction with (p_result_id, p_table_name, p_proposed_correct, p_proposed_total, p_proposed_time_seconds, p_reason).
 * 5. Submitting a correction request does NOT immediately modify the underlying score.
 * 6. executeAdminDecideCorrection executes admin_decide_score_correction with (p_request_id, p_action = 'approve' | 'reject', p_decision_note).
 * 7. Approving applies the proposed score, stamping corrected_by and corrected_at.
 * 8. Rejecting preserves original score, setting request status = 'rejected'.
 * 9. Activity results corrections map to 'activity_results' and apply cleanly.
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  ALLOWED_CORRECTION_TABLES,
  resolveCorrectionTableName,
  executeSetVerified,
  executeSetFlag,
  executeCorrectResult,
  executeAdminDecideCorrection,
} from '../js/review.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Setup minimal DOM for toast notifications triggered by review controller callers
function createMockElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    style: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
    addEventListener() {},
    remove() {},
    classList: {
      add() {},
      remove() {}
    }
  };
}

if (!globalThis.document) {
  globalThis.document = {
    getElementById: () => null,
    createElement: (tag) => createMockElement(tag),
    body: createMockElement('body')
  };
}

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

describe('Phase 18 — Review Controller RPC Contract & Application Caller Tests', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const teacherId = '22222222-2222-2222-2222-222222222222';
  const studentAId = '33333333-3333-3333-3333-333333333333';
  const studentBId = '44444444-4444-4444-4444-444444444444';
  const categoryId = '55555555-5555-5555-5555-555555555555';

  const adminProfile = { id: adminId, role: 'admin', full_name: 'Admin User' };
  const teacherProfile = { id: teacherId, role: 'teacher', full_name: 'Teacher User' };

  // RPC Client adapter that dispatches via named arguments in PostgreSQL
  function createPostgresRpcClient(database) {
    return {
      async rpc(fnName, params = {}) {
        const keys = Object.keys(params);
        const values = Object.values(params);
        const namedArgs = keys.map((k, idx) => `${k} := $${idx + 1}`).join(', ');
        const sql = `SELECT public.${fnName}(${namedArgs}) AS result;`;
        try {
          const res = await database.query(sql, values);
          return { data: res.rows[0]?.result ?? null, error: null };
        } catch (err) {
          return { data: null, error: { message: err.message, code: err.code } };
        }
      },
    };
  }

  async function asUser(userId, role = 'authenticated', fn) {
    await db.exec(`SET app.current_user_id = '${userId}'; SET app.current_jwt_role = '${role}'; SET ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE; SET app.current_user_id = ''; SET app.current_jwt_role = '';`);
    }
  }

  before(async () => {
    db = new PGlite();

    // 1. Setup base roles & auth schema
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role BYPASSRLS;
        ELSE
          ALTER ROLE service_role BYPASSRLS;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$ SELECT '{}'::jsonb; $$ LANGUAGE sql STABLE;

      -- Base Profiles
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true
      );

      -- Base Categories
      CREATE TABLE public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 1
      );

      -- Base Results
      CREATE TABLE public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        time_seconds INTEGER,
        student_round_id UUID,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        source TEXT NOT NULL DEFAULT 'typed',
        practice_mode TEXT,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        verified BOOLEAN NOT NULL DEFAULT false,
        verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        verified_at TIMESTAMPTZ,
        corrected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        corrected_at TIMESTAMPTZ,
        note TEXT,
        import_batch_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.today_ist()
      RETURNS DATE AS $$
        SELECT (timezone('Asia/Kolkata', now()))::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin()
      RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid() AND role = 'admin' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;
    `);

    // 2. Apply Staging Prerequisites and Migration 16
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');
    const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase18_atomic_migration.sql'), 'utf8');

    await db.exec(prereqSql);
    await db.exec(migrationSql);

    // 3. Seed test fixtures
    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES
        ('${adminId}', 'admin', 'ADM001', 'Admin Alice', 'Grandmaster', true),
        ('${teacherId}', 'teacher', 'TCH001', 'Teacher Tom', 'Senior', true),
        ('${studentAId}', 'student', 'STU001', 'Student Sam', 'Senior', true),
        ('${studentBId}', 'student', 'STU002', 'Student Ben', 'Senior', true);

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES ('${categoryId}', 'Direct 1D', 'basics', 1);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES 
        ('${teacherId}', '${studentAId}'),
        ('${teacherId}', '${studentBId}');

      INSERT INTO public.teacher_permissions (teacher_id)
      VALUES ('${teacherId}');
    `);
  });

  it('1. resolveCorrectionTableName derives allowed tables and falls back safely', () => {
    assert.deepEqual(ALLOWED_CORRECTION_TABLES, ['results', 'activity_results']);

    assert.equal(resolveCorrectionTableName(null), 'results');
    assert.equal(resolveCorrectionTableName(undefined), 'results');
    assert.equal(resolveCorrectionTableName(''), 'results');
    assert.equal(resolveCorrectionTableName('results'), 'results');
    assert.equal(resolveCorrectionTableName('typed'), 'results');
    assert.equal(resolveCorrectionTableName('sheet_sync'), 'results');
    assert.equal(resolveCorrectionTableName('round'), 'results');
    assert.equal(resolveCorrectionTableName('site'), 'results');

    assert.equal(resolveCorrectionTableName('activity_results'), 'activity_results');
    assert.equal(resolveCorrectionTableName('element'), 'activity_results');
    assert.equal(resolveCorrectionTableName('elements'), 'activity_results');
    assert.equal(resolveCorrectionTableName('flash'), 'activity_results');
    assert.equal(resolveCorrectionTableName('flash_anzan'), 'activity_results');
    assert.equal(resolveCorrectionTableName('memoriad'), 'activity_results');

    // From entry objects
    assert.equal(resolveCorrectionTableName({ table_name: 'results' }), 'results');
    assert.equal(resolveCorrectionTableName({ table_name: 'activity_results' }), 'activity_results');
    assert.equal(resolveCorrectionTableName({ activity_type: 'element' }), 'activity_results');
    assert.equal(resolveCorrectionTableName({ source: 'flash' }), 'activity_results');
    assert.equal(resolveCorrectionTableName({ source: 'typed' }), 'results');
    assert.equal(resolveCorrectionTableName({ source: 'unknown_source' }), 'results');
  });

  it('2. executeSetVerified executes teacher_verify_scores using p_ids (not p_result_ids)', async () => {
    const resultId = 'aaaaaaaa-1111-1111-1111-111111111111';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified)
      VALUES ('${resultId}', '${studentAId}', '${categoryId}', 18, 20, 60, false);
    `);

    const client = createPostgresRpcClient(db);

    await asUser(teacherId, 'authenticated', async () => {
      await executeSetVerified([resultId], true, 'Verified against paper', client, teacherProfile);
    });

    const verifyCheck = await db.query(`SELECT verified, verified_by FROM public.results WHERE id = '${resultId}';`);
    assert.equal(verifyCheck.rows[0].verified, true, 'Score marked verified in database');
    assert.equal(verifyCheck.rows[0].verified_by, teacherId, 'Verified_by stamped with teacher ID');

    // Unverify
    await asUser(teacherId, 'authenticated', async () => {
      await executeSetVerified([resultId], false, 'Unverified for recount', client, teacherProfile);
    });

    const unverifyCheck = await db.query(`SELECT verified, verified_by FROM public.results WHERE id = '${resultId}';`);
    assert.equal(unverifyCheck.rows[0].verified, false, 'Score marked unverified');
  });

  it('3. executeSetFlag executes teacher_flag_score using p_id and p_note (not p_result_id / p_flag_note)', async () => {
    const resultId = 'bbbbbbbb-2222-2222-2222-222222222222';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, flagged)
      VALUES ('${resultId}', '${studentAId}', '${categoryId}', 12, 20, 45, false);
    `);

    const client = createPostgresRpcClient(db);

    await asUser(teacherId, 'authenticated', async () => {
      await executeSetFlag(resultId, true, 'Please recount problem 3', client, teacherProfile);
    });

    const flagCheck = await db.query(`SELECT flagged, flag_note FROM public.results WHERE id = '${resultId}';`);
    assert.equal(flagCheck.rows[0].flagged, true, 'Score marked flagged in database');
    assert.equal(flagCheck.rows[0].flag_note, 'Please recount problem 3', 'Flag note recorded');

    // Clear flag
    await asUser(teacherId, 'authenticated', async () => {
      await executeSetFlag(resultId, false, null, client, teacherProfile);
    });

    const clearCheck = await db.query(`SELECT flagged, flag_note FROM public.results WHERE id = '${resultId}';`);
    assert.equal(clearCheck.rows[0].flagged, false, 'Flag cleared in database');
  });

  it('4. Submitting a correction request does NOT immediately change the score, and approval applies it', async () => {
    const resultId = 'cccccccc-3333-3333-3333-333333333333';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, note)
      VALUES ('${resultId}', '${studentAId}', '${categoryId}', 14, 20, 50, 'Original note');
    `);

    const client = createPostgresRpcClient(db);

    // 1. Teacher submits correction request via application caller
    let reqRes;
    await asUser(teacherId, 'authenticated', async () => {
      reqRes = await executeCorrectResult(
        resultId,
        16, // proposed correct
        20, // proposed total
        52, // proposed time_seconds
        'Should be ignored in teacher mode',
        'Teacher verified: Question 7 miscounted',
        'results',
        client,
        teacherProfile
      );
    });

    assert.ok(reqRes.success, 'Correction request successfully submitted');
    const requestId = reqRes.request_id;
    assert.ok(requestId, 'Returned valid request UUID');

    // 2. CRITICAL INVARIANT: The underlying score in results MUST NOT BE CHANGED YET!
    const unchangedCheck = await db.query(`SELECT correct, total, time_seconds, corrected_by FROM public.results WHERE id = '${resultId}';`);
    assert.equal(unchangedCheck.rows[0].correct, 14, 'Original correct score remains 14 (not immediately changed)');
    assert.equal(unchangedCheck.rows[0].total, 20, 'Original total remains 20');
    assert.equal(unchangedCheck.rows[0].time_seconds, 50, 'Original time_seconds remains 50');
    assert.equal(unchangedCheck.rows[0].corrected_by, null, 'Corrected_by is still null');

    // 3. Verify request in score_correction_requests
    const reqRow = await db.query(`SELECT * FROM public.score_correction_requests WHERE id = '${requestId}';`);
    assert.equal(reqRow.rows[0].status, 'pending');
    assert.equal(reqRow.rows[0].proposed_correct, 16);
    assert.equal(reqRow.rows[0].proposed_total, 20);
    assert.equal(reqRow.rows[0].table_name, 'results');
    assert.equal(reqRow.rows[0].reason, 'Teacher verified: Question 7 miscounted');

    // 4. Admin approves correction request via application caller (p_action: 'approve')
    await asUser(adminId, 'authenticated', async () => {
      await executeAdminDecideCorrection(requestId, 'approve', 'Approved after review', client);
    });

    // 5. Score in results is NOW updated and stamped!
    const approvedCheck = await db.query(`SELECT correct, total, time_seconds, corrected_by, verified, verified_by FROM public.results WHERE id = '${resultId}';`);
    assert.equal(approvedCheck.rows[0].correct, 16, 'Score correct is updated to proposed value 16');
    assert.equal(approvedCheck.rows[0].total, 20, 'Total is 20');
    assert.equal(approvedCheck.rows[0].time_seconds, 52, 'Time is updated to 52');
    assert.equal(approvedCheck.rows[0].corrected_by, teacherId, 'Corrected_by stamped with teacher ID');
    assert.equal(approvedCheck.rows[0].verified, true, 'Verified set to true on approval');
    assert.equal(approvedCheck.rows[0].verified_by, adminId, 'Verified_by stamped with admin ID');

    // 6. Request status is updated to 'approved'
    const finalReq = await db.query(`SELECT status, decided_by FROM public.score_correction_requests WHERE id = '${requestId}';`);
    assert.equal(finalReq.rows[0].status, 'approved');
    assert.equal(finalReq.rows[0].decided_by, adminId);
  });

  it('5. Admin rejecting a correction request preserves original score and records decision note', async () => {
    const resultId = 'dddddddd-4444-4444-4444-444444444444';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds)
      VALUES ('${resultId}', '${studentBId}', '${categoryId}', 10, 15, 30);
    `);

    const client = createPostgresRpcClient(db);

    let reqRes;
    await asUser(teacherId, 'authenticated', async () => {
      reqRes = await executeCorrectResult(
        resultId,
        15, // proposed correct
        15,
        28,
        null,
        'Proposed perfect score',
        'results',
        client,
        teacherProfile
      );
    });

    const requestId = reqRes.request_id;

    // Admin rejects request (p_action: 'reject')
    await asUser(adminId, 'authenticated', async () => {
      await executeAdminDecideCorrection(requestId, 'reject', 'Recheck sheet: question 4 was incorrect', client);
    });

    // Score remains completely untouched
    const scoreCheck = await db.query(`SELECT correct, total, corrected_by FROM public.results WHERE id = '${resultId}';`);
    assert.equal(scoreCheck.rows[0].correct, 10, 'Score remains unchanged at 10');
    assert.equal(scoreCheck.rows[0].corrected_by, null, 'Corrected_by remains null');

    // Request is marked rejected
    const reqCheck = await db.query(`SELECT status, decision_note, decided_by FROM public.score_correction_requests WHERE id = '${requestId}';`);
    assert.equal(reqCheck.rows[0].status, 'rejected');
    assert.equal(reqCheck.rows[0].decision_note, 'Recheck sheet: question 4 was incorrect');
    assert.equal(reqCheck.rows[0].decided_by, adminId);
  });

  it('6. Correction requests for activity_results resolve table_name and apply accurately', async () => {
    const actId = 'eeeeeeee-5555-5555-5555-555555555555';
    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds)
      VALUES ('${actId}', '${studentAId}', 'element', 'Square 1 to 25', 20, 25, 45);
    `);

    const client = createPostgresRpcClient(db);

    // Teacher submits correction with table_name = 'activity_results'
    let reqRes;
    await asUser(teacherId, 'authenticated', async () => {
      reqRes = await executeCorrectResult(
        actId,
        22, // proposed correct
        25,
        42,
        null,
        'Teacher review: answer 24 was actually correct',
        'activity_results',
        client,
        teacherProfile
      );
    });

    assert.ok(reqRes.success);
    const requestId = reqRes.request_id;

    // Original score untouched before approval
    const preCheck = await db.query(`SELECT correct FROM public.activity_results WHERE id = '${actId}';`);
    assert.equal(preCheck.rows[0].correct, 20);

    // Admin approves
    await asUser(adminId, 'authenticated', async () => {
      await executeAdminDecideCorrection(requestId, 'approve', 'Approved element correction', client);
    });

    // Activity result updated to 22/25
    const postCheck = await db.query(`SELECT correct, total, time_seconds FROM public.activity_results WHERE id = '${actId}';`);
    assert.equal(postCheck.rows[0].correct, 22, 'Activity result updated to 22');
    assert.equal(postCheck.rows[0].total, 25, 'Activity result total preserved at 25');
  });

  it('7. executeAdminDecideCorrection rejects invalid actions before hitting the database', async () => {
    const client = createPostgresRpcClient(db);

    await assert.rejects(
      async () => {
        await executeAdminDecideCorrection('00000000-0000-0000-0000-000000000000', 'approved', 'Note', client);
      },
      /Invalid action: must be 'approve' or 'reject'/
    );

    await assert.rejects(
      async () => {
        await executeAdminDecideCorrection('00000000-0000-0000-0000-000000000000', 'rejected', 'Note', client);
      },
      /Invalid action: must be 'approve' or 'reject'/
    );
  });
});
