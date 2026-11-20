/**
 * Trendz Tracker — Two-Connection Staging PostgreSQL Concurrency & Parity Test Suite
 * File: tests/stagingStreakConcurrency.test.js
 *
 * PURPOSE:
 * Verifies transaction isolation, advisory lock serialization, midnight linkage,
 * historical score corrections, and cross-interface streak parity using TWO genuinely
 * separate PostgreSQL connections into a real PostgreSQL database (Staging project xhgzbbkvwojwfbexvcmh).
 *
 * BEHAVIORAL REQUIREMENTS:
 * - A configured but unreachable database produces a nonzero exit (FAIL).
 * - Missing STAGING_DATABASE_URL during ordinary npm test produces a genuine SKIP (not a false pass).
 * - No silent fallbacks to generic DATABASE_URL or PG* environment variables.
 * - Connection strictly validated to target xhgzbbkvwojwfbexvcmh and NEVER kgzivhavpsvitwrscrrj.
 * - Schemas match authoritative tables:
 *   * results uses category_id, total, time_seconds, source, practice_mode (no mode, wrong, total_questions, time_taken).
 *   * drill_sessions uses activity_type, activity_name, settings, questions, expected, min_seconds, expires_at (no section).
 *   * daily_tasks uses duration_seconds (no duration, min_questions, max_mistakes).
 *   * profiles.id references auth.users (foreign key strictly satisfied).
 * - Dates normalized: queries today_ist() as text and binds ISO 'YYYY-MM-DD' strings to match hashtext($2::text).
 * - Bounded polling for blocked locks in pg_locks replaces arbitrary sleep timers.
 * - Two actual writers: each connection inserts and links its own qualifying round within a transaction.
 * - Per-test finally blocks release/rollback transactions and settle outstanding promises.
 * - Complete cleanup: no swallowed auth.users deletion error; attempts all cleanup and connection closures, reporting any failures.
 * - Accounts for existing globally assigned tasks (reads baseline count before delta assertions).
 * - Does NOT alter shared staging's global clock (uses real public.today_ist()).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pkg from 'pg';
const { Client } = pkg;

// STRICT CONFIGURATION: STAGING_DATABASE_URL only, no fallbacks
const STAGING_DATABASE_URL = (process.env.STAGING_DATABASE_URL || '').trim();

/**
 * Bounded polling helper to inspect pg_locks for an advisory lock on targetPid.
 * Resolves with the matching lock row as soon as granted === expectedGranted,
 * or throws after timeoutMs.
 */
