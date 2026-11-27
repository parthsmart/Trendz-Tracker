// Weekly test practice (migration 38): practice after the official window
// closes, stored apart from official results.
//
// Runs migration 38 and the production weekly_test_leaderboard() in PGlite and
// drives the real api/weekly-test.js handlers through a small Supabase-like
// adapter. Proves:
//   - isolation: the official board, scores and attempts are byte-identical
//     after practice runs;
//   - timing: no practice (and no questions) before the official close;
//   - audience and centre rules, teacher visibility, and the
//     "where would I have stood" slotting.

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  handlePracticeBegin,
  handleStartWeeklyTestSection,
  handleSubmitWeeklyTestSection,
} from '../api/weekly-test.js';

const ID = {
  owner: '10000000-0000-4000-a000-000000000001',
  teacher: '10000000-0000-4000-a000-000000000002',
  otherTeacher: '10000000-0000-4000-a000-000000000003',
  ana: '20000000-0000-4000-a000-000000000001', // took the test, top score
  ben: '20000000-0000-4000-a000-000000000002', // took the test
  pia: '20000000-0000-4000-a000-000000000003', // missed it, practises
  xav: '20000000-0000-4000-a000-000000000004', // other level
  cleo: '20000000-0000-4000-a000-000000000005', // same level, other centre
  centreA: '30000000-0000-4000-a000-000000000001',
  centreB: '30000000-0000-4000-a000-000000000002',
  cat: '40000000-0000-4000-a000-000000000001',
};

/** Minimal Supabase-shaped adapter over PGlite for the API handlers. */
function adapter(db) {
  const rpc = async (fn, params = {}) => {
    try {
      const keys = Object.keys(params);
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const res = await db.query(`SELECT public.${fn}(${args}) AS res`, keys.map((k) => params[k]));
      return { data: res.rows[0]?.res ?? null, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.code } };
    }
  };

  const from = (table) => {
    const state = { op: 'select', cols: '*', data: null, conds: [], returning: null };
    const run = async () => {
      const vals = [];
      const ph = (v) => {
        vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
        return `$${vals.length}`;
      };
      let sql;
      if (state.op === 'insert') {
        const keys = Object.keys(state.data);
        sql = `INSERT INTO public.${table} (${keys.join(', ')}) VALUES (${keys.map((k) => ph(state.data[k])).join(', ')})`;
      } else if (state.op === 'update') {
        const keys = Object.keys(state.data);
        sql = `UPDATE public.${table} SET ${keys.map((k) => `${k} = ${ph(state.data[k])}`).join(', ')}`;
      } else if (state.op === 'delete') {
        sql = `DELETE FROM public.${table}`;
      } else {
        sql = `SELECT ${state.cols} FROM public.${table}`;
      }
      if (state.op !== 'insert' && state.conds.length) {
        sql += ' WHERE ' + state.conds.map(([c, v]) => `${c} = ${ph(v)}`).join(' AND ');
      }
      if (state.op !== 'select' && state.returning) sql += ` RETURNING ${state.returning}`;
      try {
        const res = await db.query(sql, vals);
        return { data: res.rows, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message, code: err.code } };
      }
    };
    const builder = {
      select(cols = '*') {
        if (state.op === 'select') state.cols = cols;
        else state.returning = cols;
        return builder;
      },
      insert(data) { state.op = 'insert'; state.data = data; return builder; },
      update(data) { state.op = 'update'; state.data = data; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq(c, v) { state.conds.push([c, v]); return builder; },
      gte() { return builder; },
      async single() { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async maybeSingle() { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve, reject) { return run().then(resolve, reject); },
    };
    return builder;
  };

  return { rpc, from };
}

async function asUser(db, id) {
  await db.query(`SELECT set_config('app.uid', $1, false)`, [id || '']);
}

async function officialSnapshot(db, viewer, testId) {
  await asUser(db, viewer);
  const board = await db.query(
    `SELECT * FROM public.weekly_test_leaderboard($1, 'month', NULL, 10, 'level')`,
    [testId]
  );
  const scores = await db.query(
    `SELECT student_id, section_id, correct, total, time_seconds, source FROM public.weekly_test_scores ORDER BY student_id, section_id`
  );
  const attempts = await db.query(
    `SELECT student_id, section_id, status, tries_started FROM public.weekly_test_attempts ORDER BY student_id, section_id`
  );
  return JSON.stringify({ board: board.rows, scores: scores.rows, attempts: attempts.rows });
}

