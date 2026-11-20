/**
 * Exact Fixture Parity Verification for student_month_report Hotfix
 * (tests/studentMonthReportFixtureParity.test.js)
 *
 * Verifies:
 * 1. Against the same populated fixture, compares report JSON before and after the standalone patch.
 * 2. Asserts exact equality after excluding weekly_tests.
 * 3. Asserts existing category-based scores retain their values.
 * 4. Asserts previously omitted activity scores appear once without duplicate rows.
 * 5. Strictly tests the confirmed live STU101 example:
 *    Riya (STU101), "Square 1 to 25", 5 November 2026, 25/25.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

test('Parity Proof: Unrelated report values remain identical, while omitted activity scores appear once', async () => {
  const db = new PGlite();

  // 1. Roles and session auth mocking
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
      SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
    $$ LANGUAGE sql STABLE;
  `);

  // 2. Base deployed tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.profiles (
      id UUID PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
      student_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      level TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );

    CREATE TABLE IF NOT EXISTS public.categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      section TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS public.results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      category_id UUID REFERENCES public.categories(id),
      student_round_id UUID,
      correct INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      time_seconds INT NOT NULL DEFAULT 0,
      note TEXT,
      entry_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );

    CREATE TABLE IF NOT EXISTS public.activity_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      activity_name TEXT NOT NULL,
      correct INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      time_seconds INT,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );

    CREATE TABLE IF NOT EXISTS public.attendance_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      session_date DATE NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'class',
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );

    CREATE TABLE IF NOT EXISTS public.attendance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
      UNIQUE(session_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS public.results_with_target AS
    SELECT
      r.*,
      NULL::numeric AS min_accuracy,
      NULL::integer AS max_time_seconds,
      NULL::boolean AS meets_target
    FROM public.results r;

    CREATE TABLE IF NOT EXISTS public.weekly_tests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_date DATE NOT NULL DEFAULT (timezone('Asia/Kolkata', now()))::DATE,
      title TEXT NOT NULL,
      test_type TEXT NOT NULL DEFAULT 'offline'
    );

    CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      position INT NOT NULL CHECK (position >= 1 AND position <= 20),
      category_id UUID NULL REFERENCES public.categories(id),
      seconds INT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad')),
      activity_key TEXT NULL,
      flash_digits INT NULL,
      flash_count INT NULL,
      flash_speed_ms INT NULL,
      flash_mode TEXT NULL,
      question_count INT NULL
    );

    CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
      category_id UUID REFERENCES public.categories(id),
      correct INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      time_seconds INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );
  `);

  // 3. Deployed helper functions
  await db.exec(`
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

    CREATE OR REPLACE FUNCTION public.competition_rules()
    RETURNS TABLE (
      weekly_test_multiplier INTEGER,
      attendance_present_points INTEGER,
      improved_min_entries INTEGER,
      leaderboard_names TEXT
    ) AS $$
      SELECT 2, 5, 5, 'first_name_initial'::TEXT;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION public.attendance_summary(p_student uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
    RETURNS TABLE(present_count integer, absent_count integer, excused_count integer, attendance_pct numeric) AS $$
    BEGIN
      RETURN QUERY
      SELECT
        (count(*) FILTER (WHERE a.status = 'present'))::integer,
        (count(*) FILTER (WHERE a.status = 'absent'))::integer,
        (count(*) FILTER (WHERE a.status = 'excused'))::integer,
        CASE WHEN count(*) FILTER (WHERE a.status IN ('present', 'absent')) > 0
          THEN round(100.0 * count(*) FILTER (WHERE a.status = 'present')
                     / count(*) FILTER (WHERE a.status IN ('present', 'absent')), 1)
        END
      FROM public.attendance a
      JOIN public.attendance_sessions s ON s.id = a.session_id
      WHERE a.student_id = p_student
        AND (p_from IS NULL OR s.session_date >= p_from)
        AND (p_to IS NULL OR s.session_date <= p_to);
    END;
    $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.streak_calc(p_student uuid)
    RETURNS TABLE(current_streak integer, best_streak integer, shields integer, active_today boolean) AS $$
    BEGIN
      RETURN QUERY SELECT 12, 18, 1, true;
    END;
    $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.practice_stats_for(p_student uuid, p_from date, p_to date)
    RETURNS TABLE(n_entries integer, n_correct bigint, n_total bigint, accuracy_pct numeric, qpm numeric, n_rounds integer) AS $$
      SELECT count(*)::integer,
             COALESCE(sum(r.correct), 0)::bigint,
             COALESCE(sum(r.total), 0)::bigint,
             CASE WHEN sum(r.total) > 0 THEN round(100.0 * sum(r.correct) / sum(r.total), 1) END,
             CASE WHEN COALESCE(sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0), 0) > 0
                  THEN round(sum(r.total) FILTER (WHERE r.time_seconds > 0)
                             / (sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0) / 60.0), 1) END,
             count(DISTINCT r.student_round_id)::integer
        FROM public.results r
       WHERE r.student_id = p_student
         AND r.entry_date BETWEEN p_from AND p_to
         AND r.total > 0 AND r.correct IS NOT NULL;
    $$ LANGUAGE sql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.practice_days_for(p_student uuid, p_from date, p_to date)
    RETURNS integer AS $$
      SELECT count(DISTINCT q.dt)::integer
        FROM (
          SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS dt
            FROM public.results r
           WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
          UNION ALL
          SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
            FROM public.activity_results a
           WHERE a.student_id = p_student AND a.total > 0
        ) q
       WHERE q.dt BETWEEN p_from AND p_to;
    $$ LANGUAGE sql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.points_for(p_student uuid, p_from date, p_to date)
    RETURNS numeric AS $$
      SELECT COALESCE((SELECT sum(GREATEST(0, 2 * s.correct - s.total))
                         FROM public.weekly_test_scores s
                         JOIN public.weekly_tests t ON t.id = s.test_id
                        WHERE s.student_id = p_student AND t.test_date BETWEEN p_from AND p_to), 0)
             * (SELECT cr.weekly_test_multiplier FROM public.competition_rules() cr)
           + COALESCE((SELECT count(*)
                         FROM public.attendance a
                         JOIN public.attendance_sessions x ON x.id = a.session_id
                        WHERE a.student_id = p_student AND a.status = 'present'
                          AND x.session_date BETWEEN p_from AND p_to), 0)
             * (SELECT cr.attendance_present_points FROM public.competition_rules() cr);
    $$ LANGUAGE sql STABLE SECURITY DEFINER;
  `);

  // 4. Install ORIGINAL DEPLOYED student_month_report (with inner join categories)
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.student_month_report(
      p_student UUID,
      p_month DATE DEFAULT NULL
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_from date := date_trunc('month', COALESCE(p_month, public.today_ist()))::date;
      v_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) + interval '1 month' - interval '1 day')::date;
      v_prev_from date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 month')::date;
      v_prev_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 day')::date;
      v_name text;
      v_code text;
      v_level text;
      v_att record;
      v_streak record;
      v_ps record;
      v_pp record;
    BEGIN
      IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
        RAISE EXCEPTION 'Not allowed';
      END IF;

      SELECT p.full_name, p.student_code, p.level INTO v_name, v_code, v_level
        FROM public.profiles p WHERE p.id = p_student AND p.role = 'student';
      IF NOT FOUND THEN RAISE EXCEPTION 'Student not found'; END IF;

      SELECT * INTO v_att FROM public.attendance_summary(p_student, v_from, v_to);
      SELECT * INTO v_streak FROM public.streak_calc(p_student);
      SELECT * INTO v_ps FROM public.practice_stats_for(p_student, v_from, v_to);
      SELECT * INTO v_pp FROM public.practice_stats_for(p_student, v_prev_from, v_prev_to);

      RETURN jsonb_build_object(
        'student', jsonb_build_object('name', v_name, 'code', v_code, 'level', v_level),
        'month_start', v_from,
        'month_end', v_to,
        'days_elapsed', GREATEST(0, LEAST(v_to, public.today_ist()) - v_from + 1),
        'practice', jsonb_build_object(
          'entries', v_ps.n_entries, 'correct', v_ps.n_correct, 'total', v_ps.n_total,
          'accuracy', v_ps.accuracy_pct, 'qpm', v_ps.qpm, 'rounds', v_ps.n_rounds,
          'practice_days', public.practice_days_for(p_student, v_from, v_to)),
        'previous', jsonb_build_object(
          'entries', v_pp.n_entries, 'accuracy', v_pp.accuracy_pct, 'qpm', v_pp.qpm,
          'practice_days', public.practice_days_for(p_student, v_prev_from, v_prev_to)),
        'streak', jsonb_build_object('current', v_streak.current_streak, 'best', v_streak.best_streak),
        'attendance', jsonb_build_object(
          'present', v_att.present_count, 'absent', v_att.absent_count,
          'excused', v_att.excused_count, 'percent', v_att.attendance_pct),
        'points', public.points_for(p_student, v_from, v_to),
        'weeks', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('week_start', w.ws, 'entries', w.n, 'accuracy', w.acc) ORDER BY w.ws)
            FROM (
              SELECT date_trunc('week', r.entry_date)::date AS ws,
                     count(*) AS n,
                     round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc
                FROM public.results r
               WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
                 AND r.total > 0 AND r.correct IS NOT NULL
               GROUP BY 1
            ) w), '[]'::jsonb),
        'categories', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('name', c.name, 'section', c.section, 'entries', x.n,
                                              'accuracy', x.acc, 'wrong', x.wrong) ORDER BY x.acc, c.name)
            FROM (
              SELECT r.category_id,
                     count(*) AS n,
                     round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc,
                     sum(r.total - r.correct) AS wrong
                FROM public.results r
               WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
                 AND r.total > 0 AND r.correct IS NOT NULL
               GROUP BY r.category_id
              HAVING count(*) >= 3
            ) x
            JOIN public.categories c ON c.id = x.category_id), '[]'::jsonb),
        'targets', (
          SELECT jsonb_build_object(
                   'measured', count(*) FILTER (WHERE t.meets_target IS NOT NULL),
                   'met', count(*) FILTER (WHERE t.meets_target IS TRUE))
            FROM public.results_with_target t
           WHERE t.student_id = p_student AND t.entry_date BETWEEN v_from AND v_to),
        'weekly_tests', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('title', t.title, 'date', t.test_date, 'category', c.name,
                                              'correct', s.correct, 'total', s.total,
                                              'time_seconds', s.time_seconds) ORDER BY t.test_date, c.name)
            FROM public.weekly_test_scores s
            JOIN public.weekly_tests t ON t.id = s.test_id
            JOIN public.categories c ON c.id = s.category_id
           WHERE s.student_id = p_student AND t.test_date BETWEEN v_from AND v_to), '[]'::jsonb)
      );
    END;
    $$;
  `);

  // 5. Populate rich fixture (including confirmed STU101 example)
  const riyaId = 'a1111111-1111-1111-1111-111111111111';
  const adminId = 'b2222222-2222-2222-2222-222222222222';
  const catBasicsId = 'c3333333-3333-3333-3333-333333333333';
  const catRoundId = 'd4444444-4444-4444-4444-444444444444';
  const secElemId = 'e1111111-1111-1111-1111-111111111111';
  const secFlashId = 'e2222222-2222-2222-2222-222222222222';
  const secMemoId = 'e3333333-3333-3333-3333-333333333333';

  await db.exec(`
    INSERT INTO public.profiles (id, role, student_code, full_name, level)
    VALUES
      ('${adminId}', 'admin', 'ADM001', 'Admin Principal', 'Staff'),
      ('${riyaId}', 'student', 'STU101', 'Riya', 'Level 2');

    INSERT INTO public.categories (id, name, section, sort_order)
    VALUES
      ('${catBasicsId}', '1 Digit 4 Rows', 'basics', 1),
      ('${catRoundId}', '2 Digit 5 Rows', 'round', 2);

    -- Nov 2026 practice entries (multiple dates and categories to populate weeks and categories)
    INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
    VALUES
      ('${riyaId}', '${catBasicsId}', 10, 10, 20, '2026-11-02'),
      ('${riyaId}', '${catBasicsId}', 9, 10, 22, '2026-11-03'),
      ('${riyaId}', '${catBasicsId}', 10, 10, 19, '2026-11-04'),
      ('${riyaId}', '${catRoundId}', 8, 10, 35, '2026-11-02'),
      ('${riyaId}', '${catRoundId}', 7, 10, 40, '2026-11-03'),
      ('${riyaId}', '${catRoundId}', 9, 10, 32, '2026-11-04');

    -- Oct 2026 practice entries (previous month)
    INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
    VALUES
      ('${riyaId}', '${catBasicsId}', 8, 10, 25, '2026-10-15'),
      ('${riyaId}', '${catRoundId}', 7, 10, 42, '2026-10-20');

    -- Activity results for practice days
    INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, created_at)
    VALUES
      ('${riyaId}', 'elements', 'squares_stage_1', 25, 25, '2026-11-05 10:00:00+05:30');

    -- Attendance session & attendance
    INSERT INTO public.attendance_sessions (id, title, session_date)
    VALUES ('e5555555-5555-5555-5555-555555555555', 'Regular Saturday Class', '2026-11-01');

    INSERT INTO public.attendance (session_id, student_id, status)
    VALUES ('e5555555-5555-5555-5555-555555555555', '${riyaId}', 'present');

    -- 1. Category-based weekly test
    INSERT INTO public.weekly_tests (id, title, test_date, test_type)
    VALUES ('f6666666-6666-6666-6666-666666666666', 'November Week 1 Mock', '2026-11-01', 'offline');

    INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
    VALUES ('f6666666-6666-6666-6666-666666666666', '${riyaId}', NULL, '${catBasicsId}', 18, 20, 110);

    -- 2. CONFIRMED LIVE EXAMPLE: Riya (STU101), "Square 1 to 25", 5 November 2026, 25/25
    INSERT INTO public.weekly_tests (id, title, test_date, test_type)
    VALUES ('f7777777-7777-7777-7777-777777777777', 'Weekly Online Assessment', '2026-11-05', 'online');

    INSERT INTO public.weekly_test_sections (id, test_id, position, kind, activity_key, category_id)
    VALUES ('${secElemId}', 'f7777777-7777-7777-7777-777777777777', 1, 'elements', 'squares_stage_1', NULL);

    INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
    VALUES ('f7777777-7777-7777-7777-777777777777', '${riyaId}', '${secElemId}', NULL, 25, 25, 45);

    -- 3. Flash Anzan section test score
    INSERT INTO public.weekly_test_sections (id, test_id, position, kind, flash_digits, flash_count, category_id)
    VALUES ('${secFlashId}', 'f7777777-7777-7777-7777-777777777777', 2, 'flash', 1, 50, NULL);

    INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
    VALUES ('f7777777-7777-7777-7777-777777777777', '${riyaId}', '${secFlashId}', NULL, 48, 50, 90);

    -- 4. Memoriad section test score
    INSERT INTO public.weekly_test_sections (id, test_id, position, kind, activity_key, category_id)
    VALUES ('${secMemoId}', 'f7777777-7777-7777-7777-777777777777', 3, 'memoriad', 'calendar', NULL);

    INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
    VALUES ('f7777777-7777-7777-7777-777777777777', '${riyaId}', '${secMemoId}', NULL, 10, 10, 60);
  `);

  const setAuth = async (userId) => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '${userId}', false);
      SELECT set_config('app.current_jwt_role', 'authenticated', false);
    `);
  };

  // 6. Capture BEFORE patch report
  await setAuth(adminId);
  const beforeRes = await db.query(`SELECT public.student_month_report('${riyaId}', '2026-11-01'::DATE)`);
  const rawBefore = beforeRes.rows[0].student_month_report;
  const beforeReport = typeof rawBefore === 'string' ? JSON.parse(rawBefore) : rawBefore;

  // Confirm deployed bug: beforeReport.weekly_tests has only 1 score (the category one); activity tests were omitted!
  assert.equal(beforeReport.weekly_tests.length, 1, 'Before patch, activity scores were dropped by category inner join');
  assert.equal(beforeReport.weekly_tests[0].title, 'November Week 1 Mock');
  assert.equal(beforeReport.weekly_tests[0].category, '1 Digit 4 Rows');

  // 7. Apply STANDALONE PATCH
  const patchPath = path.join(ROOT_DIR, 'supabase', 'standalone_student_month_report_patch.sql');
  const patchSql = fs.readFileSync(patchPath, 'utf8');
  await db.exec(patchSql);

  // 8. Capture AFTER patch report
  const afterRes = await db.query(`SELECT public.student_month_report('${riyaId}', '2026-11-01'::DATE)`);
  const rawAfter = afterRes.rows[0].student_month_report;
  const afterReport = typeof rawAfter === 'string' ? JSON.parse(rawAfter) : rawAfter;

  // 9. ASSERT EXACT EQUALITY of all unrelated report values:
  const { weekly_tests: _wBefore, ...beforeRest } = beforeReport;
  const { weekly_tests: _wAfter, ...afterRest } = afterReport;

  assert.deepEqual(afterRest, beforeRest, 'All unrelated report values must remain strictly unchanged');

  // 10. ASSERT weekly_tests contents:
  // Existing category score retains its exact values
  const retainedCatScore = afterReport.weekly_tests.find((t) => t.title === 'November Week 1 Mock');
  assert.ok(retainedCatScore, 'Category-based score must be retained');
  assert.equal(retainedCatScore.category, '1 Digit 4 Rows');
  assert.equal(retainedCatScore.correct, 18);
  assert.equal(retainedCatScore.total, 20);
  assert.equal(retainedCatScore.time_seconds, 110);

  // Confirmed STU101 example: Riya (STU101), "Square 1 to 25", 5 November 2026, 25/25
  const riyaSquareScore = afterReport.weekly_tests.filter((t) => t.category === 'Square - Stage 1 (1-25)');
  assert.equal(riyaSquareScore.length, 1, 'Confirmed STU101 Square 1 to 25 score must appear exactly ONCE (no duplicate rows)');
  assert.equal(riyaSquareScore[0].title, 'Weekly Online Assessment');
  assert.equal(riyaSquareScore[0].date, '2026-11-05');
  assert.equal(riyaSquareScore[0].correct, 25);
  assert.equal(riyaSquareScore[0].total, 25);
  assert.equal(riyaSquareScore[0].time_seconds, 45);

  // Flash score appears once
  const flashScores = afterReport.weekly_tests.filter((t) => t.category === 'Flash Anzan (1D 50N)');
  assert.equal(flashScores.length, 1, 'Flash score must appear exactly once');
  assert.equal(flashScores[0].correct, 48);
  assert.equal(flashScores[0].total, 50);

  // Memoriad score appears once
  const memScores = afterReport.weekly_tests.filter((t) => t.category === 'Mental Calendar Dates');
  assert.equal(memScores.length, 1, 'Memoriad score must appear exactly once');
  assert.equal(memScores[0].correct, 10);
  assert.equal(memScores[0].total, 10);

  // Total scores in month report is now exactly 4
  assert.equal(afterReport.weekly_tests.length, 4, 'Total weekly tests in report must be 4');
});
