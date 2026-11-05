import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { handleStartWeeklyTestSection } from '../api/weekly-test.js';

describe('Phase 16d — Student-Start / Admin-Edit Concurrency & Atomic Reservation', () => {
  let db;

  const adminId = '11111111-1111-4111-a111-111111111111';
  const student1Id = '22222222-2222-4222-a222-222222222222';
  const student2Id = '33333333-3333-4333-a333-333333333333';
  const catBasicsId = '44444444-4444-4444-a444-444444444444';

  const setCaller = async (client, userId, jwtRole = '') => {
    await client.exec(`
      SELECT set_config('app.current_user_id', '${userId}', false);
      SELECT set_config('app.current_jwt_role', '${jwtRole}', false);
    `);
  };

  before(async () => {
    db = new PGlite();

    // 1. Supabase roles and auth functions
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT json_build_object(
          'role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated')
        )::jsonb;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.flash_generate_question(
        p_digits INT,
        p_count INT,
        p_mode TEXT
      )
      RETURNS JSONB AS $$
        SELECT jsonb_build_object('numbers', jsonb_build_array(12, 34, 56));
      $$ LANGUAGE sql IMMUTABLE;
    `);

    // 2. Base tables matching Mumbai live constraints
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student',
        level TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.weekly_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_date DATE NOT NULL,
        title TEXT NOT NULL,
        notes TEXT NULL,
        created_by UUID NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NULL,
        updated_by UUID NULL,
        test_type TEXT NOT NULL DEFAULT 'offline' CHECK (test_type IN ('offline', 'online')),
        audience_level TEXT NULL,
        opens_at TIMESTAMPTZ NULL,
        closes_at TIMESTAMPTZ NULL,
        remind_days_before INT NOT NULL DEFAULT 7 CHECK (remind_days_before >= 0 AND remind_days_before <= 30),
        CONSTRAINT chk_weekly_tests_window CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 1 AND position <= 20),
        category_id UUID NULL REFERENCES public.categories(id),
        seconds INT NULL CHECK (seconds IS NULL OR seconds IN (30, 60, 120, 300)),
        kind TEXT NOT NULL CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad')),
        activity_key TEXT NULL,
        flash_digits INT NULL CHECK (flash_digits IS NULL OR (flash_digits >= 1 AND flash_digits <= 5)),
        flash_count INT NULL CHECK (flash_count IS NULL OR (flash_count >= 2 AND flash_count <= 1000)),
        flash_speed_ms INT NULL CHECK (flash_speed_ms IS NULL OR (flash_speed_ms >= 200 AND flash_speed_ms <= 5000)),
        flash_mode TEXT NULL CHECK (flash_mode IS NULL OR flash_mode IN ('add', 'add_sub')),
        question_count INT NULL CHECK (question_count IS NULL OR (question_count >= 1 AND question_count <= 10)),
        CONSTRAINT weekly_test_sections_test_id_position_key UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT weekly_test_sections_test_id_category_id_key UNIQUE (test_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id),
        student_id UUID NOT NULL REFERENCES public.profiles(id),
        section_id UUID NOT NULL REFERENCES public.weekly_test_sections(id),
        category_id UUID NULL REFERENCES public.categories(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 1,
        time_seconds INT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'online',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id),
        student_id UUID NOT NULL REFERENCES public.profiles(id),
        section_id UUID NOT NULL REFERENCES public.weekly_test_sections(id),
        category_id UUID NULL REFERENCES public.categories(id),
        session_id UUID NULL,
        status TEXT NOT NULL DEFAULT 'started',
        tries_started INT NOT NULL DEFAULT 0,
        tries_correct INT NOT NULL DEFAULT 0,
        seconds_used INT NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id),
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds INT NOT NULL DEFAULT 1,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 3. Seed lookup categories & profiles
    await db.exec(`
      INSERT INTO public.profiles (id, role, level, active) VALUES
        ('${adminId}', 'admin', 'Junior 1', true),
        ('${student1Id}', 'student', 'Junior 1', true),
        ('${student2Id}', 'student', 'Senior', true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.categories (id, name, section) VALUES
        ('${catBasicsId}', '1D 4R', 'basics')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4. Load migrations: Phase 16c (admin atomic save) & Phase 16d (reservation & safe rollback)
    const mig13Path = path.resolve('supabase/migrations/13_phase16c_atomic_weekly_test_sections.sql');
    await db.exec(fs.readFileSync(mig13Path, 'utf8'));

    const mig14Path = path.resolve('supabase/migrations/14_phase16d_atomic_weekly_test_reservation.sql');
    await db.exec(fs.readFileSync(mig14Path, 'utf8'));
  });

  beforeEach(async () => {
    await setCaller(db, adminId, '');
    // Clean test data
    await db.exec(`
      DELETE FROM public.drill_sessions;
      DELETE FROM public.weekly_test_attempts;
      DELETE FROM public.weekly_test_scores;
      DELETE FROM public.weekly_test_sections;
      DELETE FROM public.weekly_tests;
    `);
  });

  // Helper adapter to invoke RPCs through PGlite with Supabase-compatible signature
  const createAdminSupabaseAdapter = (client) => ({
    rpc: async (fnName, params) => {
      try {
        let sql = '';
        let values = [];
        if (fnName === 'weekly_test_reserve_section_start') {
          sql = 'SELECT public.weekly_test_reserve_section_start($1, $2, $3, $4) AS res;';
          values = [
            params.p_test_id,
            params.p_student_id,
            params.p_section_id || null,
            params.p_category_id || null,
          ];
        } else if (fnName === 'weekly_test_rollback_start_reservation') {
          sql = 'SELECT public.weekly_test_rollback_start_reservation($1, $2, $3) AS res;';
          values = [
            params.p_attempt_id,
            params.p_student_id,
            params.p_claim_token,
          ];
        } else if (fnName === 'save_weekly_test_sections_atomic') {
          sql = 'SELECT public.save_weekly_test_sections_atomic($1, $2, $3) AS res;';
          values = [
            params.p_test_id || null,
            JSON.stringify(params.p_test),
            JSON.stringify(params.p_sections),
          ];
        } else if (fnName === 'flash_generate_question') {
          sql = 'SELECT public.flash_generate_question($1, $2, $3) AS res;';
          values = [params.p_digits, params.p_count, params.p_mode];
        } else {
          throw new Error(`Unhandled RPC in test adapter: ${fnName}`);
        }
        const res = await client.query(sql, values);
        return { data: res.rows[0]?.res ?? null, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
    from: (table) => {
      let conditions = [];
      return {
        select: (cols) => ({
          eq: (col, val) => {
            conditions.push({ col, val });
            return {
              eq: (c2, v2) => {
                conditions.push({ col: c2, val: v2 });
                return {
                  maybeSingle: async () => {
                    const where = conditions.map((c, i) => `${c.col} = $${i + 1}`).join(' AND ');
                    const vals = conditions.map((c) => c.val);
                    const res = await client.query(`SELECT ${cols} FROM public.${table} WHERE ${where} LIMIT 1;`, vals);
                    return { data: res.rows[0] || null, error: null };
                  },
                };
              },
              maybeSingle: async () => {
                const where = conditions.map((c, i) => `${c.col} = $${i + 1}`).join(' AND ');
                const vals = conditions.map((c) => c.val);
                const res = await client.query(`SELECT ${cols} FROM public.${table} WHERE ${where} LIMIT 1;`, vals);
                return { data: res.rows[0] || null, error: null };
              },
            };
          },
        }),
        insert: (data) => ({
          select: (cols) => ({
            single: async () => {
              const keys = Object.keys(data);
              const vals = Object.values(data).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
              const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
              const sql = `INSERT INTO public.${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING ${cols};`;
              const res = await client.query(sql, vals);
              return { data: res.rows[0], error: null };
            },
          }),
        }),
        update: (data) => {
          const updateConditions = [];
          let selectCols = null;
          const execute = async () => {
            const keys = Object.keys(data);
            const vals = Object.values(data);
            const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
            const whereClause = updateConditions.map((c, i) => `${c.col} = $${keys.length + i + 1}`).join(' AND ');
            updateConditions.forEach(c => vals.push(c.val));
            const retClause = selectCols ? ` RETURNING ${selectCols}` : '';
            const sql = `UPDATE public.${table} SET ${setClause}${whereClause ? ' WHERE ' + whereClause : ''}${retClause};`;
            const res = await client.query(sql, vals);
            return { data: res.rows || [], error: null };
          };
          const builder = {
            eq: (col, val) => {
              updateConditions.push({ col, val });
              return builder;
            },
            select: (cols = '*') => {
              selectCols = cols;
              return builder;
            },
            then: (resolve, reject) => execute().then(resolve, reject),
          };
          return builder;
        },
        delete: () => ({
          eq: (col, val) => ({
            then: async (resolve) => {
              await client.query(`DELETE FROM public.${table} WHERE ${col} = $1;`, [val]);
              resolve({ error: null });
            },
          }),
        }),
      };
    },
  });

  it('1. Ordering 1: Admin edit completes first -> Student starts with updated authoritative settings', async () => {
    // 1. Admin creates an online test with Basics (seconds: 60) and Flash (count: 5)
    await setCaller(db, adminId, '');
    const saveRes1 = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Online Race Test', 'test_type', 'online', 'audience_level', 'Junior 1'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 3, "position": 2}
        ]'::jsonb
      ) AS res;
    `);

    const createdTest = saveRes1.rows[0].res;
    assert.equal(createdTest.ok, true);
    const testId = createdTest.test_id;

    const initialSecs = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position;`, [testId]);
    const basicsSec = initialSecs.rows.find(s => s.kind === 'basics');
    assert.equal(basicsSec.seconds, 60);

    // 2. Admin edits section configuration: changes Basics seconds from 60 to 120
    const saveRes2 = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        '${testId}'::uuid,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Online Race Test Updated', 'test_type', 'online', 'audience_level', 'Junior 1'),
        '[
          {"id": "${basicsSec.id}", "kind": "basics", "category_id": "${catBasicsId}", "seconds": 120, "position": 1},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 3, "position": 2}
        ]'::jsonb
      ) AS res;
    `);
    assert.equal(saveRes2.rows[0].res.ok, true);

    // 3. Admin edit has completed. Now student starts the section.
    // The student start reservation must capture the newly committed settings (seconds: 120).
    await setCaller(db, student1Id, 'authenticated');
    const adminSupabase = createAdminSupabaseAdapter(db);

    const startRes = await handleStartWeeklyTestSection({
      student: { id: student1Id },
      body: { test_id: testId, section_id: basicsSec.id },
      adminSupabase,
    });

    assert.equal(startRes.statusCode, 200, `Expected 200 OK, got: ${JSON.stringify(startRes.payload)}`);
    assert.equal(startRes.payload.ok, true);
    assert.equal(startRes.payload.seconds, 120, 'Student question generator must consume the updated seconds (120)');
    // 120 seconds duration yields poolSize 200 questions
    assert.equal(startRes.payload.questions.length, 200, 'Questions pool size must correspond to 120 seconds (200 questions)');

    // Verify attempt row was recorded with status 'started' and session_id linked
    const attCheck = await db.query(`SELECT status, session_id FROM public.weekly_test_attempts WHERE test_id = $1 AND student_id = $2;`, [testId, student1Id]);
    assert.equal(attCheck.rows[0].status, 'started');
    assert.ok(attCheck.rows[0].session_id, 'session_id should be linked');
  });

  it('2. Ordering 2: Student reservation completes first -> Conflicting admin configuration edit is rejected', async () => {
    // 1. Admin creates an online test with an Elements section ('day_codes')
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Elements Test', 'test_type', 'online'),
        '[
          {"kind": "elements", "activity_key": "day_codes", "position": 1}
        ]'::jsonb
      ) AS res;
    `);

    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const elemSecId = secRows.rows[0].id;

    // 2. Student reservation completes first: student reserves the section
    await setCaller(db, student1Id, 'authenticated');
    const reserveRes = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${elemSecId}'::uuid,
        NULL
      ) AS res;
    `);

    assert.equal(reserveRes.rows[0].res.ok, true);
    assert.equal(reserveRes.rows[0].res.kind, 'elements');
    assert.equal(reserveRes.rows[0].res.activity_key, 'day_codes');
    const attemptId = reserveRes.rows[0].res.attempt_id;
    assert.ok(attemptId, 'Attempt row must be created by reservation');

    // 3. Admin subsequently attempts to alter configuration of this reserved section
    // (changing activity_key from 'day_codes' to 'divide_by_7')
    await setCaller(db, adminId, '');
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.save_weekly_test_sections_atomic(
            '${testId}'::uuid,
            jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Elements Test Modified', 'test_type', 'online'),
            '[
              {"id": "${elemSecId}", "kind": "elements", "activity_key": "divide_by_7", "position": 1}
            ]'::jsonb
          );
        `);
      },
      (err) => {
        assert.match(err.message, /Cannot modify configuration of locked section/);
        return true;
      },
      'Admin edit modifying section configuration must be rejected because student reservation locked the section'
    );

    // 4. Admin also cannot delete the reserved section
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.save_weekly_test_sections_atomic(
            '${testId}'::uuid,
            jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Elements Test Delete Section', 'test_type', 'online'),
            '[
              {"kind": "memoriad", "activity_key": "calendar", "position": 1}
            ]'::jsonb
          );
        `);
      },
      (err) => {
        assert.match(err.message, /Cannot delete locked section/);
        return true;
      },
      'Admin edit deleting the reserved section must be rejected'
    );
  });

  it('3. Duplicate starts: strictly enforces attempt limits across all section kinds', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Duplicate Guard Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1},
          {"kind": "elements", "activity_key": "month_codes", "position": 2},
          {"kind": "memoriad", "activity_key": "calendar", "position": 3},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 2, "position": 4}
        ]'::jsonb
      ) AS res;
    `);

    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position;`, [testId]);
    const [secBasics, secElem, secMem, secFlash] = secRows.rows;

    await setCaller(db, student1Id, 'authenticated');

    // 3a. Basics duplicate start rejected
    const b1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid) AS res;`);
    assert.equal(b1.rows[0].res.ok, true);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid);`);
      },
      /You have already started this section|A start reservation is currently in progress/
    );

    // 3b. Elements duplicate start rejected
    const e1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid) AS res;`);
    assert.equal(e1.rows[0].res.ok, true);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid);`);
      },
      /You have already started this section|A start reservation is currently in progress/
    );

    // 3c. Memoriad duplicate start rejected
    const m1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secMem.id}'::uuid) AS res;`);
    assert.equal(m1.rows[0].res.ok, true);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secMem.id}'::uuid);`);
      },
      /You have already started this section|A start reservation is currently in progress/
    );
  });

  it('4. Safe recovery & retry: rollback cleans up startup failure, but NEVER removes an active or submitted attempt', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Recovery Test', 'test_type', 'online'),
        '[
          {"kind": "elements", "activity_key": "ratio", "position": 1}
        ]'::jsonb
      ) AS res;
    `);

    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    await setCaller(db, student1Id, 'authenticated');

    // 4a. Student reserves the section
    const res1 = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${secId}'::uuid
      ) AS res;
    `);
    const attemptId = res1.rows[0].res.attempt_id;
    const claimToken = res1.rows[0].res.claim_token;
    assert.ok(attemptId);
    assert.ok(claimToken);

    // 4b. Simulate startup failure BEFORE session_id is linked (e.g. Node question generator error)
    const rb1 = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${attemptId}'::uuid,
        '${student1Id}'::uuid,
        '${claimToken}'::uuid
      ) AS res;
    `);
    assert.equal(rb1.rows[0].res.rolled_back, true, 'Unstarted reservation must be cleaned up on startup failure');

    // Check row is deleted
    const countCheck1 = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(countCheck1.rows[0].cnt, 0);

    // 4c. Student retries starting the section: successfully creates a new reservation!
    const res2 = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${secId}'::uuid
      ) AS res;
    `);
    const newAttemptId = res2.rows[0].res.attempt_id;
    const newClaimToken = res2.rows[0].res.claim_token;
    assert.ok(newAttemptId);
    assert.notEqual(newAttemptId, attemptId);

    // 4d. Simulate session creation succeeding: session_id is linked to the attempt
    const dummySessionId = '99999999-9999-4999-a999-999999999999';
    await db.query(`
      UPDATE public.weekly_test_attempts
      SET session_id = '${dummySessionId}'
      WHERE id = '${newAttemptId}';
    `);

    // 4e. Now simulate a spurious rollback call: safe recovery MUST NOT delete an active attempt!
    const rb2 = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${newAttemptId}'::uuid,
        '${student1Id}'::uuid,
        '${newClaimToken}'::uuid
      ) AS res;
    `);
    assert.equal(rb2.rows[0].res.rolled_back, false, 'Rollback must refuse to delete an active attempt with a linked session');
    assert.equal(rb2.rows[0].res.reason, 'already_active_or_completed');

    // Verify row is still intact in the database
    const countCheck2 = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.weekly_test_attempts WHERE id = $1;`, [newAttemptId]);
    assert.equal(countCheck2.rows[0].cnt, 1, 'Attempt must remain intact in PostgreSQL');
  });

  it('5. Level-targeting & window protection enforced by database reservation', async () => {
    await setCaller(db, adminId, '');

    // Create test targeted to 'Senior' students only
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Senior Only Test', 'test_type', 'online', 'audience_level', 'Senior'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    // Student 1 is 'Junior 1' -> rejected
    await setCaller(db, student1Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secId}'::uuid);`);
      },
      /This weekly test is assigned to Senior students only/
    );

    // Student 2 is 'Senior' -> allowed
    await setCaller(db, student2Id, 'authenticated');
    const resSenior = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student2Id}'::uuid, '${secId}'::uuid) AS res;`);
    assert.equal(resSenior.rows[0].res.ok, true);
  });

  it('6. Security & Ownership: Student A cannot reserve or roll back an attempt for Student B', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Auth Ownership Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    // Caller is Student 1, but attempts to reserve for Student 2
    await setCaller(db, student1Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${student2Id}'::uuid,
            '${secId}'::uuid
          );
        `);
      },
      (err) => {
        assert.match(err.message, /Unauthorized: caller cannot reserve section for another student/);
        return true;
      },
      'Cross-student reservation must be rejected with 42501 Unauthorized'
    );

    // Student 2 reserves legitimately
    await setCaller(db, student2Id, 'authenticated');
    const reserveRes = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student2Id}'::uuid,
        '${secId}'::uuid
      ) AS res;
    `);
    const student2AttemptId = reserveRes.rows[0].res.attempt_id;
    const student2Token = reserveRes.rows[0].res.claim_token;
    assert.ok(student2AttemptId);

    // Caller is Student 1, but attempts to roll back Student 2's attempt
    await setCaller(db, student1Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_rollback_start_reservation(
            '${student2AttemptId}'::uuid,
            '${student2Id}'::uuid,
            '${student2Token}'::uuid
          );
        `);
      },
      (err) => {
        assert.match(err.message, /Unauthorized: caller cannot rollback attempt for another student/);
        return true;
      },
      'Cross-student rollback must be rejected with 42501 Unauthorized'
    );
  });

  it('7. Profile validation: Inactive student account or non-student role rejected by reservation', async () => {
    const inactiveStudentId = '55555555-5555-4555-a555-555555555555';
    const teacherId = '66666666-6666-4666-a666-666666666666';

    await db.exec(`
      INSERT INTO public.profiles (id, role, level, active) VALUES
        ('${inactiveStudentId}', 'student', 'Junior 1', false),
        ('${teacherId}', 'teacher', 'Junior 1', true)
      ON CONFLICT (id) DO NOTHING;
    `);

    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Profile Validation Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    // Inactive student attempt
    await setCaller(db, inactiveStudentId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${inactiveStudentId}'::uuid,
            '${secId}'::uuid
          );
        `);
      },
      (err) => {
        assert.match(err.message, /Student account .* is inactive/);
        return true;
      }
    );

    // Non-student role attempt
    await setCaller(db, teacherId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${teacherId}'::uuid,
            '${secId}'::uuid
          );
        `);
      },
      (err) => {
        assert.match(err.message, /is not a student/);
        return true;
      }
    );
  });

  it('8. Flash atomic try claim: prevents overlapping starts claiming the same try without manual updates', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Flash Concurrency Test', 'test_type', 'online'),
        '[
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 2, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const flashSecId = secRows.rows[0].id;

    await setCaller(db, student1Id, 'authenticated');

    // 8a. First start claims try 1 atomically
    const f1 = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${flashSecId}'::uuid
      ) AS res;
    `);
    assert.equal(f1.rows[0].res.ok, true);
    assert.equal(f1.rows[0].res.next_try_no, 1);
    assert.equal(f1.rows[0].res.is_first_start, true);
    const attemptId = f1.rows[0].res.attempt_id;
    const token1 = f1.rows[0].res.claim_token;
    assert.ok(token1);

    // Check in database: tries_started was atomically set to 1 and claim_token was recorded
    const check1 = await db.query(`SELECT tries_started, claim_token FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(check1.rows[0].tries_started, 1);
    assert.equal(check1.rows[0].claim_token, token1);

    // 8b. Overlapping start for try 1 (while try 1 is in progress) MUST BE REJECTED
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${student1Id}'::uuid,
            '${flashSecId}'::uuid
          );
        `);
      },
      (err) => {
        assert.match(err.message, /A try reservation is currently in progress for this section|A try is currently in progress/);
        return true;
      },
      'Second overlapping start request must not be able to claim try 1 or claim another try'
    );

    // 8c. Simulate try 1 submission (sets claim_token = null in database)
    await db.query(`UPDATE public.weekly_test_attempts SET claim_token = NULL, tries_correct = 1, seconds_used = 12 WHERE id = $1;`, [attemptId]);

    // 8d. Student starts Try 2: reservation atomically claims try 2
    const f2 = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${flashSecId}'::uuid
      ) AS res;
    `);
    assert.equal(f2.rows[0].res.ok, true);
    assert.equal(f2.rows[0].res.next_try_no, 2);
    assert.equal(f2.rows[0].res.is_first_start, false);
    const token2 = f2.rows[0].res.claim_token;
    assert.notEqual(token2, token1);

    // Check in database: tries_started is now 2 WITHOUT any manual test updates!
    const check2 = await db.query(`SELECT tries_started, claim_token FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(check2.rows[0].tries_started, 2);
    assert.equal(check2.rows[0].claim_token, token2);

    // 8e. Overlapping start for try 2 is also rejected
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${student1Id}'::uuid,
            '${flashSecId}'::uuid
          );
        `);
      },
      /A try reservation is currently in progress for this section|A try is currently in progress/
    );

    // 8f. Complete try 2 (question_count was 2, so try 2 is final)
    await db.query(`UPDATE public.weekly_test_attempts SET claim_token = NULL, status = 'submitted' WHERE id = $1;`, [attemptId]);

    // 8g. Any further start request is rejected as all tries completed
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.weekly_test_reserve_section_start(
            '${testId}'::uuid,
            '${student1Id}'::uuid,
            '${flashSecId}'::uuid
          );
        `);
      },
      /You have already completed all tries for this section/
    );
  });

  it('9. Safe recovery token ownership: Mismatched claim token cannot cancel another request reservation', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Token Guard Test', 'test_type', 'online'),
        '[
          {"kind": "elements", "activity_key": "ratio", "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    await setCaller(db, student1Id, 'authenticated');

    const res = await db.query(`
      SELECT public.weekly_test_reserve_section_start(
        '${testId}'::uuid,
        '${student1Id}'::uuid,
        '${secId}'::uuid
      ) AS res;
    `);
    const attemptId = res.rows[0].res.attempt_id;
    const validToken = res.rows[0].res.claim_token;
    const bogusToken = '77777777-7777-4777-a777-777777777777';

    // A failed/spurious request attempts rollback with bogus token
    const rbBogus = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${attemptId}'::uuid,
        '${student1Id}'::uuid,
        '${bogusToken}'::uuid
      ) AS res;
    `);
    assert.equal(rbBogus.rows[0].res.rolled_back, false);
    assert.equal(rbBogus.rows[0].res.reason, 'token_mismatch');

    // Valid attempt row must still be intact in PostgreSQL
    const check = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(check.rows[0].cnt, 1, 'Attempt row must remain intact after mismatched token rollback');

    // Rollback with valid token succeeds
    const rbValid = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${attemptId}'::uuid,
        '${student1Id}'::uuid,
        '${validToken}'::uuid
      ) AS res;
    `);
    assert.equal(rbValid.rows[0].res.rolled_back, true);
    assert.equal(rbValid.rows[0].res.action, 'attempt_deleted');
  });

  it('10. Flash try 2 rollback decrements tries_started and preserves completed try 1', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Flash Try 2 Recovery', 'test_type', 'online'),
        '[
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 3, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const flashSecId = secRows.rows[0].id;

    await setCaller(db, student1Id, 'authenticated');

    // Try 1 started and submitted
    const f1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${flashSecId}'::uuid) AS res;`);
    const attemptId = f1.rows[0].res.attempt_id;
    await db.query(`UPDATE public.weekly_test_attempts SET claim_token = NULL, tries_correct = 1, seconds_used = 15 WHERE id = $1;`, [attemptId]);

    // Try 2 reserved
    const f2 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${flashSecId}'::uuid) AS res;`);
    const token2 = f2.rows[0].res.claim_token;
    assert.equal(f2.rows[0].res.next_try_no, 2);

    // Verify DB currently has tries_started = 2
    const midCheck = await db.query(`SELECT tries_started FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(midCheck.rows[0].tries_started, 2);

    // Try 2 question generation or network fails BEFORE session_id is linked
    const rbTry2 = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${attemptId}'::uuid,
        '${student1Id}'::uuid,
        '${token2}'::uuid
      ) AS res;
    `);
    assert.equal(rbTry2.rows[0].res.rolled_back, true);
    assert.equal(rbTry2.rows[0].res.action, 'try_decremented');

    // Verify tries_started was decremented back to 1 and attempt row is NOT deleted
    const postCheck = await db.query(`SELECT tries_started, claim_token, tries_correct FROM public.weekly_test_attempts WHERE id = $1;`, [attemptId]);
    assert.equal(postCheck.rows[0].tries_started, 1);
    assert.equal(postCheck.rows[0].claim_token, null);
    assert.equal(postCheck.rows[0].tries_correct, 1);

    // Student can now retry Try 2 successfully
    const f2Retry = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${flashSecId}'::uuid) AS res;`);
    assert.equal(f2Retry.rows[0].res.ok, true);
    assert.equal(f2Retry.rows[0].res.next_try_no, 2);
  });

  it('11. Missing reservation SQL returns HTTP 500 with MIGRATION_REQUIRED error without fallback', async () => {
    // Mock adminSupabase with missing RPC error (PGRST202 / 42883)
    const mockSupabaseMissingRpc = {
      rpc: async (fnName) => {
        if (fnName === 'weekly_test_reserve_section_start') {
          return {
            data: null,
            error: {
              code: 'PGRST202',
              message: 'Could not find the function public.weekly_test_reserve_section_start in the schema cache',
            },
          };
        }
        return { data: null, error: new Error('Unexpected RPC') };
      },
      from: () => {
        throw new Error('from() should NEVER be called when reservation RPC is missing');
      },
    };

    const res = await handleStartWeeklyTestSection({
      student: { id: student1Id },
      body: { test_id: '88888888-8888-4888-a888-888888888888', section_id: '99999999-9999-4999-a999-999999999999' },
      adminSupabase: mockSupabaseMissingRpc,
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.code, 'MIGRATION_REQUIRED');
    assert.match(res.payload.error, /Atomic weekly test reservation migration required/);
  });

  it('12. Zero-row session linking: cleans up created session, performs token-guarded rollback, and returns HTTP 500', async () => {
    // 1. Admin creates online test with Basics and Flash
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Zero-Row Linking Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 2, "position": 2}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position;`, [testId]);
    const [secBasics, secFlash] = secRows.rows;

    await setCaller(db, student1Id, 'authenticated');

    // 12a. Basics: simulate zero-row match by having an adapter whose update on weekly_test_attempts matches 0 rows
    const zeroRowBasicsAdapter = createAdminSupabaseAdapter(db);
    const origFromBasics = zeroRowBasicsAdapter.from;
    zeroRowBasicsAdapter.from = (table) => {
      const b = origFromBasics(table);
      if (table === 'weekly_test_attempts') {
        const origUpdate = b.update;
        b.update = (data) => {
          const updBuilder = origUpdate(data);
          const origEq = updBuilder.eq;
          updBuilder.eq = (col, val) => {
            // Intentionally sabotage claim_token filter to simulate zero-row update
            if (col === 'claim_token') {
              return origEq(col, '00000000-0000-0000-0000-000000000000');
            }
            return origEq(col, val);
          };
          return updBuilder;
        };
      }
      return b;
    };

    const basicsRes = await handleStartWeeklyTestSection({
      student: { id: student1Id },
      body: { test_id: testId, section_id: secBasics.id },
      adminSupabase: zeroRowBasicsAdapter,
    });

    assert.equal(basicsRes.statusCode, 500);
    assert.match(basicsRes.payload.error, /Failed to link weekly test session/);
    assert.equal(basicsRes.payload.questions, undefined, 'Must not return generated questions when linking matches zero rows');

    // Verify created drill session was cleaned up
    const basicsSessions = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.drill_sessions WHERE student_id = $1;`, [student1Id]);
    assert.equal(basicsSessions.rows[0].cnt, 0, 'Orphaned drill session must be deleted on zero-row linking');

    // 12b. Flash: zero-row match on Flash start
    const zeroRowFlashAdapter = createAdminSupabaseAdapter(db);
    const origFromFlash = zeroRowFlashAdapter.from;
    zeroRowFlashAdapter.from = (table) => {
      const b = origFromFlash(table);
      if (table === 'weekly_test_attempts') {
        const origUpdate = b.update;
        b.update = (data) => {
          const updBuilder = origUpdate(data);
          const origEq = updBuilder.eq;
          updBuilder.eq = (col, val) => {
            if (col === 'claim_token') {
              return origEq(col, '00000000-0000-0000-0000-000000000000');
            }
            return origEq(col, val);
          };
          return updBuilder;
        };
      }
      return b;
    };

    const flashRes = await handleStartWeeklyTestSection({
      student: { id: student1Id },
      body: { test_id: testId, section_id: secFlash.id },
      adminSupabase: zeroRowFlashAdapter,
    });

    assert.equal(flashRes.statusCode, 500);
    assert.match(flashRes.payload.error, /Failed to record Flash try start/);
    assert.equal(flashRes.payload.numbers, undefined, 'Must not return generated Flash numbers on zero-row linking');

    // Verify created drill session was cleaned up
    const flashSessions = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.drill_sessions WHERE student_id = $1;`, [student1Id]);
    assert.equal(flashSessions.rows[0].cnt, 0, 'Orphaned Flash drill session must be deleted on zero-row linking');
  });

  it('13. An old request completing after its reservation was reclaimed: fails safely without affecting the replacement reservation', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Reclaim Race Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1;`, [testId]);
    const secId = secRows.rows[0].id;

    await setCaller(db, student1Id, 'authenticated');

    let req2Result = null;
    let req1SessionId = null;

    // Build adapter for Request 1: intercepts right before weekly_test_attempts update
    const req1Adapter = createAdminSupabaseAdapter(db);
    const origReq1From = req1Adapter.from;
    req1Adapter.from = (table) => {
      const b = origReq1From(table);
      if (table === 'weekly_test_attempts') {
        const origUpdate = b.update;
        b.update = (data) => {
          const updBuilder = origUpdate(data);
          const origThen = updBuilder.then;
          updBuilder.then = async (resolve, reject) => {
            // Request 1 is paused right before linking session.
            // Simulate time passing (>60s) so reservation becomes stale:
            await db.query(`UPDATE public.weekly_test_attempts SET updated_at = NOW() - INTERVAL '70 seconds' WHERE test_id = $1 AND student_id = $2;`, [testId, student1Id]);

            // Request 2 runs concurrently and reclaims the reservation!
            const req2Adapter = createAdminSupabaseAdapter(db);
            req2Result = await handleStartWeeklyTestSection({
              student: { id: student1Id },
              body: { test_id: testId, section_id: secId },
              adminSupabase: req2Adapter,
            });

            // Now Request 1 resumes its update attempt
            return origThen(resolve, reject);
          };
          return updBuilder;
        };
      } else if (table === 'drill_sessions') {
        const origInsert = b.insert;
        b.insert = (data) => {
          const insBuilder = origInsert(data);
          const origSelect = insBuilder.select;
          insBuilder.select = (cols) => {
            const selBuilder = origSelect(cols);
            const origSingle = selBuilder.single;
            selBuilder.single = async () => {
              const res = await origSingle();
              req1SessionId = res.data?.id;
              return res;
            };
            return selBuilder;
          };
          return insBuilder;
        };
      }
      return b;
    };

    // Run Request 1
    const req1Result = await handleStartWeeklyTestSection({
      student: { id: student1Id },
      body: { test_id: testId, section_id: secId },
      adminSupabase: req1Adapter,
    });

    // Request 2 must have succeeded (200 OK)
    assert.ok(req2Result);
    assert.equal(req2Result.statusCode, 200);
    assert.equal(req2Result.payload.ok, true);
    const req2SessionId = req2Result.payload.session_id;
    assert.ok(req2SessionId);

    // Request 1 must have failed with 500 (zero rows updated because claim_token was rotated)
    assert.equal(req1Result.statusCode, 500);
    assert.match(req1Result.payload.error, /Failed to link weekly test session/);

    // Request 1's drill session must have been deleted
    assert.ok(req1SessionId);
    assert.notEqual(req1SessionId, req2SessionId);
    const checkReq1Session = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.drill_sessions WHERE id = $1;`, [req1SessionId]);
    assert.equal(checkReq1Session.rows[0].cnt, 0, 'Reclaimed request drill session must be deleted');

    // Request 2's drill session and attempt must remain active and intact
    const checkReq2Session = await db.query(`SELECT status FROM public.drill_sessions WHERE id = $1;`, [req2SessionId]);
    assert.equal(checkReq2Session.rows[0].status, 'open', 'Replacement reservation drill session must remain open');

    const checkAttempt = await db.query(`SELECT session_id, status FROM public.weekly_test_attempts WHERE test_id = $1 AND student_id = $2;`, [testId, student1Id]);
    assert.equal(checkAttempt.rows[0].session_id, req2SessionId, 'Attempt must be linked to Request 2 session, not Request 1');
    assert.equal(checkAttempt.rows[0].status, 'started');
  });

  it('14. Stale unlinked reservation recovery for all four kinds: Basics, Elements, Memoriad, Flash', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'All Kinds Recovery Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1},
          {"kind": "elements", "activity_key": "day_codes", "position": 2},
          {"kind": "memoriad", "activity_key": "calendar", "position": 3},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 3, "position": 4}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position;`, [testId]);
    const [secBasics, secElem, secMem, secFlash] = secRows.rows;

    await setCaller(db, student1Id, 'authenticated');

    // 14a. Initial reservation for all 4 kinds
    const rB1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid) AS res;`);
    const rE1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid) AS res;`);
    const rM1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secMem.id}'::uuid) AS res;`);
    const rF1 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secFlash.id}'::uuid) AS res;`);

    assert.equal(rB1.rows[0].res.ok, true);
    assert.equal(rE1.rows[0].res.ok, true);
    assert.equal(rM1.rows[0].res.ok, true);
    assert.equal(rF1.rows[0].res.ok, true);

    const tokenB1 = rB1.rows[0].res.claim_token;
    const tokenE1 = rE1.rows[0].res.claim_token;
    const tokenM1 = rM1.rows[0].res.claim_token;
    const tokenF1 = rF1.rows[0].res.claim_token;

    // Fresh duplicate starts (<60s) must be rejected
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid);`),
      /A start reservation is currently in progress for this section/
    );
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid);`),
      /A start reservation is currently in progress for this section/
    );
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secMem.id}'::uuid);`),
      /A start reservation is currently in progress for this section/
    );
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secFlash.id}'::uuid);`),
      /A try reservation is currently in progress for this section|A try is currently in progress/
    );

    // Simulate interruption/stale reservations (>60s elapsed without session linking)
    await db.query(`UPDATE public.weekly_test_attempts SET updated_at = NOW() - INTERVAL '70 seconds' WHERE test_id = $1 AND student_id = $2;`, [testId, student1Id]);

    // 14b. Recovery: all 4 kinds successfully recover and rotate claim tokens
    const rB2 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid) AS res;`);
    const rE2 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid) AS res;`);
    const rM2 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secMem.id}'::uuid) AS res;`);
    const rF2 = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secFlash.id}'::uuid) AS res;`);

    assert.equal(rB2.rows[0].res.ok, true);
    assert.equal(rE2.rows[0].res.ok, true);
    assert.equal(rM2.rows[0].res.ok, true);
    assert.equal(rF2.rows[0].res.ok, true);

    const tokenB2 = rB2.rows[0].res.claim_token;
    const tokenE2 = rE2.rows[0].res.claim_token;
    const tokenM2 = rM2.rows[0].res.claim_token;
    const tokenF2 = rF2.rows[0].res.claim_token;

    assert.notEqual(tokenB2, tokenB1, 'Basics claim token must rotate on recovery');
    assert.notEqual(tokenE2, tokenE1, 'Elements claim token must rotate on recovery');
    assert.notEqual(tokenM2, tokenM1, 'Memoriad claim token must rotate on recovery');
    assert.notEqual(tokenF2, tokenF1, 'Flash claim token must rotate on recovery');

    // Attempt IDs remain identical (reclaimed in-place)
    assert.equal(rB2.rows[0].res.attempt_id, rB1.rows[0].res.attempt_id);
    assert.equal(rE2.rows[0].res.attempt_id, rE1.rows[0].res.attempt_id);
    assert.equal(rM2.rows[0].res.attempt_id, rM1.rows[0].res.attempt_id);
    assert.equal(rF2.rows[0].res.attempt_id, rF1.rows[0].res.attempt_id);

    // Flash try number remains 1
    assert.equal(rF2.rows[0].res.next_try_no, 1);
  });

  it('15. Preservation of linked sessions, submitted attempts, and completed scores', async () => {
    await setCaller(db, adminId, '');
    const saveRes = await db.query(`
      SELECT public.save_weekly_test_sections_atomic(
        NULL,
        jsonb_build_object('test_date', CURRENT_DATE::text, 'title', 'Preservation Test', 'test_type', 'online'),
        '[
          {"kind": "basics", "category_id": "${catBasicsId}", "seconds": 60, "position": 1},
          {"kind": "elements", "activity_key": "day_codes", "position": 2},
          {"kind": "flash", "flash_digits": 1, "flash_count": 5, "flash_speed_ms": 1000, "flash_mode": "add", "question_count": 2, "position": 3}
        ]'::jsonb
      ) AS res;
    `);
    const testId = saveRes.rows[0].res.test_id;
    const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position;`, [testId]);
    const [secBasics, secElem, secFlash] = secRows.rows;

    await setCaller(db, student1Id, 'authenticated');

    // 15a. Linked session preservation: even when updated_at is 2 hours old!
    const rB = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid) AS res;`);
    const basicsAttemptId = rB.rows[0].res.attempt_id;
    const basicsToken = rB.rows[0].res.claim_token;
    const dummySessionId = '88888888-8888-4888-a888-888888888888';

    await db.query(`
      UPDATE public.weekly_test_attempts
      SET session_id = '${dummySessionId}', updated_at = NOW() - INTERVAL '2 hours'
      WHERE id = '${basicsAttemptId}';
    `);

    // Reservation MUST reject: linked sessions are never reclaimed!
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secBasics.id}'::uuid);`),
      /You have already started this section/
    );

    // Rollback MUST refuse to remove linked session
    const rbLinked = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${basicsAttemptId}'::uuid,
        '${student1Id}'::uuid,
        '${basicsToken}'::uuid
      ) AS res;
    `);
    assert.equal(rbLinked.rows[0].res.rolled_back, false);
    assert.equal(rbLinked.rows[0].res.reason, 'already_active_or_completed');

    // 15b. Submitted attempt preservation
    const rE = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid) AS res;`);
    const elemAttemptId = rE.rows[0].res.attempt_id;
    const elemToken = rE.rows[0].res.claim_token;

    await db.query(`
      UPDATE public.weekly_test_attempts
      SET status = 'submitted', updated_at = NOW() - INTERVAL '2 hours'
      WHERE id = '${elemAttemptId}';
    `);

    // Reservation MUST reject
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid);`),
      /You have already completed this section/
    );

    // Rollback MUST refuse
    const rbSubmitted = await db.query(`
      SELECT public.weekly_test_rollback_start_reservation(
        '${elemAttemptId}'::uuid,
        '${student1Id}'::uuid,
        '${elemToken}'::uuid
      ) AS res;
    `);
    assert.equal(rbSubmitted.rows[0].res.rolled_back, false);
    assert.equal(rbSubmitted.rows[0].res.reason, 'already_active_or_completed');

    // 15c. Completed score and attempt preservation (Flash and non-Flash)
    // Non-flash completed score:
    await db.query(`
      INSERT INTO public.weekly_test_scores (
        test_id, student_id, section_id, correct, total, time_seconds, source
      ) VALUES (
        '${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid, 10, 10, 50, 'online'
      ) ON CONFLICT (test_id, student_id, section_id) DO NOTHING;
    `);
    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secElem.id}'::uuid);`),
      /You have already completed this section/
    );

    // Flash completed all tries:
    const rF = await db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secFlash.id}'::uuid) AS res;`);
    const flashAttemptId = rF.rows[0].res.attempt_id;
    await db.exec(`
      UPDATE public.weekly_test_attempts
      SET status = 'submitted', claim_token = NULL, tries_started = 2, tries_correct = 2, updated_at = NOW() - INTERVAL '2 hours'
      WHERE id = '${flashAttemptId}';
      UPDATE public.weekly_test_scores
      SET correct = 2, total = 2, time_seconds = 20
      WHERE test_id = '${testId}'::uuid AND student_id = '${student1Id}'::uuid AND section_id = '${secFlash.id}'::uuid;
    `);

    await assert.rejects(
      async () => db.query(`SELECT public.weekly_test_reserve_section_start('${testId}'::uuid, '${student1Id}'::uuid, '${secFlash.id}'::uuid);`),
      /You have already completed all tries for this section/
    );
  });
});