describe('Weekly test practice (migration 38)', () => {
  let db;
  let api;
  let closedTest;
  let closedSection;
  let openTest;
  let openSection;

  before(async () => {
    db = new PGlite();
    api = adapter(db);
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;

      CREATE TABLE public.centres (id uuid PRIMARY KEY, name text, status text DEFAULT 'active');
      CREATE TABLE public.profiles (
        id uuid PRIMARY KEY, role text NOT NULL, level text, active boolean NOT NULL DEFAULT true,
        deleted_at timestamptz, centre_id uuid REFERENCES public.centres (id),
        full_name text, student_code text, leaderboard_visible boolean NOT NULL DEFAULT true);
      CREATE TABLE public.categories (id uuid PRIMARY KEY, name text, section text, active boolean DEFAULT true);
      CREATE TABLE public.weekly_tests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_date date NOT NULL, title text NOT NULL,
        notes text, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz,
        updated_by uuid, test_type text NOT NULL DEFAULT 'online', audience_level text,
        opens_at timestamptz, closes_at timestamptz, remind_days_before int DEFAULT 7,
        target_scope text NOT NULL DEFAULT 'all');
      CREATE TABLE public.weekly_test_sections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id uuid NOT NULL REFERENCES public.weekly_tests (id) ON DELETE CASCADE,
        position int NOT NULL, category_id uuid, seconds int, kind text NOT NULL, activity_key text,
        flash_digits smallint, flash_count int, flash_speed_ms int, flash_mode text, question_count int);
      CREATE TABLE public.weekly_test_recipients (test_id uuid, student_id uuid);
      CREATE TABLE public.weekly_test_scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_id uuid NOT NULL, student_id uuid NOT NULL,
        category_id uuid, section_id uuid, correct int NOT NULL, total int NOT NULL, time_seconds int,
        source text DEFAULT 'online', UNIQUE (test_id, student_id, section_id));
      CREATE TABLE public.weekly_test_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_id uuid, student_id uuid, category_id uuid,
        session_id uuid, status text, started_at timestamptz DEFAULT now(), finished_at timestamptz,
        section_id uuid, tries_started int DEFAULT 0, tries_correct int DEFAULT 0, seconds_used int DEFAULT 0,
        claim_token uuid, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.drill_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL, activity_type text,
        activity_name text, settings jsonb, questions jsonb, expected jsonb, min_seconds int,
        started_at timestamptz, expires_at timestamptz, status text DEFAULT 'open');
      CREATE TABLE public.teacher_student_assignments (teacher_id uuid, student_id uuid);

      CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS
        $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;
      CREATE FUNCTION public.my_role() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT role FROM public.profiles WHERE id = auth.uid() AND active $$;
      CREATE FUNCTION public.my_centre() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT centre_id FROM public.profiles WHERE id = auth.uid() $$;
      CREATE FUNCTION public.is_network_admin() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(public.my_role() IN ('owner', 'director', 'admin'), false) $$;
      CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT public.is_network_admin() $$;
      CREATE FUNCTION public.is_centre_admin(p_centre uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT public.is_network_admin() OR COALESCE(p_centre IS NOT NULL
             AND public.my_role() IN ('centre_head', 'vice_centre_head') AND public.my_centre() = p_centre, false) $$;
      CREATE FUNCTION public.profile_centre(p uuid) RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT centre_id FROM public.profiles WHERE id = p $$;
      CREATE FUNCTION public.is_teacher_assigned_to_student(t uuid, s uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT EXISTS (SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = t AND student_id = s) $$;
      CREATE FUNCTION public.has_weekly_test_recipients(p uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT EXISTS (SELECT 1 FROM public.weekly_test_recipients WHERE test_id = p) $$;
      CREATE FUNCTION public.is_weekly_test_recipient(p uuid, s uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT EXISTS (SELECT 1 FROM public.weekly_test_recipients WHERE test_id = p AND student_id = s) $$;
      CREATE FUNCTION public.competition_rules() RETURNS TABLE (weekly_test_multiplier numeric, leaderboard_names text)
        LANGUAGE sql STABLE AS $$ SELECT 1.0::numeric, 'full'::text $$;
      CREATE FUNCTION public.display_name_for(n text, c text) RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT n $$;
      CREATE FUNCTION public.flash_generate_question(p_digits int, p_count int, p_mode text) RETURNS jsonb
        LANGUAGE sql AS $$ SELECT jsonb_build_object('numbers', jsonb_build_array(1, 2, 3, 4, 5)) $$;
      CREATE FUNCTION public.global_leaderboard_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.period_bounds(p text) RETURNS TABLE (d_from date, d_to date) LANGUAGE sql STABLE AS
        $$ SELECT (now() - interval '60 days')::date, now()::date $$;
    `);
    await db.exec(fs.readFileSync(path.resolve('tests/fixtures/weekly_test_leaderboard_live.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.resolve('supabase/migrations/38_weekly_test_practice.sql'), 'utf8'));

    await db.exec(`
      INSERT INTO public.centres (id, name) VALUES ('${ID.centreA}', 'A'), ('${ID.centreB}', 'B');
      INSERT INTO public.profiles (id, role, level, centre_id, full_name, student_code) VALUES
        ('${ID.owner}', 'owner', NULL, NULL, 'Owner', NULL),
        ('${ID.teacher}', 'teacher', NULL, '${ID.centreA}', 'Teacher', NULL),
        ('${ID.otherTeacher}', 'teacher', NULL, '${ID.centreA}', 'Other Teacher', NULL),
        ('${ID.ana}', 'student', 'Level 1', '${ID.centreA}', 'Ana', 'S1'),
        ('${ID.ben}', 'student', 'Level 1', '${ID.centreA}', 'Ben', 'S2'),
        ('${ID.pia}', 'student', 'Level 1', '${ID.centreA}', 'Pia', 'S3'),
        ('${ID.xav}', 'student', 'Level 2', '${ID.centreA}', 'Xav', 'S4'),
        ('${ID.cleo}', 'student', 'Level 1', '${ID.centreB}', 'Cleo', 'S5');
      INSERT INTO public.teacher_student_assignments VALUES ('${ID.teacher}', '${ID.pia}');
      INSERT INTO public.categories (id, name, section) VALUES ('${ID.cat}', '1D 4R', 'basics');
    `);
  });

  beforeEach(async () => {
    await db.exec(`
      DELETE FROM public.weekly_test_practice_attempts; DELETE FROM public.weekly_test_practice_runs;
      DELETE FROM public.drill_sessions; DELETE FROM public.weekly_test_scores;
      DELETE FROM public.weekly_test_attempts; DELETE FROM public.weekly_test_recipients;
      DELETE FROM public.weekly_tests;
    `);
    const mk = async (title, opens, closes, level = 'Level 1') => {
      const t = await db.query(
        `INSERT INTO public.weekly_tests (test_date, title, test_type, audience_level, opens_at, closes_at, created_by)
         VALUES (CURRENT_DATE, $1, 'online', $2, now() + $3::interval, now() + $4::interval, $5) RETURNING id`,
        [title, level, opens, closes, ID.owner]
      );
      const s = await db.query(
        `INSERT INTO public.weekly_test_sections (test_id, position, category_id, seconds, kind)
         VALUES ($1, 1, $2, 60, 'basics') RETURNING id`,
        [t.rows[0].id, ID.cat]
      );
      return [t.rows[0].id, s.rows[0].id];
    };
    [closedTest, closedSection] = await mk('Closed test', '-2 days', '-1 day');
    [openTest, openSection] = await mk('Running test', '-1 hour', '+1 hour');

    // Official results of the closed test: Ana 20/22 (18 pts), Ben 10/14 (6 pts).
    await db.query(
      `INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
       VALUES ($1, $3, $2, $5, 20, 22, 60), ($1, $4, $2, $5, 10, 14, 60)`,
      [closedTest, closedSection, ID.ana, ID.ben, ID.cat]
    );
    await db.query(
      `INSERT INTO public.weekly_test_attempts (test_id, student_id, section_id, status, tries_started)
       VALUES ($1, $3, $2, 'submitted', 1), ($1, $4, $2, 'submitted', 1)`,
      [closedTest, closedSection, ID.ana, ID.ben]
    );
  });

  /** Begins a run, starts the basics section, answers `right` correctly and `wrong` wrongly. */
  async function practise(studentId, testId, sectionId, right, wrong) {
    const student = { id: studentId };
    const begin = await handlePracticeBegin({ student, body: { test_id: testId }, adminSupabase: api });
    assert.equal(begin.statusCode, 200, JSON.stringify(begin.payload));
    const runId = begin.payload.run_id;

    const startedAt = new Date();
    const start = await handleStartWeeklyTestSection({
      student,
      body: { test_id: testId, section_id: sectionId, run_id: runId },
      adminSupabase: api,
      practice: true,
      now: startedAt,
    });
    assert.equal(start.statusCode, 200, JSON.stringify(start.payload));
    assert.equal(start.payload.kind, 'basics');

    const session = await db.query(`SELECT expected, settings FROM public.drill_sessions WHERE id = $1`, [
      start.payload.session_id,
    ]);
    assert.equal(session.rows[0].settings.attempt_type, 'practice');
    const expected = session.rows[0].expected;
    const answers = [
      ...expected.slice(0, right).map((v) => String(v)),
      ...expected.slice(right, right + wrong).map((v) => String(Number(v) + 1)),
    ];

    const submit = await handleSubmitWeeklyTestSection({
      student,
      body: { session_id: start.payload.session_id, answers },
      adminSupabase: api,
      now: new Date(startedAt.getTime() + 40_000),
    });
    assert.equal(submit.statusCode, 200, JSON.stringify(submit.payload));
    assert.equal(submit.payload.correct, right);
    return { runId, submit };
  }

  it('isolation: a practice run leaves the official board, scores and attempts unchanged', async () => {
    const before = {
      ana: await officialSnapshot(db, ID.ana, closedTest),
      pia: await officialSnapshot(db, ID.pia, closedTest),
      owner: await officialSnapshot(db, ID.owner, closedTest),
    };

    await practise(ID.pia, closedTest, closedSection, 25, 1); // 49 pts: would beat Ana
    await practise(ID.ben, closedTest, closedSection, 30, 0); // a retake by someone who took it

    assert.equal(await officialSnapshot(db, ID.ana, closedTest), before.ana);
    assert.equal(await officialSnapshot(db, ID.pia, closedTest), before.pia);
    assert.equal(await officialSnapshot(db, ID.owner, closedTest), before.owner);

    const practiceRows = await db.query(`SELECT student_id, correct, total FROM public.weekly_test_practice_attempts ORDER BY correct`);
    assert.deepEqual(
      practiceRows.rows.map((r) => [r.student_id, r.correct, r.total]),
      [[ID.pia, 25, 26], [ID.ben, 30, 30]]
    );
  });

  it('standing: the practice score is slotted into the official board, for the student only', async () => {
    const { runId } = await practise(ID.pia, closedTest, closedSection, 20, 0); // 20 pts: above Ana (18)

    await asUser(db, ID.pia);
    const res = (await db.query(`SELECT public.weekly_test_practice_standing($1) AS r`, [closedTest])).rows[0].r;
    assert.equal(res.run_id, runId);
    assert.equal(res.label, 'Practice — not official');
    assert.equal(res.practice.points, 20);
    assert.equal(res.practice.rank, 1);
    assert.equal(res.practice.out_of, 3);
    assert.equal(res.official.took_test, false);
    assert.deepEqual(
      res.board.map((r) => [r.rank, r.display_name, r.is_practice]),
      [[1, 'Pia', true], [2, 'Ana', false], [3, 'Ben', false]]
    );

    // Another student sees the plain official board: no practice rows, no Pia.
    await asUser(db, ID.ana);
    const board = await db.query(`SELECT display_name, rank FROM public.weekly_test_leaderboard($1)`, [closedTest]);
    assert.deepEqual(board.rows.map((r) => [r.rank, r.display_name]), [[1, 'Ana'], [2, 'Ben']]);
    await assert.rejects(
      db.query(`SELECT public.weekly_test_practice_standing($1, $2)`, [closedTest, runId]),
      /No practice score yet/
    );
  });

  it('standing: a retake replaces the student\'s own official row and keeps their official rank', async () => {
    await practise(ID.ben, closedTest, closedSection, 5, 0); // 10 pts practice; official was 6 pts (rank 2)
    await asUser(db, ID.ben);
    const res = (await db.query(`SELECT public.weekly_test_practice_standing($1) AS r`, [closedTest])).rows[0].r;
    assert.equal(res.official.took_test, true);
    assert.equal(res.official.rank, 2);
    assert.equal(res.practice.rank, 2);
    assert.deepEqual(
      res.board.map((r) => [r.display_name, r.is_practice]),
      [['Ana', false], ['Ben', true]]
    );
  });

  it('timing: no practice run, reservation or questions before the official window closes', async () => {
    const begin = await handlePracticeBegin({
      student: { id: ID.pia },
      body: { test_id: openTest },
      adminSupabase: api,
    });
    assert.equal(begin.statusCode, 400);
    assert.match(begin.payload.error, /after the official test closes/);

    // Even with a run id from another (closed) test, the open test's section is refused.
    const run = await handlePracticeBegin({ student: { id: ID.pia }, body: { test_id: closedTest }, adminSupabase: api });
    const start = await handleStartWeeklyTestSection({
      student: { id: ID.pia },
      body: { test_id: openTest, section_id: openSection, run_id: run.payload.run_id },
      adminSupabase: api,
      practice: true,
    });
    assert.equal(start.statusCode, 400);
    const sessions = await db.query(`SELECT count(*)::int AS n FROM public.drill_sessions`);
    assert.equal(sessions.rows[0].n, 0);

    await asUser(db, ID.pia);
    const mine = (await db.query(`SELECT public.my_weekly_test_practice($1) AS r`, [openTest])).rows[0].r;
    assert.equal(mine.can_practise, false);
    await assert.rejects(db.query(`SELECT public.weekly_test_practice_standing($1)`, [openTest]), /closes/);

    // A test without an explicit window closes at the end of its IST day.
    await db.query(`UPDATE public.weekly_tests SET opens_at = NULL, closes_at = NULL, test_date = public.today_ist() WHERE id = $1`, [openTest]);
    const sameDay = await handlePracticeBegin({ student: { id: ID.pia }, body: { test_id: openTest }, adminSupabase: api });
    assert.equal(sameDay.statusCode, 400);
  });

  it('timing: practice opens as soon as the window closes', async () => {
    await db.query(`UPDATE public.weekly_tests SET closes_at = now() - interval '1 second' WHERE id = $1`, [openTest]);
    await practise(ID.pia, openTest, openSection, 3, 0);
  });

  it('audience: other levels, other centres and non-recipients cannot practise', async () => {
    const other = await handlePracticeBegin({ student: { id: ID.xav }, body: { test_id: closedTest }, adminSupabase: api });
    assert.equal(other.statusCode, 400);
    assert.match(other.payload.error, /Level 1 students only/);

    // A test written by a centre-A teacher is not open to a centre-B student.
    await db.query(`UPDATE public.weekly_tests SET created_by = $2 WHERE id = $1`, [closedTest, ID.teacher]);
    const cleo = await handlePracticeBegin({ student: { id: ID.cleo }, body: { test_id: closedTest }, adminSupabase: api });
    assert.equal(cleo.statusCode, 400);
    assert.match(cleo.payload.error, /another centre/);

    await db.query(`INSERT INTO public.weekly_test_recipients VALUES ($1, $2)`, [closedTest, ID.ana]);
    const pia = await handlePracticeBegin({ student: { id: ID.pia }, body: { test_id: closedTest }, adminSupabase: api });
    assert.equal(pia.statusCode, 400);
    assert.match(pia.payload.error, /not assigned to you/);
  });

  it('a run cannot be used by another student or for another test', async () => {
    const run = await handlePracticeBegin({ student: { id: ID.pia }, body: { test_id: closedTest }, adminSupabase: api });
    const stolen = await handleStartWeeklyTestSection({
      student: { id: ID.ben },
      body: { test_id: closedTest, section_id: closedSection, run_id: run.payload.run_id },
      adminSupabase: api,
      practice: true,
    });
    assert.equal(stolen.statusCode, 400);
    assert.match(stolen.payload.error, /Practice run not found/);
  });

  it('a section can be finished once per run, and a new run allows another go', async () => {
    const { runId } = await practise(ID.pia, closedTest, closedSection, 4, 0);
    const again = await handleStartWeeklyTestSection({
      student: { id: ID.pia },
      body: { test_id: closedTest, section_id: closedSection, run_id: runId },
      adminSupabase: api,
      practice: true,
    });
    assert.equal(again.statusCode, 400);
    assert.match(again.payload.error, /already finished this section/);
    await practise(ID.pia, closedTest, closedSection, 6, 0);
    await asUser(db, ID.pia);
    const res = (await db.query(`SELECT public.weekly_test_practice_standing($1) AS r`, [closedTest])).rows[0].r;
    assert.equal(res.practice.correct, 6); // latest run
  });

  it('teachers see practice runs of their own students only, labelled practice', async () => {
    await practise(ID.pia, closedTest, closedSection, 7, 1);
    await practise(ID.ben, closedTest, closedSection, 3, 0);

    await asUser(db, ID.teacher);
    const mine = (await db.query(`SELECT public.weekly_test_practice_review($1) AS r`, [closedTest])).rows[0].r;
    assert.deepEqual(mine.map((r) => [r.full_name, r.attempt_type, r.correct]), [['Pia', 'practice', 7]]);

    await asUser(db, ID.otherTeacher);
    const none = (await db.query(`SELECT public.weekly_test_practice_review($1) AS r`, [closedTest])).rows[0].r;
    assert.deepEqual(none, []);

    await asUser(db, ID.owner);
    const all = (await db.query(`SELECT public.weekly_test_practice_review($1) AS r`, [closedTest])).rows[0].r;
    assert.equal(all.length, 2);

    await asUser(db, ID.pia);
    await assert.rejects(db.query(`SELECT public.weekly_test_practice_review($1)`, [closedTest]), /Not allowed/);
  });

  it('submitting a practice session through the normal submit action writes nothing official', async () => {
    const before = await officialSnapshot(db, ID.owner, closedTest);
    await practise(ID.pia, closedTest, closedSection, 9, 0);
    assert.equal(await officialSnapshot(db, ID.owner, closedTest), before);
    const off = await db.query(`SELECT count(*)::int AS n FROM public.weekly_test_scores WHERE student_id = $1`, [ID.pia]);
    assert.equal(off.rows[0].n, 0);
  });

  it('flash sections: practice tries are counted per run and never touch official attempts', async () => {
    const flash = await db.query(
      `INSERT INTO public.weekly_test_sections (test_id, position, kind, flash_digits, flash_count, flash_speed_ms, flash_mode, question_count)
       VALUES ($1, 2, 'flash', 1, 5, 1000, 'add', 2) RETURNING id`,
      [closedTest]
    );
    const sectionId = flash.rows[0].id;
    const before = await officialSnapshot(db, ID.owner, closedTest);
    const student = { id: ID.pia };
    const run = await handlePracticeBegin({ student, body: { test_id: closedTest }, adminSupabase: api });
    const runId = run.payload.run_id;
    const answers = ['15', '0'];
    let last;
    for (let i = 0; i < 2; i++) {
      const t0 = new Date();
      const start = await handleStartWeeklyTestSection({
        student, body: { test_id: closedTest, section_id: sectionId, run_id: runId },
        adminSupabase: api, practice: true, now: t0,
      });
      assert.equal(start.statusCode, 200, JSON.stringify(start.payload));
      last = await handleSubmitWeeklyTestSection({
        student, body: { session_id: start.payload.session_id, answer: answers[i] },
        adminSupabase: api, now: new Date(t0.getTime() + 10_000),
      });
      assert.equal(last.statusCode, 200, JSON.stringify(last.payload));
    }
    assert.equal(last.payload.done, true);
    assert.equal(last.payload.correct, 1);
    const row = await db.query(
      `SELECT status, tries_started, tries_correct, correct, total FROM public.weekly_test_practice_attempts WHERE section_id = $1`,
      [sectionId]
    );
    assert.deepEqual(row.rows[0], { status: 'submitted', tries_started: 2, tries_correct: 1, correct: 1, total: 2 });
    assert.equal(await officialSnapshot(db, ID.owner, closedTest), before);
  });
});
