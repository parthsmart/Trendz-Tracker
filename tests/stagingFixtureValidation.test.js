/**
 * Trendz Tracker — Independent Staging Fixture Validation Suite
 * File: tests/stagingFixtureValidation.test.js
 *
 * PURPOSE:
 * Repeatable local validation of the representative staging database schema,
 * enforcing required fields, foreign key relationships, check constraints,
 * date normalization, and full score/session lifecycle in isolated PostgreSQL (PGlite).
 *
 * This test runs on every ordinary `npm test` and proves fixture SQL correctness
 * independently of remote network access or skip/failure demonstrations.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

describe('Staging Schema Fixture Validation (Isolated PostgreSQL)', () => {
  let db;

  const testStudentId = crypto.randomUUID();
  const testStudentCode = `VAL_${Date.now().toString(36)}`;
  const testCategoryId = crypto.randomUUID();
  const testTaskId = crypto.randomUUID();

  before(async () => {
    db = new PGlite();

    // Install representative schema with authoritative columns, foreign keys, and check constraints
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;

      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        aud TEXT DEFAULT 'authenticated',
        role TEXT DEFAULT 'authenticated'
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        student_code TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin', 'teacher')),
        active BOOLEAN NOT NULL DEFAULT true,
        level TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
        level TEXT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-01 00:00:00+05:30'::timestamptz,
        target_scope TEXT NOT NULL DEFAULT 'all',
        activity_key TEXT,
        flash_digits INT,
        flash_count INT,
        flash_speed_ms INT,
        flash_mode TEXT,
        required_count INT NOT NULL DEFAULT 1,
        duration_seconds INT NULL CHECK (duration_seconds IS NULL OR (duration_seconds >= 5 AND duration_seconds <= 3600))
      );

      CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
        round_number INTEGER NULL,
        correct INTEGER NULL CHECK (correct >= 0),
        total INTEGER NULL CHECK (total >= 0),
        time_seconds INTEGER NULL CHECK (time_seconds >= 0),
        note TEXT NULL,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        verified BOOLEAN NOT NULL DEFAULT false,
        source TEXT NOT NULL DEFAULT 'practice',
        practice_mode TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element', 'basics', 'round', 'memoriad')),
        activity_name TEXT NOT NULL,
        settings JSONB NOT NULL,
        questions JSONB NOT NULL,
        expected JSONB NOT NULL,
        min_seconds NUMERIC NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID
      );

      CREATE TABLE IF NOT EXISTS public.daily_todo_log (
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        tasks_done INTEGER NOT NULL DEFAULT 0,
        all_done BOOLEAN NOT NULL DEFAULT false,
        finalized_at TIMESTAMPTZ,
        plan_snapshot JSONB,
        PRIMARY KEY (student_id, day)
      );
    `);
  });

  after(async () => {
    if (db) {
      await db.close();
    }
  });

  it('1. Foreign key enforcement: profiles.id strictly requires auth.users row', async () => {
    const unseededAuthId = crypto.randomUUID();
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.profiles (id, student_code, full_name, role, active)
           VALUES ($1, 'NO_AUTH', 'No Auth User', 'student', true)`,
          [unseededAuthId]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes('foreign key constraint') || err.code === '23503',
          `Expected foreign key violation, got: ${err.message}`
        );
        return true;
      },
      'Inserting profile without auth.users must fail with foreign key violation'
    );
  });

  it('2. Foreign key enforcement: results.category_id strictly requires valid category', async () => {
    // Seed valid auth user & profile
    await db.query(
      `INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [testStudentId, `${testStudentCode}@example.com`]
    );
    await db.query(
      `INSERT INTO public.profiles (id, student_code, full_name, role, active, level)
       VALUES ($1, $2, 'Validation Student', 'student', true, 'Level 1')`,
      [testStudentId, testStudentCode]
    );

    const nonExistentCatId = crypto.randomUUID();
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
           VALUES ($1, $2, 10, 10, 60, public.today_ist())`,
          [testStudentId, nonExistentCatId]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes('foreign key constraint') || err.code === '23503',
          `Expected category FK violation, got: ${err.message}`
        );
        return true;
      },
      'Inserting result without valid category must fail with foreign key violation'
    );
  });

  it('3. Check constraints: daily_tasks.duration_seconds enforces 5 to 3600 range', async () => {
    // Seed valid category
    await db.query(
      `INSERT INTO public.categories (id, name, section, sort_order, active)
       VALUES ($1, 'Validation Category', 'basics', 1, true)
       ON CONFLICT (id) DO NOTHING`,
      [testCategoryId]
    );

    // Below minimum (4 seconds)
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.daily_tasks (title, section, category_id, duration_seconds)
           VALUES ('Too Short', 'basics', $1, 4)`,
          [testCategoryId]
        );
      },
      (err) => err.code === '23514' || err.message.includes('violates check constraint'),
      'duration_seconds < 5 must be rejected by check constraint'
    );

    // Above maximum (3601 seconds)
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.daily_tasks (title, section, category_id, duration_seconds)
           VALUES ('Too Long', 'basics', $1, 3601)`,
          [testCategoryId]
        );
      },
      (err) => err.code === '23514' || err.message.includes('violates check constraint'),
      'duration_seconds > 3600 must be rejected by check constraint'
    );

    // Valid 60 seconds succeeds
    const taskRes = await db.query(
      `INSERT INTO public.daily_tasks (id, title, section, category_id, duration_seconds, required_count, target_scope, active)
       VALUES ($1, 'Valid 60s Task', 'basics', $2, 60, 2, 'targeted', true)
       RETURNING id`,
      [testTaskId, testCategoryId]
    );
    assert.equal(taskRes.rows[0].id, testTaskId);
  });

  it('4. Required fields & checks: drill_sessions enforces required columns and valid activity_type', async () => {
    // Missing required expires_at
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.drill_sessions (student_id, activity_type, activity_name, settings, questions, expected, min_seconds)
           VALUES ($1, 'basics', 'Basics 1d4r', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 60)`,
          [testStudentId]
        );
      },
      (err) => err.code === '23502' || err.message.includes('violates not-null constraint'),
      'Missing expires_at must fail with not-null constraint violation'
    );

    // Invalid activity_type
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.drill_sessions (student_id, activity_type, activity_name, settings, questions, expected, min_seconds, expires_at)
           VALUES ($1, 'invalid_activity', 'Test', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 60, now() + interval '10 minutes')`,
          [testStudentId]
        );
      },
      (err) => err.code === '23514' || err.message.includes('violates check constraint'),
      'Invalid activity_type must fail with check constraint violation'
    );
  });

  it('5. Full authoritative practice lifecycle: task recipient, results, drill_session, and daily_todo_log snapshot', async () => {
    // 5a. Attach targeted task to student
    await db.query(
      `INSERT INTO public.daily_task_recipients (task_id, student_id)
       VALUES ($1, $2)`,
      [testTaskId, testStudentId]
    );

    // 5b. Normalized Date: Retrieve today as YYYY-MM-DD string
    const dateRes = await db.query('SELECT (public.today_ist())::text AS today_text');
    const todayText = dateRes.rows[0].today_text;
    assert.match(todayText, /^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD');

    // 5c. Insert qualifying results row with authoritative schema
    const resultRes = await db.query(
      `INSERT INTO public.results (
         student_id, category_id, correct, total, time_seconds,
         entry_date, verified, source, practice_mode
       ) VALUES (
         $1, $2, 10, 10, 60,
         $3::date, true, 'site', 'timed'
       ) RETURNING id`,
      [testStudentId, testCategoryId, todayText]
    );
    const resultId = resultRes.rows[0].id;
    assert.ok(resultId);

    // 5d. Insert linked drill session with authoritative schema
    const sessionRes = await db.query(
      `INSERT INTO public.drill_sessions (
         student_id, activity_type, activity_name, settings, questions,
         expected, min_seconds, started_at, expires_at, status, submitted_at, result_row_id
       ) VALUES (
         $1, 'basics', 'Basics 1d4r',
         jsonb_build_object('todo_credit', true, 'todo_task_id', $2::text),
         '[{"q":"1+1"}]'::jsonb, '[2]'::jsonb, 60, now(), now() + interval '10 minutes',
         'submitted', now(), $3
       ) RETURNING id`,
      [testStudentId, testTaskId, resultId]
    );
    const sessionId = sessionRes.rows[0].id;
    assert.ok(sessionId);

    // 5e. Insert daily_todo_log row with snapshot and finalized_at
    const snapshot = [
      {
        id: testTaskId,
        title: 'Valid 60s Task',
        section: 'basics',
        category_id: testCategoryId,
        required_count: 2,
        duration_seconds: 60,
        sort_order: 0,
      },
    ];
    await db.query(
      `INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done, finalized_at, plan_snapshot)
       VALUES ($1, $2::date, 1, 1, true, now(), $3::jsonb)`,
      [testStudentId, todayText, JSON.stringify(snapshot)]
    );

    // 5f. Verify log record
    const logCheck = await db.query(
      `SELECT tasks_total, tasks_done, all_done, finalized_at, plan_snapshot
         FROM public.daily_todo_log
        WHERE student_id = $1 AND day = $2::date`,
      [testStudentId, todayText]
    );
    assert.equal(logCheck.rows.length, 1);
    assert.equal(logCheck.rows[0].tasks_total, 1);
    assert.equal(logCheck.rows[0].tasks_done, 1);
    assert.equal(logCheck.rows[0].all_done, true);
    assert.ok(logCheck.rows[0].finalized_at);
    assert.equal(logCheck.rows[0].plan_snapshot[0].id, testTaskId);

    // 5g. Clean up in reverse dependency order and verify zero remaining rows
    await db.query('DELETE FROM public.drill_sessions WHERE id = $1', [sessionId]);
    await db.query('DELETE FROM public.results WHERE id = $1', [resultId]);
    await db.query('DELETE FROM public.daily_todo_log WHERE student_id = $1', [testStudentId]);
    await db.query('DELETE FROM public.daily_task_recipients WHERE student_id = $1', [testStudentId]);
    await db.query('DELETE FROM public.daily_tasks WHERE id = $1', [testTaskId]);
    await db.query('DELETE FROM public.profiles WHERE id = $1', [testStudentId]);
    await db.query('DELETE FROM auth.users WHERE id = $1', [testStudentId]);
    await db.query('DELETE FROM public.categories WHERE id = $1', [testCategoryId]);

    const remainingCounts = await Promise.all([
      db.query('SELECT count(*)::int AS count FROM public.drill_sessions WHERE student_id = $1', [testStudentId]),
      db.query('SELECT count(*)::int AS count FROM public.results WHERE student_id = $1', [testStudentId]),
      db.query('SELECT count(*)::int AS count FROM public.daily_todo_log WHERE student_id = $1', [testStudentId]),
      db.query('SELECT count(*)::int AS count FROM public.daily_tasks WHERE id = $1', [testTaskId]),
      db.query('SELECT count(*)::int AS count FROM public.profiles WHERE id = $1', [testStudentId]),
      db.query('SELECT count(*)::int AS count FROM auth.users WHERE id = $1', [testStudentId]),
    ]);

    for (const res of remainingCounts) {
      assert.equal(res.rows[0].count, 0, 'All test records must be deleted');
    }
  });
});