async function waitForLock(client, targetPid, expectedGranted, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await client.query(
      `SELECT locktype, objid, objsubid, mode, granted, pid
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = $1`,
      [targetPid]
    );
    const lock = res.rows.find((r) => r.granted === expectedGranted);
    if (lock) {
      return lock;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for pid ${targetPid} advisory lock with granted=${expectedGranted} (waited ${timeoutMs}ms)`
  );
}

describe('Staging Real PostgreSQL Two-Connection Concurrency & Parity Harness', () => {
  if (!STAGING_DATABASE_URL) {
    it.skip('Staging real PostgreSQL two-connection concurrency harness (STAGING_DATABASE_URL unset)', () => {
      // Intentionally skipped when STAGING_DATABASE_URL is not set
    });
    return;
  }

  let client1;
  let client2;
  let pid1;
  let pid2;
  let todayText;
  let baselineTasksTotal = 0;
  let baselineTasksDone = 0;

  // Test-owned IDs for deterministic cleanup
  const testStudentId = crypto.randomUUID();
  const testStudentCode = `STG_CONC_${Date.now().toString(36)}`;
  const testTaskId = crypto.randomUUID();
  const testPastTaskId = crypto.randomUUID();
  const testCategoryId = crypto.randomUUID();
  let categoryIdToUse = null;
  let testCategoryCreated = false;
  const createdResultIds = [];
  const createdSessionIds = [];

  before(async () => {
    // 1. Strict Target Project Safety Assertion
    assert.ok(
      STAGING_DATABASE_URL.includes('xhgzbbkvwojwfbexvcmh'),
      'STAGING_DATABASE_URL must target dedicated staging project xhgzbbkvwojwfbexvcmh'
    );
    assert.equal(
      STAGING_DATABASE_URL.includes('kgzivhavpsvitwrscrrj'),
      false,
      'SAFETY TRIPWIRE: STAGING_DATABASE_URL must NEVER target production project kgzivhavpsvitwrscrrj'
    );

    // 2. Establish TWO genuinely separate PostgreSQL connections
    const clientConfig = {
      connectionString: STAGING_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      ssl: STAGING_DATABASE_URL.includes('sslmode=require') || STAGING_DATABASE_URL.includes('supabase.co')
        ? { rejectUnauthorized: false }
        : undefined,
    };

    client1 = new Client(clientConfig);
    client2 = new Client(clientConfig);

    // Any connection failure throws here and causes node:test to exit nonzero
    await Promise.all([client1.connect(), client2.connect()]);

    // Set 10-second query statement timeouts to prevent hung tests
    await Promise.all([
      client1.query("SET statement_timeout = '10000'"),
      client2.query("SET statement_timeout = '10000'"),
    ]);

    // 3. Verify distinct backend worker PIDs on PostgreSQL
    const [res1, res2] = await Promise.all([
      client1.query('SELECT pg_backend_pid() AS pid'),
      client2.query('SELECT pg_backend_pid() AS pid'),
    ]);
    pid1 = res1.rows[0].pid;
    pid2 = res2.rows[0].pid;
    assert.notEqual(pid1, pid2, 'Client 1 and Client 2 must run on separate PostgreSQL backends');

    // 4. Production Tripwire Assertion on Database Content
    const tripwire = await client1.query(
      "SELECT 1 FROM public.profiles WHERE student_code = 'STU101' OR full_name = 'Riya'"
    );
    assert.equal(
      tripwire.rows.length,
      0,
      'SAFETY TRIPWIRE: Connected database contains production student profiles (STU101/Riya)! Aborting immediately.'
    );

    // 5. Preflight Setting Check: todo_streak_start MUST exist and cover tested dates (Never silently modified in tests)
    const streakStartRes = await client1.query(
      "SELECT value::date AS streak_start FROM public.competition_settings WHERE key = 'todo_streak_start'"
    );
    const streakStartRow = streakStartRes.rows[0];
    if (!streakStartRow || !streakStartRow.streak_start) {
      throw new Error(
        "PREFLIGHT FAILURE: 'todo_streak_start' is missing or null in public.competition_settings on Staging (xhgzbbkvwojwfbexvcmh). " +
        "Owner must apply supabase/staging_todo_streak_start_prerequisite.sql before running concurrency verification."
      );
    }
    const streakStartDate = new Date(streakStartRow.streak_start).toISOString().slice(0, 10);
    const pastDayRes = await client1.query("SELECT ((public.today_ist() - 5)::date)::text AS past_day_text");
    const pastDayText = pastDayRes.rows[0].past_day_text;
    if (streakStartDate > pastDayText) {
      throw new Error(
        `PREFLIGHT FAILURE: 'todo_streak_start' (${streakStartDate}) does not cover tested historical date (${pastDayText}). ` +
        "Owner must set todo_streak_start to '2026-10-29' or an earlier date via supabase/staging_todo_streak_start_prerequisite.sql."
      );
    }

    // 6. Normalize Dates: Read real India date as 'YYYY-MM-DD' TEXT string to preserve hashtext parity
    const todayRes = await client1.query('SELECT (public.today_ist())::text AS today_text');
    todayText = todayRes.rows[0].today_text;
    assert.ok(todayText && /^\d{4}-\d{2}-\d{2}$/.test(todayText), 'Must retrieve today_ist() as YYYY-MM-DD text');

    // 7. Satisfy Foreign Key: Insert auth.users record first for profiles.id reference
    await client1.query(
      `INSERT INTO auth.users (id, email, aud, role)
       VALUES ($1, $2, 'authenticated', 'authenticated')
       ON CONFLICT (id) DO NOTHING`,
      [testStudentId, `${testStudentCode}@example.com`]
    );

    // 8. Create isolated test student profile
    await client1.query(
      `INSERT INTO public.profiles (id, student_code, full_name, role, active, level)
       VALUES ($1, $2, 'Staging Concurrency Test Student', 'student', true, 'Level 1')
       ON CONFLICT (id) DO UPDATE SET active = true, role = 'student'`,
      [testStudentId, testStudentCode]
    );

    // 9. Obtain or create valid Basics category for results and tasks
    const catRes = await client1.query(
      "SELECT id FROM public.categories WHERE section = 'basics' AND active = true ORDER BY sort_order LIMIT 1"
    );
    if (catRes.rows.length > 0) {
      categoryIdToUse = catRes.rows[0].id;
    } else {
      categoryIdToUse = testCategoryId;
      await client1.query(
        `INSERT INTO public.categories (id, name, section, sort_order, active)
         VALUES ($1, 'Basics Concurrency Cat', 'basics', 999, true)
         ON CONFLICT (id) DO NOTHING`,
        [categoryIdToUse]
      );
      testCategoryCreated = true;
    }

    // 10. Read student baseline task count before adding targeted test task (accounting for global tasks)
    const baseRes = await client1.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE x.done))::int AS done
         FROM public._todo_status_on_internal($1, $2::date) x`,
      [testStudentId, todayText]
    );
    baselineTasksTotal = baseRes.rows[0].total || 0;
    baselineTasksDone = baseRes.rows[0].done || 0;

    // 11. Create targeted daily task for today requiring 2 online Basics rounds (duration_seconds = 60)
    await client1.query(
      `INSERT INTO public.daily_tasks (
         id, title, section, category_id, required_count, duration_seconds,
         target_scope, active, created_at
       ) VALUES (
         $1, 'Concurrency 2-Round Basics', 'basics', $2, 2, 60,
         'targeted', true, '2026-11-01 00:00:00+05:30'::timestamptz
       )`,
      [testTaskId, categoryIdToUse]
    );

    await client1.query(
      `INSERT INTO public.daily_task_recipients (task_id, student_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [testTaskId, testStudentId]
    );
  });

  after(async () => {
    const cleanupErrors = [];

    // 1. Immediately roll back BOTH connections so no uncommitted transactions/locks remain
    if (client1 && client1._connected) {
      try {
        await client1.query('ROLLBACK');
      } catch (err) {
        cleanupErrors.push(new Error(`Client 1 ROLLBACK failed: ${err.message}`));
      }
    }
    if (client2 && client2._connected) {
      try {
        await client2.query('ROLLBACK');
      } catch (err) {
        cleanupErrors.push(new Error(`Client 2 ROLLBACK failed: ${err.message}`));
      }
    }

    // 2. Complete, deterministic cleanup: attempt all steps, never swallowing errors
    if (client1 && client1._connected) {
      const steps = [
        {
          name: 'drill_sessions (createdSessionIds)',
          execute: () => (createdSessionIds.length > 0
            ? client1.query('DELETE FROM public.drill_sessions WHERE id = ANY($1)', [createdSessionIds])
            : Promise.resolve()),
        },
        {
          name: 'results (createdResultIds)',
          execute: () => (createdResultIds.length > 0
            ? client1.query('DELETE FROM public.results WHERE id = ANY($1)', [createdResultIds])
            : Promise.resolve()),
        },
        {
          name: 'drill_sessions (testStudentId)',
          execute: () => client1.query('DELETE FROM public.drill_sessions WHERE student_id = $1', [testStudentId]),
        },
        {
          name: 'results (testStudentId)',
          execute: () => client1.query('DELETE FROM public.results WHERE student_id = $1', [testStudentId]),
        },
        {
          name: 'daily_todo_log (testStudentId)',
          execute: () => client1.query('DELETE FROM public.daily_todo_log WHERE student_id = $1', [testStudentId]),
        },
        {
          name: 'daily_task_recipients (testStudentId)',
          execute: () => client1.query('DELETE FROM public.daily_task_recipients WHERE student_id = $1', [testStudentId]),
        },
        {
          name: 'daily_tasks (testTaskId, testPastTaskId)',
          execute: () => client1.query('DELETE FROM public.daily_tasks WHERE id IN ($1, $2)', [testTaskId, testPastTaskId]),
        },
        {
          name: 'profiles (testStudentId)',
          execute: () => client1.query('DELETE FROM public.profiles WHERE id = $1', [testStudentId]),
        },
        {
          name: 'auth.users (testStudentId)',
          execute: () => client1.query('DELETE FROM auth.users WHERE id = $1', [testStudentId]),
        },
        {
          name: 'categories (testCategoryId)',
          execute: () => (testCategoryCreated
            ? client1.query('DELETE FROM public.categories WHERE id = $1', [testCategoryId])
            : Promise.resolve()),
        },
      ];

      for (const step of steps) {
        try {
          await step.execute();
        } catch (err) {
          cleanupErrors.push(new Error(`Cleanup step "${step.name}" failed: ${err.message}`));
        }
      }
    }

    // 3. Attempt closing both connections
    if (client1) {
      try {
        await client1.end();
      } catch (err) {
        cleanupErrors.push(new Error(`Client 1 close failed: ${err.message}`));
      }
    }
    if (client2) {
      try {
        await client2.end();
      } catch (err) {
        cleanupErrors.push(new Error(`Client 2 close failed: ${err.message}`));
      }
    }

    // 4. Report any collected cleanup/closure failures
    if (cleanupErrors.length > 0) {
      const summary = cleanupErrors.map((e) => e.message).join('; ');
      throw new Error(`Test cleanup encountered failures: ${summary}`);
    }
  });

  it('1. Confirms two genuinely separate PostgreSQL backend connections', async () => {
    assert.ok(pid1 && pid2, 'Both connections must have valid backend PIDs');
    assert.notEqual(pid1, pid2, 'Client 1 and Client 2 must run on separate PostgreSQL backends');
  });

  it('2. Controlled overlap: Client 1 holds advisory transaction lock; Client 2 is verified WAITING in pg_locks', async () => {
    const lockDay = todayText; // Pure YYYY-MM-DD string
    let client2Promise = null;

    try {
      // Client 1 begins transaction and acquires advisory lock on (student, day)
      await client1.query('BEGIN');
      await client1.query(
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
        [testStudentId, lockDay]
      );

      let client2Finished = false;

      // Client 2 attempts to acquire the exact same advisory lock in a concurrent transaction
      client2Promise = (async () => {
        await client2.query('BEGIN');
        await client2.query(
          'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
          [testStudentId, lockDay]
        );
        client2Finished = true;
        await client2.query('COMMIT');
      })();

      // Use bounded polling to assert Client 2 is actively blocked with granted = false
      const client2Lock = await waitForLock(client1, pid2, false, 5000);
      assert.ok(client2Lock, 'Client 2 lock entry must exist in pg_locks');
      assert.equal(client2Lock.granted, false, 'Client 2 lock must be NOT GRANTED (WAITING)');
      assert.equal(client2Finished, false, 'Client 2 must NOT have finished while Client 1 holds lock');

      // Verify Client 1 lock is GRANTED
      const client1Lock = await waitForLock(client1, pid1, true, 5000);
      assert.ok(client1Lock, 'Client 1 lock entry must exist in pg_locks');
      assert.equal(client1Lock.granted, true, 'Client 1 lock must be GRANTED');

      // Client 1 commits transaction, releasing the lock
      await client1.query('COMMIT');

      // Client 2 must now immediately acquire the lock and finish cleanly
      await client2Promise;
      assert.equal(client2Finished, true, 'Client 2 must finish immediately after Client 1 commits');
    } finally {
      await client1.query('ROLLBACK').catch(() => {});
      await client2.query('ROLLBACK').catch(() => {});
      if (client2Promise) {
        await client2Promise.catch(() => {});
      }
    }
  });

  it('3. Real triggers under concurrency: two actual writers insert and link rounds in concurrent transactions', async () => {
    let client2Promise = null;

    try {
      // 1. Connection 1 begins its transaction
      await client1.query('BEGIN');

      // Connection 1 inserts its qualifying round 1 results row
      // Real trigger trg_sync_daily_todo_log_results fires and acquires pg_advisory_xact_lock(student, day)
      const res1 = await client1.query(
        `INSERT INTO public.results (
           student_id, category_id, correct, total, time_seconds,
           entry_date, verified, source, practice_mode
         ) VALUES (
           $1, $2, 10, 10, 60,
           $3::date, true, 'site', 'timed'
         ) RETURNING id`,
        [testStudentId, categoryIdToUse, todayText]
      );
      const resultId1 = res1.rows[0].id;
      createdResultIds.push(resultId1);

      // Connection 1 inserts and links its drill_sessions row with todo_credit = true
      const sess1 = await client1.query(
        `INSERT INTO public.drill_sessions (
           student_id, activity_type, activity_name, settings, questions,
           expected, min_seconds, started_at, expires_at, status, submitted_at, result_row_id
         ) VALUES (
           $1, 'basics', 'Basics 1d4r',
           jsonb_build_object('todo_credit', true, 'todo_task_id', $2::text),
           '[{"q":"1+1"}]'::jsonb, '[2]'::jsonb, 60, now(), now() + interval '10 minutes',
           'submitted', now(), $3
         ) RETURNING id`,
        [testStudentId, testTaskId, resultId1]
      );
      createdSessionIds.push(sess1.rows[0].id);

      // Connection 1 HOLDS ITS TRANSACTION OPEN!
      // Its transaction-level advisory lock on (student, day) remains active in pg_locks.

      let client2Finished = false;

      // 2. Connection 2 begins its own concurrent transaction and attempts to insert Round 2
      client2Promise = (async () => {
        await client2.query('BEGIN');

        // Connection 2 inserts its qualifying round 2 results row
        // Its trigger calls _sync_daily_todo_log and requests pg_advisory_xact_lock(student, day)
        // Since Connection 1 holds this transaction lock, Connection 2's insert BLOCKS inside the trigger!
        const res2 = await client2.query(
          `INSERT INTO public.results (
             student_id, category_id, correct, total, time_seconds,
             entry_date, verified, source, practice_mode
           ) VALUES (
             $1, $2, 10, 10, 60,
             $3::date, true, 'site', 'timed'
           ) RETURNING id`,
          [testStudentId, categoryIdToUse, todayText]
        );
        const resultId2 = res2.rows[0].id;
        createdResultIds.push(resultId2);

        // Connection 2 inserts and links its drill_sessions row with todo_credit = true
        const sess2 = await client2.query(
          `INSERT INTO public.drill_sessions (
             student_id, activity_type, activity_name, settings, questions,
             expected, min_seconds, started_at, expires_at, status, submitted_at, result_row_id
           ) VALUES (
             $1, 'basics', 'Basics 1d4r',
             jsonb_build_object('todo_credit', true, 'todo_task_id', $2::text),
             '[{"q":"2+2"}]'::jsonb, '[4]'::jsonb, 60, now(), now() + interval '10 minutes',
             'submitted', now(), $3
           ) RETURNING id`,
          [testStudentId, testTaskId, resultId2]
        );
        createdSessionIds.push(sess2.rows[0].id);

        await client2.query('COMMIT');
        client2Finished = true;
      })();

      // 3. Prove Connection 2 is actively blocked inside the real trigger via bounded polling
      const c2BlockedLock = await waitForLock(client1, pid2, false, 5000);
      assert.ok(c2BlockedLock, 'Connection 2 must be recorded in pg_locks inside the real trigger');
      assert.equal(c2BlockedLock.granted, false, 'Connection 2 lock inside trigger must be granted = false');
      assert.equal(client2Finished, false, 'Connection 2 must remain blocked while Connection 1 transaction is open');

      // 4. Connection 1 commits its transaction, releasing the advisory lock
      await client1.query('COMMIT');

      // 5. Connection 2 unblocks, completes its insert and linkage, and commits
      await client2Promise;
      assert.equal(client2Finished, true, 'Connection 2 must complete cleanly and commit after Connection 1 commits');

      // 6. Verify exact completion: Both rounds done by two actual writers
      const finalLog = await client1.query(
        'SELECT tasks_total, tasks_done, all_done, finalized_at, plan_snapshot FROM public.daily_todo_log WHERE student_id = $1 AND day = $2::date',
        [testStudentId, todayText]
      );
      assert.equal(finalLog.rows.length, 1);
      const row = finalLog.rows[0];
      assert.equal(row.tasks_total, baselineTasksTotal + 1, 'tasks_total must equal baseline + 1');
      assert.equal(row.tasks_done, baselineTasksDone + 1, 'Both rounds completed by separate writers -> tasks_done must be baseline + 1');
      assert.equal(row.all_done, row.tasks_done > 0 && row.tasks_done === row.tasks_total, 'all_done must match completion');
      assert.equal(row.finalized_at, null, 'finalized_at must be NULL for current in-flight day');
      assert.ok(row.plan_snapshot && Array.isArray(row.plan_snapshot), 'plan_snapshot must be captured');
    } finally {
      await client1.query('ROLLBACK').catch(() => {});
      await client2.query('ROLLBACK').catch(() => {});
      if (client2Promise) {
        await client2Promise.catch(() => {});
      }
    }
  });

  it('4. Concurrent historical corrections: finalized day preserves snapshot and timestamp under concurrent score edits', async () => {
    let concurrentPromise = null;

    try {
      // Generate distinct historical date string (5 days ago) as 'YYYY-MM-DD'
      const pastRes = await client1.query("SELECT ((public.today_ist() - 5)::date)::text AS past_day_text");
      const pastDayText = pastRes.rows[0].past_day_text;

      // Create a 1-round historical task snapshot matching authoritative schema
      const pastSnapshot = [
        {
          id: testPastTaskId,
          title: 'Past 1-Round Basics',
          section: 'basics',
          category_id: categoryIdToUse,
          required_count: 1,
          duration_seconds: 60,
          sort_order: 0,
        },
      ];

      // Seed qualifying result for pastDay
      const pastResultRes = await client1.query(
        `INSERT INTO public.results (
           student_id, category_id, correct, total, time_seconds,
           entry_date, verified, source, practice_mode
         ) VALUES (
           $1, $2, 10, 10, 60,
           $3::date, true, 'site', 'timed'
         ) RETURNING id`,
        [testStudentId, categoryIdToUse, pastDayText]
      );
      const pastResultId = pastResultRes.rows[0].id;
      createdResultIds.push(pastResultId);

      const pastSessRes = await client1.query(
        `INSERT INTO public.drill_sessions (
           student_id, activity_type, activity_name, settings, questions,
           expected, min_seconds, started_at, expires_at, status, submitted_at, result_row_id
         ) VALUES (
           $1, 'basics', 'Basics 1d4r',
           jsonb_build_object('todo_credit', true, 'todo_task_id', $2::text),
           '[{"q":"1+1"}]'::jsonb, '[2]'::jsonb, 60, now() - interval '5 days', (now() - interval '5 days') + interval '10 minutes',
           'submitted', now() - interval '5 days', $3
         ) RETURNING id`,
        [testStudentId, testPastTaskId, pastResultId]
      );
      createdSessionIds.push(pastSessRes.rows[0].id);

      // Seed finalized daily_todo_log with plan_snapshot and finalized_at
      const finalizedTimestamp = '2026-11-14T18:30:00Z';
      await client1.query(
        `INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done, finalized_at, plan_snapshot)
         VALUES ($1, $2::date, 1, 1, true, $3::timestamptz, $4::jsonb)
         ON CONFLICT (student_id, day) DO UPDATE
         SET tasks_total = 1, tasks_done = 1, all_done = true, finalized_at = $3::timestamptz, plan_snapshot = $4::jsonb`,
        [testStudentId, pastDayText, finalizedTimestamp, JSON.stringify(pastSnapshot)]
      );

      // Concurrently fire two score corrections on pastResultId from Client 1 and Client 2
      // Client 1 adjusts score from 10/10 to 9/10; Client 2 adjusts time_seconds to 58
      concurrentPromise = Promise.all([
        client1.query(
          'UPDATE public.results SET correct = 9, total = 10 WHERE id = $1',
          [pastResultId]
        ),
        client2.query(
          'UPDATE public.results SET time_seconds = 58 WHERE id = $1',
          [pastResultId]
        ),
      ]);

      const [c1Res, c2Res] = await concurrentPromise;
      assert.equal(c1Res.rowCount, 1);
      assert.equal(c2Res.rowCount, 1);

      // Verify: triggers fired, evaluated against historical plan_snapshot (1 round), and preserved finalized_at
      const verifiedLog = await client1.query(
        'SELECT tasks_total, tasks_done, all_done, finalized_at, plan_snapshot FROM public.daily_todo_log WHERE student_id = $1 AND day = $2::date',
        [testStudentId, pastDayText]
      );
      assert.equal(verifiedLog.rows.length, 1);
      const postRow = verifiedLog.rows[0];
      assert.equal(postRow.tasks_total, 1, 'Historical tasks_total must remain 1 from snapshot');
      assert.equal(postRow.tasks_done, 1, '9/10 qualifies for 1-round requirement -> tasks_done must be 1');
      assert.equal(postRow.all_done, true, 'all_done must remain true');
      assert.equal(
        new Date(postRow.finalized_at).toISOString(),
        new Date(finalizedTimestamp).toISOString(),
        'finalized_at timestamp must be preserved across score corrections'
      );
    } finally {
      await client1.query('ROLLBACK').catch(() => {});
      await client2.query('ROLLBACK').catch(() => {});
      if (concurrentPromise) {
        await concurrentPromise.catch(() => {});
      }
    }
  });

  it('5. Exact cross-interface reporting parity across streak_for, streak_calc, and daily_todo_log with authorization', async () => {
    try {
      // 5a. Set caller context to student's own UID so auth.uid() resolves in direct PG connection
      await client1.query(
        "SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)",
        [testStudentId]
      );

      // 5b. Query public wrapper streak_for (now authorized)
      const sForRes = await client1.query(
        'SELECT current_streak, best_streak, shields, active_today FROM public.streak_for($1)',
        [testStudentId]
      );

      // 5c. Query internal engine streak_calc
      const sCalcRes = await client1.query(
        'SELECT current_streak, best_streak, shields, active_today FROM public.streak_calc($1)',
        [testStudentId]
      );

      assert.equal(sForRes.rows.length, 1);
      assert.equal(sCalcRes.rows.length, 1);

      const sFor = sForRes.rows[0];
      const sCalc = sCalcRes.rows[0];

      // Assert exact parity
      assert.equal(sFor.current_streak, sCalc.current_streak, 'streak_for and streak_calc must match current_streak');
      assert.equal(sFor.best_streak, sCalc.best_streak, 'streak_for and streak_calc must match best_streak');
      assert.equal(sFor.shields, sCalc.shields, 'streak_for and streak_calc must match shields');
      assert.equal(sFor.active_today, sCalc.active_today, 'streak_for and streak_calc must match active_today');

      // Verify active_today matches today's daily_todo_log completion
      const todayLog = await client1.query(
        'SELECT all_done FROM public.daily_todo_log WHERE student_id = $1 AND day = $2::date',
        [testStudentId, todayText]
      );
      assert.equal(todayLog.rows.length, 1);
      assert.equal(sFor.active_today, todayLog.rows[0].all_done, 'active_today must match daily_todo_log.all_done');

      // 5d. Authorization check: Unauthorized third-party caller must receive 42501 Access denied
      const unauthorizedUid = crypto.randomUUID();
      await client1.query(
        "SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)",
        [unauthorizedUid]
      );

      await assert.rejects(
        async () => {
          await client1.query('SELECT current_streak FROM public.streak_for($1)', [testStudentId]);
        },
        (err) => {
          assert.ok(
            err.code === '42501' || (err.message && err.message.includes('Access denied')),
            `Expected 42501 Access denied, received: ${err.message}`
          );
          return true;
        },
        'Unauthorized caller must be rejected by streak_for with 42501'
      );
    } finally {
      // Restore context to test student
      if (client1 && client1._connected) {
        await client1.query(
          "SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)",
          [testStudentId]
        ).catch(() => {});
      }
    }
  });
});
