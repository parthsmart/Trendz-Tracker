/**
 * Phase 18 — Staging Prerequisites Package Verification
 * (tests/phase18_staging_prerequisites.test.js)
 *
 * Verifies:
 * 1. Operator confirmation latch requirement (`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'`).
 * 2. Production collision tripwire: rejects execution if Mumbai production records (STU101 Riya Sen) exist.
 * 3. Deliberate incompatible-object conflict checks:
 *    - Aborts if `results_with_target` exists as a BASE TABLE instead of a VIEW.
 *    - Aborts if `profiles.active` exists with incompatible type `text` instead of `boolean`.
 *    - Aborts if `competition_rules` exists with incompatible return type `text` instead of TABLE/record.
 *    - Aborts if `weekly_tests` exists as a VIEW instead of a BASE TABLE.
 * 4. Clean application over minimal staging baseline:
 *    - Creates all 17 baseline tables and view with exact Mumbai schema.
 *    - Preserves existing staging profiles, categories, results, and JMCWC simulator tables.
 * 5. Idempotent rerun: script reruns cleanly without conflict or data loss.
 * 6. Authoritative calculation fidelity:
 *    - `competition_rules()` reads dynamically from `competition_settings` (not fixed constants).
 *    - `results_with_target` evaluates `meets_target` via `basics_thresholds` lateral join (not NULL).
 *    - `streak_calc` calculates true streak, best_streak, and shields via `streak_day_counts` (not hardcoded 1 or 0).
 * 7. Migration 16 compatibility: applies cleanly on top of prepared staging database.
 *
 * Run with: node --test tests/phase18_staging_prerequisites.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { stripBasicsExpected } from '../api/_drills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Phase 18 — Staging Prerequisites Package', () => {
  const asUser = async (db, userId, role = 'authenticated', fn) => {
    await db.exec(`SET app.current_user_id = '${userId}'; SET app.current_jwt_role = '${role}'; SET ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE; SET app.current_user_id = ''; SET app.current_jwt_role = '';`);
    }
  };

  const createMinimalStagingDb = async () => {
    const db = new PGlite();

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

      -- 1. Minimal Profiles
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true
      );

      -- 2. Minimal Categories
      CREATE TABLE public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 1
      );

      -- 3. Minimal Results
      CREATE TABLE public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID REFERENCES public.categories(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT NOT NULL DEFAULT 0,
        note TEXT,
        entry_date DATE NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 4. JMCWC Stub Table (Must be preserved)
      CREATE TABLE public.jmcwc_papers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_key TEXT NOT NULL,
        version INT NOT NULL,
        published BOOLEAN NOT NULL DEFAULT false
      );

      -- 5. Helpers present on staging
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

    // Seed sample staging data
    await db.exec(`
      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Direct 1D', 'basics', 1);

      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES ('11111111-1111-1111-1111-111111111111', 'admin', 'ADM-STAGE', 'Staging SuperAdmin', 'Grandmaster', true);

      INSERT INTO public.jmcwc_papers (id, group_key, version, published)
      VALUES ('99999999-9999-9999-9999-999999999999', 'junior1', 1, true);
    `);

    return db;
  };

  it('1. Rejects execution if operator confirmation latch is not staging_xhgzbbkvwojwfbexvcmh', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    // Replace the executable SET statement
    const wrongRefSql = prereqSql.replace(
      /SET app\.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';\r?\n\r?\nBEGIN;/,
      "SET app.target_environment = 'wrong_env';\n\nBEGIN;"
    );

    await assert.rejects(
      async () => {
        await db.exec(wrongRefSql);
      },
      /OPERATOR SAFETY HALT: Target environment latch unset or mismatched/
    );
  });

  it('2. Rejects execution if live Mumbai production records (STU101) exist', async () => {
    const db = await createMinimalStagingDb();

    // Insert Mumbai production student marker
    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES ('77777777-7777-7777-7777-777777777777', 'student', 'STU101', 'Riya Sen', 'Senior', true);
    `);

    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.rejects(
      async () => {
        await db.exec(prereqSql);
      },
      /SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected in public.profiles/
    );
  });

  it('3. Pre-flight conflict check: aborts if results_with_target exists as BASE TABLE', async () => {
    const db = await createMinimalStagingDb();

    // Deliberate conflict: create results_with_target as a physical table
    await db.exec(`CREATE TABLE public.results_with_target (id UUID PRIMARY KEY, bogus TEXT);`);

    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.rejects(
      async () => {
        await db.exec(prereqSql);
      },
      /INCOMPATIBLE OBJECT CONFLICT: Object public.results_with_target exists as a BASE TABLE, expected VIEW/
    );
  });

  it('4. Pre-flight conflict check: aborts if profiles.active has incompatible data type', async () => {
    const db = await createMinimalStagingDb();

    // Deliberate conflict: alter profiles.active to text
    await db.exec(`
      ALTER TABLE public.profiles DROP COLUMN active;
      ALTER TABLE public.profiles ADD COLUMN active TEXT DEFAULT 'yes';
    `);

    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.rejects(
      async () => {
        await db.exec(prereqSql);
      },
      /INCOMPATIBLE OBJECT CONFLICT: public.profiles.active has data type "text", expected "boolean"/
    );
  });

  it('5. Pre-flight conflict check: aborts if competition_rules() has incompatible return type', async () => {
    const db = await createMinimalStagingDb();

    // Deliberate conflict: create competition_rules() returning TEXT
    await db.exec(`CREATE OR REPLACE FUNCTION public.competition_rules() RETURNS TEXT AS $$ SELECT 'bad'; $$ LANGUAGE sql;`);

    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.rejects(
      async () => {
        await db.exec(prereqSql);
      },
      /INCOMPATIBLE OBJECT CONFLICT: Function public.competition_rules exists with incompatible return type "text", expected record\/TABLE/
    );
  });

  it('6. Pre-flight conflict check: aborts if weekly_tests exists as a VIEW instead of BASE TABLE', async () => {
    const db = await createMinimalStagingDb();

    // Deliberate conflict: create weekly_tests as a view
    await db.exec(`CREATE VIEW public.weekly_tests AS SELECT 1 AS bogus;`);

    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.rejects(
      async () => {
        await db.exec(prereqSql);
      },
      /INCOMPATIBLE OBJECT CONFLICT: Object public.weekly_tests exists as a VIEW, expected BASE TABLE/
    );
  });

  it('7. Applies cleanly over minimal staging baseline', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await assert.doesNotReject(async () => {
      await db.exec(prereqSql);
    }, 'Prerequisite setup must apply cleanly');

    // Verify all baseline tables now exist
    const tables = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'activity_results', 'weekly_tests', 'weekly_test_sections', 'weekly_test_scores',
          'weekly_test_attempts', 'attendance_sessions', 'attendance', 'daily_tasks',
          'daily_todo_log', 'competition_settings', 'basics_thresholds', 'announcements',
          'resources', 'student_messages', 'notification_dismissals', 'result_audit', 'drill_sessions'
        );
    `);
    assert.equal(tables.rows.length, 17, 'All 17 prerequisite tables created');

    // Verify view results_with_target exists as a VIEW
    const views = await db.query(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'results_with_target';`);
    assert.equal(views.rows.length, 1, 'results_with_target exists as VIEW');

    // Verify existing JMCWC and profiles data preserved
    const jmcwc = await db.query(`SELECT group_key FROM public.jmcwc_papers WHERE id = '99999999-9999-9999-9999-999999999999'`);
    assert.equal(jmcwc.rows[0].group_key, 'junior1');

    const profile = await db.query(`SELECT student_code FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111'`);
    assert.equal(profile.rows[0].student_code, 'ADM-STAGE');
  });

  it('8. Reruns idempotently without error', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');

    await db.exec(prereqSql);

    // Second run
    await assert.doesNotReject(async () => {
      await db.exec(prereqSql);
    }, 'Prerequisite script must be idempotent');
  });

  it('9. Authoritative calculation fidelity: competition_rules, results_with_target, streak_calc', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');
    await db.exec(prereqSql);

    // 1. competition_rules reads dynamically from competition_settings
    const defaultRules = await db.query(`SELECT * FROM public.competition_rules();`);
    assert.equal(Number(defaultRules.rows[0].weekly_test_multiplier), 1, 'Default weekly_test_multiplier = 1');
    assert.equal(Number(defaultRules.rows[0].attendance_present_points), 10, 'Default attendance_present_points = 10');

    // Update competition_settings and verify competition_rules() reflects it
    await db.exec(`UPDATE public.competition_settings SET value = '3' WHERE key = 'weekly_test_multiplier';`);
    const updatedRules = await db.query(`SELECT * FROM public.competition_rules();`);
    assert.equal(Number(updatedRules.rows[0].weekly_test_multiplier), 3, 'Dynamic weekly_test_multiplier = 3');

    // 2. results_with_target evaluates meets_target via basics_thresholds lateral join (not hardcoded NULL)
    const catId = '00000000-0000-0000-0000-000000000001';
    const studentId = '22222222-2222-2222-2222-222222222222';
    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES ('${studentId}', 'student', 'STG-001', 'Test Student', 'Basic', true);

      INSERT INTO public.basics_thresholds (category_id, level, min_accuracy, max_time_seconds, active)
      VALUES ('${catId}', 'Basic', 90.0, 120, true);

      -- Score 1: 95/100 in 60s -> Meets target (true)
      INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
      VALUES ('${studentId}', '${catId}', 95, 100, 60, public.today_ist());

      -- Score 2: 70/100 in 60s -> Below 90% accuracy -> Does NOT meet target (false)
      INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
      VALUES ('${studentId}', '${catId}', 70, 100, 60, public.today_ist());
    `);

    const rwt1 = await db.query(`
      SELECT min_accuracy, max_time_seconds, meets_target
      FROM public.results_with_target
      WHERE student_id = '${studentId}' AND correct = 95;
    `);
    assert.equal(Number(rwt1.rows[0].min_accuracy), 90);
    assert.equal(Number(rwt1.rows[0].max_time_seconds), 120);
    assert.equal(rwt1.rows[0].meets_target, true, 'Score 1 meets target');

    const rwt2 = await db.query(`
      SELECT min_accuracy, max_time_seconds, meets_target
      FROM public.results_with_target
      WHERE student_id = '${studentId}' AND correct = 70;
    `);
    assert.equal(rwt2.rows[0].meets_target, false, 'Score 2 fails target');

    // 3. streak_calc calculates true streak and shields (not hardcoded 1 or 0)
    // Add 14 consecutive practice days to prove streak reaches 14 and shield reaches 1
    const todayRes = await db.query(`SELECT public.today_ist()::text AS td;`);
    const today = todayRes.rows[0].td;
    for (let i = 13; i >= 0; i--) {
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date, created_at)
        VALUES ('${studentId}', '${catId}', 10, 10, 30, ('${today}'::date - INTERVAL '${i} days')::date, ('${today}'::date - INTERVAL '${i} days' + INTERVAL '10 hours'));
      `);
    }

    const streakRes = await db.query(`SELECT * FROM public.streak_calc('${studentId}');`);
    assert.equal(streakRes.rows[0].current_streak, 14, 'Current streak calculates accurately to 14 days');
    assert.equal(streakRes.rows[0].best_streak, 14, 'Best streak calculates accurately to 14 days');
    assert.equal(streakRes.rows[0].shields, 1, 'Shield awarded on 7-day multiple');
    assert.equal(streakRes.rows[0].active_today, true, 'Active today is true');
  });

  it('10. Migration 16 applies cleanly on top of prepared staging database', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');
    const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase18_atomic_migration.sql'), 'utf8');

    // 1. Prerequisites
    await db.exec(prereqSql);

    // 2. Migration 16
    await assert.doesNotReject(async () => {
      await db.exec(migrationSql);
    }, 'Migration 16 must apply cleanly on top of staging prerequisites');

    // 3. Verify Phase 18 tables
    const p18Tables = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('teacher_permissions', 'teacher_student_assignments', 'score_correction_requests', 'weekly_test_recipients');
    `);
    assert.equal(p18Tables.rows.length, 4, 'All 4 Phase 18 tables created');

    // 4. Verify permissive policies replaced
    const permissive = await db.query(`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname IN ('weekly_tests_read', 'wt_sections_read', 'att_sessions_read');
    `);
    assert.equal(permissive.rows.length, 0, 'Permissive policies dropped and replaced with scoped policies');
  });

  it('11. Authenticated-role regression check (Prerequisites): drill_sessions confidentiality & server grading', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');
    await db.exec(prereqSql);

    const adminId = '11111111-1111-1111-1111-111111111111'; // from createMinimalStagingDb
    const student1Id = '22222222-2222-2222-2222-222222222222';
    const student2Id = '33333333-3333-3333-3333-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES 
        ('${student1Id}', 'student', 'STU201', 'Alice Test', 'Senior', true),
        ('${student2Id}', 'student', 'STU202', 'Bob Test', 'Senior', true);
    `);

    // Trusted server generates practice set and creates drill_session using service_role
    const rawQuestions = [
      { type: 'add_sub', text: '4 + 5', expected: 9 },
      { type: 'add_sub', text: '12 - 7', expected: 5 },
    ];
    const clientQuestions = stripBasicsExpected(rawQuestions);
    const expectedAnswers = rawQuestions.map((q) => q.expected);

    // Verify client response excludes private grading data
    assert.deepEqual(clientQuestions, [
      { type: 'add_sub', text: '4 + 5' },
      { type: 'add_sub', text: '12 - 7' },
    ]);
    assert.equal('expected' in clientQuestions[0], false, 'Client question 1 must not contain expected answer');
    assert.equal('expected' in clientQuestions[1], false, 'Client question 2 must not contain expected answer');

    const sessionId = '44444444-4444-4444-4444-444444444444';

    // Service role inserts drill session with private expected answers
    await asUser(db, '', 'service_role', async () => {
      await db.query(`
        INSERT INTO public.drill_sessions (
          id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, expires_at, status
        ) VALUES (
          '${sessionId}',
          '${student1Id}',
          'element',
          'Square 1 to 25',
          '{"kind":"element"}'::jsonb,
          $1::jsonb,
          $2::jsonb,
          1,
          now(),
          now() + interval '5 minutes',
          'open'
        );
      `, [JSON.stringify(clientQuestions), JSON.stringify(expectedAnswers)]);
    });

    // 1. Student 1 (session owner) directly querying drill_sessions via PostgREST/authenticated role:
    const student1Rows = await asUser(db, student1Id, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(student1Rows.length, 0, 'Student cannot directly read their drill session or expected answers');

    // 2. Student 2 (peer) querying drill_sessions:
    const student2Rows = await asUser(db, student2Id, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(student2Rows.length, 0, 'Peer student cannot read another student drill session');

    // 3. Admin querying drill_sessions:
    const adminRows = await asUser(db, adminId, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(adminRows.length, 1, 'Admin can read drill session');
    assert.deepEqual(adminRows[0].expected, [9, 5], 'Admin can inspect canonical expected answers for audit');

    // 4. Trusted server (service_role) grades session and records results normally:
    await asUser(db, '', 'service_role', async () => {
      // Server reads expected answers to grade student's submission
      const sessionRes = await db.query(`SELECT expected FROM public.drill_sessions WHERE id = '${sessionId}';`);
      const canonicalExpected = sessionRes.rows[0].expected;
      assert.deepEqual(canonicalExpected, [9, 5]);

      // Server updates session status to submitted
      await db.query(`UPDATE public.drill_sessions SET status = 'submitted', submitted_at = now() WHERE id = '${sessionId}';`);

      // Server writes graded result to activity_results
      await db.query(`
        INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds)
        VALUES ('${student1Id}', 'element', 'Square 1 to 25', 2, 2, 15);
      `);
    });

    // Verify session updated and result saved
    const verifyRes = await asUser(db, adminId, 'authenticated', async () => {
      const s = await db.query(`SELECT status FROM public.drill_sessions WHERE id = '${sessionId}';`);
      const r = await db.query(`SELECT correct, total FROM public.activity_results WHERE student_id = '${student1Id}';`);
      return { status: s.rows[0].status, result: r.rows[0] };
    });
    assert.equal(verifyRes.status, 'submitted');
    assert.equal(verifyRes.result.correct, 2);
  });

  it('12. Authenticated-role regression check (Post-Migration 16): drill_sessions boundary preserved with teachers', async () => {
    const db = await createMinimalStagingDb();
    const prereqSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase18_prerequisites.sql'), 'utf8');
    const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase18_atomic_migration.sql'), 'utf8');

    await db.exec(prereqSql);
    await db.exec(migrationSql);

    const adminId = '11111111-1111-1111-1111-111111111111';
    const teacherId = '55555555-5555-5555-5555-555555555555';
    const student1Id = '22222222-2222-2222-2222-222222222222';
    const student2Id = '33333333-3333-3333-3333-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES 
        ('${teacherId}', 'teacher', 'TCH101', 'Teacher Tina', 'Senior', true),
        ('${student1Id}', 'student', 'STU201', 'Alice Test', 'Senior', true),
        ('${student2Id}', 'student', 'STU202', 'Bob Test', 'Senior', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacherId}', '${student1Id}');

      INSERT INTO public.teacher_permissions (teacher_id)
      VALUES ('${teacherId}');
    `);

    const sessionId = '66666666-6666-6666-6666-666666666666';

    // Server creates drill session for student1
    await asUser(db, '', 'service_role', async () => {
      await db.query(`
        INSERT INTO public.drill_sessions (
          id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, expires_at, status
        ) VALUES (
          '${sessionId}',
          '${student1Id}',
          'basics',
          'Direct 1D',
          '{"kind":"basics"}'::jsonb,
          '[{"type":"add_sub","text":"7 + 8"}]'::jsonb,
          '[15]'::jsonb,
          1,
          now(),
          now() + interval '5 minutes',
          'open'
        );
      `);
    });

    // 1. Student 1 querying drill_sessions: 0 rows
    const s1Rows = await asUser(db, student1Id, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(s1Rows.length, 0, 'Post-M16: Student 1 cannot directly read drill session expected answers');

    // 2. Student 2 querying drill_sessions: 0 rows
    const s2Rows = await asUser(db, student2Id, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(s2Rows.length, 0, 'Post-M16: Student 2 cannot read drill session');

    // 3. Assigned Teacher querying drill_sessions: 0 rows
    const teacherRows = await asUser(db, teacherId, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(teacherRows.length, 0, 'Post-M16: Assigned teacher cannot directly read drill session expected answers');

    // 4. Admin querying drill_sessions: 1 row
    const adminRows = await asUser(db, adminId, 'authenticated', async () => {
      const res = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows;
    });
    assert.equal(adminRows.length, 1, 'Post-M16: Admin can read drill session');
    assert.deepEqual(adminRows[0].expected, [15]);

    // 5. Trusted server can grade and complete session:
    await asUser(db, '', 'service_role', async () => {
      await db.query(`UPDATE public.drill_sessions SET status = 'submitted', submitted_at = now() WHERE id = '${sessionId}';`);
    });
    const finalSession = await asUser(db, adminId, 'authenticated', async () => {
      const res = await db.query(`SELECT status FROM public.drill_sessions WHERE id = '${sessionId}';`);
      return res.rows[0];
    });
    assert.equal(finalSession.status, 'submitted');
  });
});
