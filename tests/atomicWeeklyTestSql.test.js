/**
 * Isolated PostgreSQL Engine Unit Tests for save_weekly_test_sections_atomic
 *
 * Uses real PostgreSQL (via PGlite WebAssembly) to execute and verify:
 * - Exact live Mumbai schema columns, default 7 reminder, and strict check constraints
 * - Transaction-safe reordering with DEFERRABLE INITIALLY DEFERRED unique constraint
 * - Protection of locked sections from BOTH deletion and configuration changes
 * - Category section compatibility (Basics in basics, Round in round)
 * - Online Basics question generation support validation
 * - Elements enabled activity key validation (23 drills enabled, modulo disabled)
 * - 12-section application limit enforcement
 * - True transactional rollback after actual mutations to parent and sections
 */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 16c — Isolated PostgreSQL Engine: save_weekly_test_sections_atomic', () => {
  let db;
  const adminId = '11111111-1111-1111-1111-111111111111';
  const studentId = '22222222-2222-2222-2222-222222222222';
  const catBasicsId = '33333333-3333-3333-3333-333333333333';
  const catBasicsUnsupportedId = '33333333-3333-3333-3333-333333333334';
  const catRoundId = '44444444-4444-4444-4444-444444444444';
  const catMismatchedId = '55555555-5555-5555-5555-555555555555';

  before(async () => {
    db = new PGlite();

    // 1. Create standard Supabase roles if they do not exist
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;
    `);

    // 2. Setup auth mocks in PostgreSQL session
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), '11111111-1111-1111-1111-111111111111')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object('role', current_setting('app.current_jwt_role', true));
      $$ LANGUAGE sql STABLE;
    `);

    // 3. Setup live Mumbai schema and exact constraints
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student'
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        section TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.weekly_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_date DATE NOT NULL,
        title TEXT NOT NULL,
        notes TEXT NULL,
        created_by UUID NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
        CONSTRAINT chk_sec_basics CHECK (kind <> 'basics' OR category_id IS NOT NULL),
        CONSTRAINT chk_sec_round CHECK (kind <> 'round' OR (category_id IS NOT NULL AND seconds IS NULL)),
        CONSTRAINT chk_sec_elements CHECK (kind <> 'elements' OR activity_key IS NOT NULL),
        CONSTRAINT chk_sec_memoriad CHECK (kind <> 'memoriad' OR activity_key IS NOT NULL),
        CONSTRAINT chk_sec_flash CHECK (kind <> 'flash' OR (flash_digits IS NOT NULL AND flash_count IS NOT NULL AND flash_speed_ms IS NOT NULL AND flash_mode IS NOT NULL AND question_count IS NOT NULL)),
        CONSTRAINT weekly_test_sections_test_id_position_key UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT weekly_test_sections_test_id_category_id_key UNIQUE (test_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id),
        student_id UUID NOT NULL REFERENCES public.profiles(id),
        section_id UUID NOT NULL REFERENCES public.weekly_test_sections(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id),
        student_id UUID NOT NULL REFERENCES public.profiles(id),
        section_id UUID NOT NULL REFERENCES public.weekly_test_sections(id),
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 4. Seed lookup categories
    await db.exec(`
      INSERT INTO public.profiles (id, role) VALUES
        ('${adminId}', 'admin'),
        ('${studentId}', 'student')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.categories (id, name, section) VALUES
        ('${catBasicsId}', '1D 4R', 'basics'),
        ('${catBasicsUnsupportedId}', 'Advanced Abacus 9D', 'basics'),
        ('${catRoundId}', 'Addition Round 1', 'round'),
        ('${catMismatchedId}', 'Miscellaneous Category', 'other')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 5. Load the actual migration script into the database
    const migrationPath = path.resolve('supabase/migrations/13_phase16c_atomic_weekly_test_sections.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);
  });

  const setCaller = async (userId, jwtRole = '') => {
    await db.exec(`
      SELECT set_config('app.current_user_id', '${userId}', false);
      SELECT set_config('app.current_jwt_role', '${jwtRole}', false);
    `);
  };

  beforeEach(async () => {
    await setCaller(adminId, '');
  });

  it('1. Live constraints: remind_days_before handles omission with default 7, preserves on edit, and rejects invalid values', async () => {
    // 1a. Creation with omitted remind_days_before uses 7
    const payloadOmitted = JSON.stringify({
      test_date: '2026-11-12',
      title: 'Reminder Default Test',
      test_type: 'offline',
    });
    const sections = JSON.stringify([{ kind: 'basics', category_id: catBasicsId, seconds: 60 }]);

    const resCreated = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [payloadOmitted, sections]
    );
    const testId = resCreated.rows[0].result.test_id;

    const rowCreated = await db.query(`SELECT remind_days_before FROM public.weekly_tests WHERE id = $1`, [testId]);
    assert.equal(rowCreated.rows[0].remind_days_before, 7, 'Omitted reminder on creation must default to 7');

    // 1b. Edit with explicit reminder (e.g. 14) updates correctly
    const payloadExplicit = JSON.stringify({
      test_date: '2026-11-12',
      title: 'Reminder Explicit Test',
      test_type: 'offline',
      remind_days_before: 14,
    });
    await db.query(
      `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
      [testId, payloadExplicit, sections]
    );
    const rowExplicit = await db.query(`SELECT remind_days_before FROM public.weekly_tests WHERE id = $1`, [testId]);
    assert.equal(rowExplicit.rows[0].remind_days_before, 14);

    // 1c. Edit with omitted reminder preserves previous value (14) without writing NULL
    const payloadEditOmitted = JSON.stringify({
      test_date: '2026-11-12',
      title: 'Reminder Preserved Test',
      test_type: 'offline',
    });
    await db.query(
      `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
      [testId, payloadEditOmitted, sections]
    );
    const rowPreserved = await db.query(`SELECT remind_days_before FROM public.weekly_tests WHERE id = $1`, [testId]);
    assert.equal(rowPreserved.rows[0].remind_days_before, 14, 'Omitted reminder on edit must preserve existing reminder');

    // 1d. Invalid reminder values (< 0 or > 30) are rejected with error code 22023
    for (const badVal of [-1, 31, 99]) {
      await assert.rejects(
        async () => {
          await db.query(
            `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
            [JSON.stringify({ test_date: '2026-11-12', title: 'Bad Remind', test_type: 'offline', remind_days_before: badVal }), sections]
          );
        },
        (err) => {
          assert.ok(err.message.includes('remind_days_before must be between 0 and 30'));
          return true;
        }
      );
    }
  });

  it('2. Category & Activity compatibility: validates category sections, online generator support, and enabled drills', async () => {
    // 2a. Basics category belonging to non-basics section is rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
          [
            JSON.stringify({ test_date: '2026-11-15', title: 'Mismatched Category', test_type: 'offline' }),
            JSON.stringify([{ kind: 'basics', category_id: catRoundId }]), // using round category in basics
          ]
        );
      },
      (err) => {
        assert.ok(err.message.includes('does not belong to Basics'));
        return true;
      }
    );

    // 2b. Round category belonging to non-round section is rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
          [
            JSON.stringify({ test_date: '2026-11-15', title: 'Mismatched Round', test_type: 'offline' }),
            JSON.stringify([{ kind: 'round', category_id: catBasicsId }]), // using basics category in round
          ]
        );
      },
      (err) => {
        assert.ok(err.message.includes('does not belong to Round'));
        return true;
      }
    );

    // 2c. Online Basics category without question generator support is rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
          [
            JSON.stringify({ test_date: '2026-11-15', title: 'Unsupported Online Basics', test_type: 'online' }),
            JSON.stringify([{ kind: 'basics', category_id: catBasicsUnsupportedId, seconds: 60 }]),
          ]
        );
      },
      (err) => {
        assert.ok(err.message.includes('is not supported for online question generation'));
        return true;
      }
    );

    // 2d. Elements drill key validation: disabled drill "modulo" or unknown key is rejected
    for (const badDrill of ['modulo', 'imaginary_drill_xyz']) {
      await assert.rejects(
        async () => {
          await db.query(
            `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
            [
              JSON.stringify({ test_date: '2026-11-15', title: 'Bad Drill', test_type: 'offline' }),
              JSON.stringify([{ kind: 'elements', activity_key: badDrill }]),
            ]
          );
        },
        (err) => {
          assert.ok(err.message.includes('is not supported or disabled'));
          return true;
        }
      );
    }

    // 2e. Valid Elements drill (e.g. 'day_codes', 'squares_stage_1') succeeds
    const validDrillRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [
        JSON.stringify({ test_date: '2026-11-15', title: 'Valid Drill', test_type: 'offline' }),
        JSON.stringify([{ kind: 'elements', activity_key: 'day_codes' }]),
      ]
    );
    assert.ok(validDrillRes.rows[0].result.test_id);
  });

  it('3. Product limit: strictly enforces maximum 12 sections even though position check allows 20', async () => {
    // Build 13 sections
    const thirteenSections = [];
    for (let i = 1; i <= 13; i++) {
      thirteenSections.push({
        kind: 'flash',
        flash_digits: 1,
        flash_count: 10 + i, // distinct settings
        flash_speed_ms: 1000,
        flash_mode: 'add',
        question_count: 1,
      });
    }

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB)`,
          [
            JSON.stringify({ test_date: '2026-11-18', title: 'Too Many Sections', test_type: 'online' }),
            JSON.stringify(thirteenSections),
          ]
        );
      },
      (err) => {
        assert.ok(err.message.includes('Online weekly tests require between 1 and 12 sections (received 13)'));
        return true;
      }
    );
  });

  it('4. Reordering: safely swaps section positions within 1..20 via deferrable constraint without collision', async () => {
    // Create test with 3 sections
    const payload = JSON.stringify({
      test_date: '2026-11-20',
      title: 'Reorder Test',
      test_type: 'offline',
    });
    const initialSections = JSON.stringify([
      { kind: 'basics', category_id: catBasicsId, seconds: 120 },
      { kind: 'elements', activity_key: 'day_codes' },
      { kind: 'memoriad', activity_key: 'additions' },
    ]);

    const createdRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [payload, initialSections]
    );
    const testId = createdRes.rows[0].result.test_id;

    const originalRows = await db.query(
      `SELECT id, position, kind FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    const secA = originalRows.rows[0]; // pos 1: basics
    const secB = originalRows.rows[1]; // pos 2: elements
    const secC = originalRows.rows[2]; // pos 3: memoriad

    // Reorder: reverse the order completely (C -> 1, B -> 2, A -> 3)
    const reorderedSections = JSON.stringify([
      { id: secC.id, kind: 'memoriad', activity_key: 'additions' },
      { id: secB.id, kind: 'elements', activity_key: 'day_codes' },
      { id: secA.id, kind: 'basics', category_id: catBasicsId, seconds: 120 },
    ]);

    const updateRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB) as result`,
      [testId, payload, reorderedSections]
    );
    assert.equal(updateRes.rows[0].result.test_id, testId);

    const afterRows = await db.query(
      `SELECT id, position, kind FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    assert.equal(afterRows.rows[0].id, secC.id);
    assert.equal(afterRows.rows[0].position, 1);
    assert.equal(afterRows.rows[1].id, secB.id);
    assert.equal(afterRows.rows[1].position, 2);
    assert.equal(afterRows.rows[2].id, secA.id);
    assert.equal(afterRows.rows[2].position, 3);
  });

  it('5. Proven Rollback: forces failure AFTER parent and section 1 mutation, proving full rollback of intermediate writes', async () => {
    // 1. Create a pristine test with 2 valid sections
    const initialPayload = JSON.stringify({
      test_date: '2026-11-20',
      title: 'Pristine Title Before Rollback',
      test_type: 'offline',
      remind_days_before: 5,
    });
    const initialSections = JSON.stringify([
      { kind: 'basics', category_id: catBasicsId, seconds: 60 },
      { kind: 'elements', activity_key: 'day_codes' },
    ]);

    const createRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [initialPayload, initialSections]
    );
    const testId = createRes.rows[0].result.test_id;

    const beforeSecs = await db.query(
      `SELECT id, position, seconds, activity_key FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    const sec1Id = beforeSecs.rows[0].id;
    const sec2Id = beforeSecs.rows[1].id;

    // Attach student score and attempt to section 1
    await db.query(
      `INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, correct, total)
       VALUES ($1, $2, $3, 10, 10)`,
      [testId, studentId, sec1Id]
    );
    await db.query(
      `INSERT INTO public.weekly_test_attempts (test_id, student_id, section_id, status)
       VALUES ($1, $2, $3, 'submitted')`,
      [testId, studentId, sec1Id]
    );

    // 2. Attach a database trigger that forces an exception when section 2 is processed in Step 9
    // (This guarantees Step 7 parent update and Step 9 Section 1 update have already executed)
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.trg_test_force_section2_error() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.id = '${sec2Id}' THEN
          RAISE EXCEPTION 'Simulated error during section 2 processing after parent and section 1 writes'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER test_force_section2_error_trg
        BEFORE UPDATE ON public.weekly_test_sections
        FOR EACH ROW EXECUTE FUNCTION public.trg_test_force_section2_error();
    `);

    // 3. Attempt update: changes title to 'MUTATED TITLE' and updates section 1 order
    // Because section 1 settings are preserved, Step 6 passes.
    // Step 7 updates parent weekly_tests title to 'MUTATED TITLE'.
    // Step 9 updates section 1 to position 1.
    // Step 9 then reaches section 2 and fires the trigger, forcing an in-transaction exception AFTER writes.
    const mutatingPayload = JSON.stringify({
      test_date: '2026-11-20',
      title: 'MUTATED TITLE',
      test_type: 'offline',
      remind_days_before: 12,
    });
    const mutatingSections = JSON.stringify([
      { id: sec1Id, kind: 'basics', category_id: catBasicsId, seconds: 60 },
      { id: sec2Id, kind: 'elements', activity_key: 'day_codes' },
    ]);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [testId, mutatingPayload, mutatingSections]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes('Simulated error during section 2 processing after parent and section 1 writes'),
          err.message
        );
        return true;
      }
    );

    // Clean up test trigger
    await db.exec(`DROP TRIGGER IF EXISTS test_force_section2_error_trg ON public.weekly_test_sections;`);

    // 4. Assert complete rollback: verify parent title, section 1, section 2, scores and attempts are pristine
    const afterTest = await db.query(`SELECT title, remind_days_before FROM public.weekly_tests WHERE id = $1`, [testId]);
    assert.equal(afterTest.rows[0].title, 'Pristine Title Before Rollback', 'Parent title must NOT remain mutated after failure');
    assert.equal(afterTest.rows[0].remind_days_before, 5, 'Reminder days must remain pristine');

    const afterSecs = await db.query(
      `SELECT id, position, seconds, activity_key FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    assert.equal(afterSecs.rows[0].id, sec1Id);
    assert.equal(afterSecs.rows[0].seconds, 60, 'Section 1 seconds must NOT remain mutated to 120');

    assert.equal(afterSecs.rows[1].id, sec2Id);
    assert.equal(afterSecs.rows[1].seconds, null);
    assert.equal(afterSecs.rows[1].activity_key, 'day_codes');

    const scoreCheck = await db.query(`SELECT * FROM public.weekly_test_scores WHERE section_id = $1`, [sec1Id]);
    assert.equal(scoreCheck.rows.length, 1);
    const attemptCheck = await db.query(`SELECT * FROM public.weekly_test_attempts WHERE section_id = $1`, [sec1Id]);
    assert.equal(attemptCheck.rows.length, 1);
  });

  it('6. Locked Sections: refuses deletion and configuration modification while permitting order changes', async () => {
    const payload = JSON.stringify({
      test_date: '2026-11-22',
      title: 'Lock Test',
      test_type: 'online',
    });
    const sections = JSON.stringify([
      { kind: 'basics', category_id: catBasicsId, seconds: 60 },
      { kind: 'memoriad', activity_key: 'calendar' },
    ]);

    const createRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [payload, sections]
    );
    const testId = createRes.rows[0].result.test_id;

    const secRows = await db.query(
      `SELECT id FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    const lockedSecId = secRows.rows[0].id;
    const otherSecId = secRows.rows[1].id;

    // Simulate student attempt on section 1
    await db.query(
      `INSERT INTO public.weekly_test_attempts (test_id, student_id, section_id, status)
       VALUES ($1, $2, $3, 'submitted')`,
      [testId, studentId, lockedSecId]
    );

    // Case 6a: Attempt to delete locked section 1 (only sending section 2)
    const deleteAttempt = JSON.stringify([
      { id: otherSecId, kind: 'memoriad', activity_key: 'calendar' },
    ]);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [testId, payload, deleteAttempt]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes(`Cannot delete locked section ${lockedSecId}: student attempts or scores exist`),
          err.message
        );
        return true;
      }
    );

    // Case 6b: Attempt to change duration on locked section 1
    const modifyAttempt = JSON.stringify([
      { id: lockedSecId, kind: 'basics', category_id: catBasicsId, seconds: 120 },
      { id: otherSecId, kind: 'memoriad', activity_key: 'calendar' },
    ]);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [testId, payload, modifyAttempt]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes(`Cannot modify configuration of locked section ${lockedSecId}`),
          err.message
        );
        return true;
      }
    );

    // Case 6c: Allowed change - change order / position of the locked section
    const reorderAttempt = JSON.stringify([
      { id: otherSecId, kind: 'memoriad', activity_key: 'calendar' },
      { id: lockedSecId, kind: 'basics', category_id: catBasicsId, seconds: 60 },
    ]);

    const reorderRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB) as result`,
      [testId, payload, reorderAttempt]
    );
    assert.equal(reorderRes.rows[0].result.test_id, testId);

    const reorderedRows = await db.query(
      `SELECT id, position FROM public.weekly_test_sections WHERE test_id = $1 ORDER BY position ASC`,
      [testId]
    );
    assert.equal(reorderedRows.rows[0].id, otherSecId);
    assert.equal(reorderedRows.rows[0].position, 1);
    assert.equal(reorderedRows.rows[1].id, lockedSecId);
    assert.equal(reorderedRows.rows[1].position, 2);
  });

  it('7. Rejections: rejects foreign section IDs, unknown IDs, and duplicate IDs', async () => {
    // Create test A
    const resA = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [
        JSON.stringify({ test_date: '2026-11-25', title: 'Test A', test_type: 'offline' }),
        JSON.stringify([{ kind: 'memoriad', activity_key: 'calendar' }]),
      ]
    );
    const testAId = resA.rows[0].result.test_id;
    const secARows = await db.query(`SELECT id FROM public.weekly_test_sections WHERE test_id = $1`, [testAId]);
    const secAId = secARows.rows[0].id;

    // Create test B
    const resB = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::JSONB, $2::JSONB) as result`,
      [
        JSON.stringify({ test_date: '2026-11-25', title: 'Test B', test_type: 'offline' }),
        JSON.stringify([{ kind: 'elements', activity_key: 'day_codes' }]),
      ]
    );
    const testBId = resB.rows[0].result.test_id;

    // Case 7a: Section A's id passed to Test B
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [testBId, JSON.stringify({ test_date: '2026-11-25', title: 'Test B', test_type: 'offline' }), JSON.stringify([{ id: secAId, kind: 'elements', activity_key: 'day_codes' }])]
        );
      },
      (err) => {
        assert.ok(err.message.includes(`Section ${secAId} belongs to another test`), err.message);
        return true;
      }
    );

    // Case 7b: Unknown random UUID passed as section ID
    const unknownId = '99999999-9999-9999-9999-999999999999';
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [testBId, JSON.stringify({ test_date: '2026-11-25', title: 'Test B', test_type: 'offline' }), JSON.stringify([{ id: unknownId, kind: 'elements', activity_key: 'day_codes' }])]
        );
      },
      (err) => {
        assert.ok(err.message.includes(`Section ${unknownId} does not exist`), err.message);
        return true;
      }
    );

    // Case 7c: Duplicate section ID in same payload
    const testBSecId = (await db.query(`SELECT id FROM public.weekly_test_sections WHERE test_id = $1`, [testBId])).rows[0].id;
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::JSONB, $3::JSONB)`,
          [
            testBId,
            JSON.stringify({ test_date: '2026-11-25', title: 'Test B', test_type: 'offline' }),
            JSON.stringify([
              { id: testBSecId, kind: 'elements', activity_key: 'day_codes' },
              { id: testBSecId, kind: 'memoriad', activity_key: 'calendar' },
            ]),
          ]
        );
      },
      (err) => {
        assert.ok(err.message.includes(`Duplicate section id in payload: ${testBSecId}`), err.message);
        return true;
      }
    );
  });
});
