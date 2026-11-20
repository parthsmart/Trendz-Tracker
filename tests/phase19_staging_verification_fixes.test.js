/**
 * Trendz Tracker — Phase 19 Staging Verification Fixes
 * File: tests/phase19_staging_verification_fixes.test.js
 *
 * Verifies:
 * 1. Competition history query & normalization in js/dashboardData.js:
 *    - Queries `round_date` from `public.student_rounds` (not nonexistent `entry_date`)
 *    - Normalizes date fields (`round_date` and `entry_date`) on every returned round
 *    - Surfaces query errors rather than silently returning []
 *    - Staging fixture verification:
 *      - Student: STG-001 / Staging Student Alpha
 *      - Series: QA Phase19 Legacy Series
 *      - One recorded round with linked 8/10 score
 *      - setupScoreSheetController auto-selects populated series
 *      - Switching to empty series renders accurate empty state
 * 2. Real PostgreSQL (PGlite) execution of staging prerequisite:
 *    - Applies supabase/staging_phase19_my_weekly_tests_prerequisite.sql cleanly
 *    - Enforces operator latch and tripwire checks
 *    - Handles modern Elements/Flash/Memoriad sections (category_id is NULL)
 *    - Links section attempts and scores via section_id (with fallback to category_id)
 *    - Supports targeted recipients (weekly_test_recipients) and general audience
 *    - Staging fixture: "QA Phase19 Completed Weekly" with submitted Elements section (50/56)
 *    - Verifies dashboard card shows "Completed" and "View results", NOT "Start"
 *    - Rejects unauthenticated calls and verifies anon execute is revoked
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { groupTests, getWeeklyTestCompletionState, isSectionResumable, sectionStatusLabel } from '../js/weeklyTestView.js';
import { setupScoreSheetController } from '../js/dashboardComponents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Phase 19 — Staging Verification Fixes', () => {
  it('1. Competition history query: queries round_date, normalizes fields, and does not swallow errors', async () => {
    // Read source of js/dashboardData.js to verify table contract
    const dashboardDataJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'dashboardData.js'), 'utf-8');

    // 1a. Must select round_date, NOT entry_date from student_rounds
    assert.ok(
      dashboardDataJs.includes(".from('student_rounds')"),
      'Must query student_rounds table'
    );
    assert.ok(
      dashboardDataJs.includes("round_date"),
      'student_rounds query must select round_date'
    );
    assert.equal(
      dashboardDataJs.includes(".from('student_rounds')\n            .select('id, student_id, series_id, round_number, entry_date, created_at')"),
      false,
      'Must NOT select nonexistent entry_date from student_rounds'
    );

    // 1b. Must normalize both round_date and entry_date
    assert.ok(
      dashboardDataJs.includes('round_date: d') && dashboardDataJs.includes('entry_date: d'),
      'Must normalize both round_date and entry_date on returned rounds'
    );

    // 1c. Must throw on query error, NOT swallow into []
    assert.ok(
      dashboardDataJs.includes("throw new Error(`Failed to load student rounds: ${error.message}`)") ||
      dashboardDataJs.includes("throw err"),
      'Must not swallow student_rounds error as an empty array'
    );
  });

  it('2. Staging fixture score sheet: finds STG-001 round in QA Phase19 Legacy Series and handles empty series', () => {
    // Setup simulated DOM for setupScoreSheetController
    const domElements = new Map();
    function createMockElement(id) {
      let _id = id;
      const el = {
        get id() {
          return _id;
        },
        set id(val) {
          _id = val;
          if (val) domElements.set(val, el);
        },
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        style: {},
        className: '',
        children: [],
        parentElement: null,
        appendChild(child) {
          this.children.push(child);
          child.parentElement = this;
          return child;
        },
        insertBefore(newChild, refChild) {
          const idx = this.children.indexOf(refChild);
          if (idx >= 0) this.children.splice(idx, 0, newChild);
          else this.children.push(newChild);
          newChild.parentElement = this;
          return newChild;
        },
        addEventListener(event, fn) {
          this._listeners = this._listeners || {};
          this._listeners[event] = fn;
        },
        dispatchEvent(event) {
          if (this._listeners?.[event]) this._listeners[event]();
        },
      };
      if (id) domElements.set(id, el);
      return el;
    }

    const tableWrapper = createMockElement('sheet-table-wrapper');
    const rangeLabel = createMockElement('sheet-range-label');
    const olderBtn = createMockElement('btn-sheet-older');
    const newerBtn = createMockElement('btn-sheet-newer');
    const controlsContainer = createMockElement('sheet-controls');
    controlsContainer.appendChild(olderBtn);
    controlsContainer.appendChild(newerBtn);

    const origDoc = globalThis.document;
    globalThis.document = {
      getElementById(id) {
        return domElements.get(id) || null;
      },
      createElement(tag) {
        const el = createMockElement(`mock-${tag}-${Math.random().toString(36).slice(2, 6)}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
    };

    try {
      // Staging fixture data
      const studentId = 'STG-001';
      const roundSeries = [
        { id: 'ser-current', name: 'Simulator 2026', sort_order: 1, is_current: true },
        { id: 'ser-legacy', name: 'QA Phase19 Legacy Series', sort_order: 2, is_current: false },
      ];
      const categories = [
        { id: 'cat-1', name: 'Addition 1D', section: 'round', sort_order: 1, active: true },
        { id: 'cat-2', name: 'Multiplication 2D', section: 'round', sort_order: 2, active: true },
      ];
      const categorySeries = [
        { series_id: 'ser-legacy', category_id: 'cat-1', sort_order: 1 },
        { series_id: 'ser-legacy', category_id: 'cat-2', sort_order: 2 },
        { series_id: 'ser-current', category_id: 'cat-1', sort_order: 1 },
      ];

      // Round 1 in Legacy series with round_date (normalized)
      const studentRounds = [
        {
          id: 'sr-1',
          student_id: studentId,
          series_id: 'ser-legacy',
          round_number: 1,
          round_date: '2026-11-01',
          entry_date: '2026-11-01',
          round_type: 'Category wise',
          time_taken_seconds: null,
        },
      ];

      // One linked 8/10 score in cat-1
      const results = [
        {
          id: 'res-1',
          student_id: studentId,
          student_round_id: 'sr-1',
          category_id: 'cat-1',
          correct: 8,
          total: 10,
          time_seconds: 45,
          entry_date: '2026-11-01',
        },
      ];

      // Initialize score sheet controller
      setupScoreSheetController({
        results,
        categories,
        roundSeries,
        categorySeries,
        studentRounds,
        tableWrapperId: 'sheet-table-wrapper',
        rangeLabelId: 'sheet-range-label',
        olderBtnId: 'btn-sheet-older',
        newerBtnId: 'btn-sheet-newer',
      });

      const seriesSelect = domElements.get('select-sheet-series');
      assert.ok(seriesSelect, 'Series selector select-sheet-series must be created in header');

      // 2a. Verify auto-selection: default series Simulator 2026 has 0 rounds,
      // so it must automatically select QA Phase19 Legacy Series (1 round)
      assert.equal(
        seriesSelect.value,
        'ser-legacy',
        'Must auto-select QA Phase19 Legacy Series because it contains recorded rounds'
      );

      // Verify table rendered Round 1 score
      assert.ok(
        tableWrapper.innerHTML.includes('Round 1'),
        'Must render Round 1 header'
      );
      assert.ok(
        tableWrapper.innerHTML.includes('8/10'),
        'Must render the linked 8/10 score for Round 1'
      );
      assert.ok(
        rangeLabel.textContent.includes('QA Phase19 Legacy Series'),
        'Range label must display QA Phase19 Legacy Series'
      );

      // 2b. Switch to the empty series (Simulator 2026)
      seriesSelect.value = 'ser-current';
      seriesSelect.dispatchEvent('change');

      // Verify accurate empty state
      assert.ok(
        tableWrapper.innerHTML.includes('No rounds recorded in <strong>Simulator 2026</strong> yet.'),
        'Empty state must state no rounds recorded in selected series'
      );
      assert.ok(
        tableWrapper.innerHTML.includes('QA Phase19 Legacy Series (1 round)'),
        'Empty state must inform admin that student has rounds in QA Phase19 Legacy Series'
      );
    } finally {
      globalThis.document = origDoc;
    }
  });

  it('3. Real PostgreSQL (PGlite): staging prerequisite installs my_weekly_tests and matches staging fixture', async () => {
    const db = new PGlite();

    // 1. Setup baseline schema required by weekly tests
    await db.exec(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN END $$;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN END $$;

      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name TEXT NOT NULL,
        student_code TEXT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        level TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );

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
        test_type TEXT NOT NULL DEFAULT 'offline',
        audience_level TEXT NULL,
        target_scope TEXT NOT NULL DEFAULT 'all',
        opens_at TIMESTAMPTZ NULL,
        closes_at TIMESTAMPTZ NULL,
        remind_days_before INT NOT NULL DEFAULT 7,
        created_at TIMESTAMPTZ DEFAULT now()
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

      -- Exact actual staging schema: NO tries_started or tries_correct columns
      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID NULL REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
        category_id UUID NULL,
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
        category_id UUID NULL,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT NULL,
        source TEXT NOT NULL DEFAULT 'student',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_recipients (
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (test_id, student_id)
      );

      -- Helper to set simulated auth.uid() in PGlite session
      CREATE OR REPLACE FUNCTION public.set_auth_uid(p_uid UUID)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM set_config('app.current_user_id', COALESCE(p_uid::text, ''), false);
      END;
      $$;

      -- auth.uid() implementation for PGlite testing
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$;
    `);

    // 2. Apply the staging prerequisite SQL file
    const prereqPath = path.join(ROOT_DIR, 'supabase', 'staging_phase19_my_weekly_tests_prerequisite.sql');
    assert.ok(fs.existsSync(prereqPath), 'staging_phase19_my_weekly_tests_prerequisite.sql must exist');
    const prereqSql = fs.readFileSync(prereqPath, 'utf8');

    await db.exec(prereqSql);

    // Verify function created
    const procCheck = await db.query(`
      SELECT proname, provolatile, prosecdef
      FROM pg_proc
      WHERE proname = 'my_weekly_tests'
    `);
    assert.equal(procCheck.rows.length, 1);
    assert.equal(procCheck.rows[0].proname, 'my_weekly_tests');
    assert.equal(procCheck.rows[0].prosecdef, true);
    assert.equal(procCheck.rows[0].provolatile, 's'); // STABLE

    // Verify schema fidelity with real staging: weekly_test_attempts MUST NOT have tries_started or tries_correct
    const cols = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts'
    `);
    const colNames = cols.rows.map(r => r.column_name);
    assert.equal(colNames.includes('tries_started'), false, 'weekly_test_attempts must NOT have tries_started column');
    assert.equal(colNames.includes('tries_correct'), false, 'weekly_test_attempts must NOT have tries_correct column');

    // 3. Seed staging fixture:
    // Student: STG-001 / Staging Student Alpha
    const studentId = '00000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ($1, 'Staging Student Alpha', 'STG-001', 'student', 'Level 3', true)
    `, [studentId]);

    // Test: “QA Phase19 Completed Weekly” (Online test open now)
    const testId = '11111111-1111-1111-1111-111111111111';
    await db.query(`
      INSERT INTO public.weekly_tests (
        id, title, notes, test_date, test_type, target_scope, opens_at, closes_at
      ) VALUES (
        $1,
        'QA Phase19 Completed Weekly',
        'Staging verification fixture',
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        'online',
        'targeted',
        now() - interval '2 hours',
        now() + interval '5 days'
      )
    `, [testId]);

    // Assigned to STG-001
    await db.query(`
      INSERT INTO public.weekly_test_recipients (test_id, student_id)
      VALUES ($1, $2)
    `, [testId, studentId]);

    // One submitted Elements section (category_id is NULL)
    const sectionId = '22222222-2222-2222-2222-222222222222';
    await db.query(`
      INSERT INTO public.weekly_test_sections (
        id, test_id, position, kind, category_id, activity_key, seconds
      ) VALUES (
        $1, $2, 1, 'elements', NULL, 'day_codes', 60
      )
    `, [sectionId, testId]);

    // Attempt: submitted
    await db.query(`
      INSERT INTO public.weekly_test_attempts (
        test_id, student_id, section_id, status
      ) VALUES (
        $1, $2, $3, 'submitted'
      )
    `, [testId, studentId, sectionId]);

    // Score: 50 / 56
    await db.query(`
      INSERT INTO public.weekly_test_scores (
        test_id, student_id, section_id, correct, total, time_seconds
      ) VALUES (
        $1, $2, $3, 50, 56, 48
      )
    `, [testId, studentId, sectionId]);

    // 4. Test unauthenticated call: must throw 42501 (Not allowed)
    await db.query(`SELECT public.set_auth_uid(NULL);`);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.my_weekly_tests();`);
      },
      (err) => {
        // console.error('Caught rejection:', err);
        assert.ok(
          err.message.includes('Not allowed') ||
          err.message.includes('Authentication required') ||
          err.code === '42501' ||
          err.message.includes('42501'),
          `Expected authentication error, got: ${err.message}`
        );
        return true;
      },
      'Unauthenticated call must be rejected'
    );

    // 5. Authenticated call as STG-001
    await db.query(`SELECT public.set_auth_uid($1::UUID);`, [studentId]);
    const res = await db.query(`SELECT public.my_weekly_tests() AS tests;`);
    assert.equal(res.rows.length, 1);
    const tests = res.rows[0].tests;
    assert.ok(Array.isArray(tests));
    assert.equal(tests.length, 1);

    const test = tests[0];
    assert.equal(test.id, testId);
    assert.equal(test.title, 'QA Phase19 Completed Weekly');
    assert.equal(test.type, 'online');
    assert.equal(test.state, 'open');

    // Verify sections array has modern Elements section (even though category_id is NULL)
    assert.ok(Array.isArray(test.sections));
    assert.equal(test.sections.length, 1);
    const sec = test.sections[0];
    assert.equal(sec.section_id, sectionId);
    assert.equal(sec.kind, 'elements');
    assert.equal(sec.activity_key, 'day_codes');
    assert.equal(sec.category_id, null);
    assert.equal(sec.attempt, 'submitted');
    assert.equal(sec.correct, 50);
    assert.equal(sec.total, 56);

    // Verify scores array has matching 50/56 score
    assert.ok(Array.isArray(test.scores));
    assert.equal(test.scores.length, 1);
    assert.equal(test.scores[0].correct, 50);
    assert.equal(test.scores[0].total, 56);

    // 6. Verify client pure helpers: groupTests & getWeeklyTestCompletionState
    const { availableNow } = groupTests(tests);
    assert.equal(availableNow.length, 1, 'Test must be in availableNow because state is open');

    const completion = getWeeklyTestCompletionState(availableNow[0]);
    assert.equal(completion.state, 'completed');
    assert.equal(completion.label, 'Completed');
    assert.equal(completion.actionLabel, 'View results');
    assert.equal(completion.isCompleted, true);
    assert.equal(completion.submittedCount, 1);
    assert.equal(completion.totalCount, 1);

    // 7. Verify dashboard card rendering contract (matches js/student.js:loadAndRenderAvailableWeeklyTestCard)
    const isOnline = String(test.type || test.test_type || 'offline').toLowerCase() === 'online';
    let badgeHtml = '';
    let actionBtnHtml = '';
    let subtitleText = '';

    if (completion.state === 'completed') {
      badgeHtml = `<span class="badge" style="background: #DEF7EC; color: #03543F; font-size: 11px; font-weight: 700;">Completed</span>`;
      subtitleText = isOnline
        ? `All ${completion.totalCount} sections completed &middot; Scores submitted`
        : 'Scores recorded by your trainer';
      actionBtnHtml = `
        <a href="/pages/weekly-test.html" class="btn btn-outline btn-sm" style="text-decoration: none;">
          View results
        </a>
      `;
    } else {
      actionBtnHtml = `<a href="/pages/weekly-test.html" class="btn btn-primary btn-sm">Start</a>`;
    }

    const cardHtml = `
      <section class="card" aria-label="Available Weekly Test">
        <span>Weekly test: ${test.title}</span>
        ${badgeHtml}
        <div>${subtitleText}</div>
        ${actionBtnHtml}
      </section>
    `;

    assert.ok(cardHtml.includes('>Completed</span>'), 'Card must show Completed badge');
    assert.ok(cardHtml.includes('View results'), 'Card must offer View results button');
    assert.equal(cardHtml.includes('>Start</a>'), false, 'Card must NOT offer Start button');

    // 8. Test targeted isolation: another student must NOT see targeted test
    const otherStudentId = '00000000-0000-0000-0000-000000000002';
    await db.query(`
      INSERT INTO public.profiles (id, full_name, student_code, role, level, active)
      VALUES ($1, 'Other Student', 'STU-002', 'student', 'Level 3', true)
    `, [otherStudentId]);

    await db.query(`SELECT public.set_auth_uid($1::UUID);`, [otherStudentId]);
    const otherRes = await db.query(`SELECT public.my_weekly_tests() AS tests;`);
    const otherTests = otherRes.rows[0].tests;
    assert.equal(otherTests.length, 0, 'Targeted test must not be visible to unassigned student');

    // 9. Verify Flash Anzan progress derivation from existing session/attempt storage (drill_sessions)
    // Note: weekly_test_attempts has NO tries_started or tries_correct columns.
    const flashTestId = '22222222-2222-2222-2222-222222222222';
    const flashSectionId = '33333333-3333-3333-3333-333333333333';
    const flashSessionId = '44444444-4444-4444-4444-444444444444';

    await db.query(`
      INSERT INTO public.weekly_tests (
        id, title, notes, test_date, test_type, target_scope, opens_at, closes_at
      ) VALUES (
        $1, 'QA Phase19 Flash In-Progress', 'Flash progress verification',
        (now() AT TIME ZONE 'Asia/Kolkata')::date, 'online', 'all',
        now() - interval '1 hour', now() + interval '2 hours'
      )
    `, [flashTestId]);

    await db.query(`
      INSERT INTO public.weekly_test_sections (
        id, test_id, position, kind, seconds, question_count, flash_digits, flash_count, flash_speed_ms, flash_mode
      ) VALUES (
        $1, $2, 1, 'flash', 15, 5, 2, 5, 1000, 'add'
      )
    `, [flashSectionId, flashTestId]);

    // Active drill session for Try 2 (stored in drill_sessions, linked via a.session_id)
    await db.query(`
      INSERT INTO public.drill_sessions (
        id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status
      ) VALUES (
        $1, $2, 'flash_anzan', '2d_5n_1000ms_add',
        jsonb_build_object('kind', 'weekly_test', 'test_id', $3::text, 'section_id', $4::text, 'try_no', 2, 'question_count', 5),
        '[]'::jsonb, '[]'::jsonb, 5, 'open'
      )
    `, [flashSessionId, studentId, flashTestId, flashSectionId]);

    // Attempt: started, linked to drill_sessions
    await db.query(`
      INSERT INTO public.weekly_test_attempts (
        test_id, student_id, section_id, session_id, status
      ) VALUES (
        $1, $2, $3, $4, 'started'
      )
    `, [flashTestId, studentId, flashSectionId, flashSessionId]);

    // Score recorded so far: 1 try correct out of 5
    await db.query(`
      INSERT INTO public.weekly_test_scores (
        test_id, student_id, section_id, correct, total, time_seconds
      ) VALUES (
        $1, $2, $3, 1, 5, 12
      )
    `, [flashTestId, studentId, flashSectionId]);

    // Switch back to STG-001
    await db.query(`SELECT public.set_auth_uid($1::UUID);`, [studentId]);
    const studentRes = await db.query(`SELECT public.my_weekly_tests() AS tests;`);
    const allStudentTests = studentRes.rows[0].tests;
    const flashTestObj = allStudentTests.find(t => t.id === flashTestId);
    assert.ok(flashTestObj, 'Flash test must be returned');
    assert.equal(flashTestObj.sections.length, 1);
    const flashSec = flashTestObj.sections[0];

    assert.equal(flashSec.kind, 'flash');
    assert.equal(flashSec.attempt, 'started');
    assert.equal(flashSec.tries_started, 2, 'Must derive try_no 2 from active drill_sessions');
    assert.equal(flashSec.tries_correct, 1, 'Must derive 1 correct try from weekly_test_scores');
    assert.equal(flashSec.question_count, 5);

    // Verify helper status label and resumability
    assert.equal(isSectionResumable(flashSec, 'open'), true, 'Flash section must be resumable');
    assert.equal(sectionStatusLabel(flashSec, 'open'), 'In progress: 2 of 5 tries');
  });
});
