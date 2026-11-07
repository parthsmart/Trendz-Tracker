/**
 * Trendz Tracker — Phase 19 Response Contracts, Expiry Timing & Launch Verification
 * File: tests/phase19_response_contracts_and_launch.test.js
 *
 * Verifies:
 * 1. Assigned-duration response contracts for Basics, Elements, and Memoriad:
 *    - Authoritative frozen session settings returned for 10s, 60s, and 130s assigned rounds
 *    - Eliminates 60s/module-default leaks in start responses
 * 2. Expiry / auto-finish saves cleanly within server deadlines:
 *    - 10s, 60s, and 130s rounds save without session-expired errors
 * 3. Flash Trainer initialization:
 *    - resolveHistoryTargetStudent and renderTargetStudentBanner properly imported and functional
 * 4. Memoriad assigned launch:
 *    - Bypasses editable setup when launched from todo_task_id link
 *    - Preserves free-practice editable setup
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import drillHandler from '../api/drill.js';
import memoriadHandler from '../api/memoriad.js';
import { buildDrillStartResponse, DRILLS } from '../api/_drills.js';
import { buildMemoriadStartResponse, getMemoriadTimeLimit } from '../api/_memoriad.js';
import { resolveHistoryTargetStudent, renderTargetStudentBanner } from '../js/historyFilters.js';
import { deriveMemoriadSaveBanner } from '../js/memoriadPlay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function createMockReq({ method = 'POST', body = {}, student, adminSupabase }) {
  return {
    method,
    body,
    _testStudent: student,
    _testAdminSupabase: adminSupabase,
    headers: {},
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

function createMockAdminClient() {
  const store = {
    drill_sessions: new Map(),
    activity_results: new Map(),
    results: new Map(),
    daily_tasks: new Map(),
    daily_task_recipients: new Set(),
    categories: new Map(),
    basics_thresholds: new Map(),
    profiles: new Map(),
  };

  function from(table) {
    let countExact = false;
    const filters = [];
    let isSingle = false;
    let isMaybeSingle = false;

    async function runSelect() {
      if (table === 'daily_task_recipients') {
        let match = null;
        for (const key of store.daily_task_recipients) {
          const [tId, sId] = key.split(':');
          const candidate = { task_id: tId, student_id: sId };
          if (filters.every((fn) => fn(candidate))) {
            match = candidate;
            break;
          }
        }
        return { data: match, error: null };
      }
      const map = store[table];
      const allRows = map ? Array.from(map.values()) : [];
      const matching = allRows.filter((r) => filters.every((fn) => fn(r)));
      if (countExact) {
        return { count: matching.length, data: null, error: null };
      }
      if (isSingle) {
        if (matching.length === 0) return { data: null, error: new Error('Row not found') };
        return { data: matching[0], error: null };
      }
      if (isMaybeSingle) {
        return { data: matching[0] || null, error: null };
      }
      return { data: matching, error: null };
    }

    const selectBuilder = {
      select(_cols = '*', options = {}) {
        if (options?.count === 'exact') countExact = true;
        return selectBuilder;
      },
      eq(col, val) {
        filters.push((row) => row[col] === val);
        return selectBuilder;
      },
      gte(col, val) {
        filters.push((row) => {
          const rowVal = row[col];
          if (typeof rowVal === 'string' && typeof val === 'string') {
            return new Date(rowVal).getTime() >= new Date(val).getTime();
          }
          return rowVal >= val;
        });
        return selectBuilder;
      },
      single() {
        isSingle = true;
        return runSelect();
      },
      maybeSingle() {
        isMaybeSingle = true;
        return runSelect();
      },
      then(resolve, reject) {
        return runSelect().then(resolve, reject);
      },
    };

    return {
      select: selectBuilder.select,
      insert(rows) {
        const toInsert = Array.isArray(rows) ? rows : [rows];
        const inserted = toInsert.map((r) => {
          const id = r.id || `row-${Math.random().toString(36).slice(2, 9)}`;
          const full = { ...r, id, created_at: r.created_at || new Date().toISOString() };
          store[table].set(id, full);
          return full;
        });
        return {
          select() {
            return {
              single() {
                return Promise.resolve({ data: inserted[0], error: null });
              },
            };
          },
        };
      },
      update(values) {
        const updateFilters = [];
        async function runUpdate() {
          const map = store[table];
          const updated = [];
          if (map) {
            for (const [id, row] of map.entries()) {
              if (updateFilters.every((fn) => fn(row))) {
                const next = { ...row, ...values };
                map.set(id, next);
                updated.push(next);
              }
            }
          }
          return { data: updated, error: null };
        }
        const updateBuilder = {
          eq(col, val) {
            updateFilters.push((r) => r[col] === val);
            return updateBuilder;
          },
          select(_cols = '*') {
            return updateBuilder;
          },
          single() {
            return runUpdate().then((res) => ({ data: res.data ? res.data[0] || null : null, error: res.error }));
          },
          maybeSingle() {
            return runUpdate().then((res) => ({ data: res.data ? res.data[0] || null : null, error: res.error }));
          },
          then(resolve, reject) {
            return runUpdate().then(resolve, reject);
          },
        };
        return updateBuilder;
      },
    };
  }

  return { store, from };
}

describe('Phase 19 — Response Contracts, Expiry Timing & Launch Verification', () => {
  it('1. buildDrillStartResponse returns authoritative frozen duration (10s, 60s, 130s)', () => {
    const drill = DRILLS.day_codes;

    // Test 10s assigned duration
    const res10 = buildDrillStartResponse({
      sessionId: 'sess-10',
      drillKey: 'day_codes',
      drill,
      generated: [{ text: 'Sunday' }],
      timeLimitSeconds: 10,
      settings: { duration_seconds: 10, prep_seconds: 3 },
    });
    assert.equal(res10.time_limit_seconds, 10, 'Expected 10s time_limit_seconds');
    assert.equal(res10.duration_seconds, 10, 'Expected 10s duration_seconds');
    assert.equal(res10.prep_seconds, 3, 'Expected 3s prep_seconds');
    assert.equal(res10.settings.duration_seconds, 10);

    // Test 60s assigned duration
    const res60 = buildDrillStartResponse({
      sessionId: 'sess-60',
      drillKey: 'day_codes',
      drill,
      generated: [{ text: 'Sunday' }],
      timeLimitSeconds: 60,
      settings: { duration_seconds: 60, prep_seconds: 3 },
    });
    assert.equal(res60.time_limit_seconds, 60);
    assert.equal(res60.duration_seconds, 60);

    // Test 130s assigned duration
    const res130 = buildDrillStartResponse({
      sessionId: 'sess-130',
      drillKey: 'day_codes',
      drill,
      generated: [{ text: 'Sunday' }],
      timeLimitSeconds: 130,
      settings: { duration_seconds: 130, prep_seconds: 3 },
    });
    assert.equal(res130.time_limit_seconds, 130);
    assert.equal(res130.duration_seconds, 130);
  });

  it('2. buildMemoriadStartResponse returns authoritative frozen duration (10s, 60s, 130s)', () => {
    // Test 10s assigned duration
    const res10 = buildMemoriadStartResponse({
      session_id: 'sess-mem-10',
      module: 'calendar',
      questions: [[2000, 1, 1]],
      time_limit_seconds: 10,
      duration_seconds: 10,
      settings: { duration_seconds: 10, concentration_seconds: 5 },
    });
    assert.equal(res10.time_limit_seconds, 10);
    assert.equal(res10.duration_seconds, 10);
    assert.equal(res10.concentration_seconds, 5);
    assert.equal(res10.prep_seconds, 5);
    assert.equal(res10.settings.duration_seconds, 10);

    // Test 60s assigned duration
    const res60 = buildMemoriadStartResponse({
      session_id: 'sess-mem-60',
      module: 'calendar',
      questions: [[2000, 1, 1]],
      time_limit_seconds: 60,
      duration_seconds: 60,
      settings: { duration_seconds: 60, concentration_seconds: 5 },
    });
    assert.equal(res60.time_limit_seconds, 60);
    assert.equal(res60.duration_seconds, 60);

    // Test 130s assigned duration
    const res130 = buildMemoriadStartResponse({
      session_id: 'sess-mem-130',
      module: 'calendar',
      questions: [[2000, 1, 1]],
      time_limit_seconds: 130,
      duration_seconds: 130,
      settings: { duration_seconds: 130, concentration_seconds: 5 },
    });
    assert.equal(res130.time_limit_seconds, 130);
    assert.equal(res130.duration_seconds, 130);
  });

  it('3. Real HTTP endpoints: Basics, Elements, and Memoriad start contracts for assigned 10s, 60s, 130s tasks', async () => {
    const adminClient = createMockAdminClient();
    const student = { id: 'student-bob', active: true };
    adminClient.store.profiles.set(student.id, student);

    const basicsCat = { id: 'cat-basics-1', name: '1d4r', section: 'basics', active: true };
    adminClient.store.categories.set(basicsCat.id, basicsCat);

    const durations = [10, 60, 130];

    for (const duration of durations) {
      // 3a. Elements
      const elemTaskId = crypto.randomUUID();
      adminClient.store.daily_tasks.set(elemTaskId, {
        id: elemTaskId,
        title: `Elements ${duration}s`,
        section: 'elements',
        activity_key: 'day_codes',
        duration_seconds: duration,
        required_count: 1,
        active: true,
      });
      adminClient.store.daily_task_recipients.add(`${elemTaskId}:${student.id}`);

      const elemRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: { action: 'start', drill: 'day_codes', todo_task_id: elemTaskId },
          student,
          adminSupabase: adminClient,
        }),
        elemRes
      );
      assert.equal(elemRes.statusCode, 200);
      assert.equal(elemRes.body.time_limit_seconds, duration, `Elements ${duration}s returned incorrect time_limit_seconds`);
      assert.equal(elemRes.body.duration_seconds, duration, `Elements ${duration}s returned incorrect duration_seconds`);
      assert.equal(elemRes.body.prep_seconds, 3);
      assert.equal(elemRes.body.settings.duration_seconds, duration);

      // Verify server session expiry in DB: prep (3s) + duration + 30s grace
      const elemSession = adminClient.store.drill_sessions.get(elemRes.body.session_id);
      assert.ok(elemSession);
      assert.equal(elemSession.settings.duration_seconds, duration);
      const elemSessionDuration = Math.round(
        (new Date(elemSession.expires_at).getTime() - new Date(elemSession.started_at).getTime()) / 1000
      );
      assert.equal(elemSessionDuration, 3 + duration + 30, 'Elements server deadline matches 3s prep + duration + 30s');

      // 3b. Basics
      const basicsTaskId = crypto.randomUUID();
      adminClient.store.daily_tasks.set(basicsTaskId, {
        id: basicsTaskId,
        title: `Basics ${duration}s`,
        section: 'basics',
        category_id: basicsCat.id,
        duration_seconds: duration,
        required_count: 1,
        active: true,
      });
      adminClient.store.daily_task_recipients.add(`${basicsTaskId}:${student.id}`);

      const basicsRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: basicsCat.id,
            mode: 'timed',
            seconds: 60, // Client requested default 60s, task must override to frozen duration!
            todo_task_id: basicsTaskId,
          },
          student,
          adminSupabase: adminClient,
        }),
        basicsRes
      );
      assert.equal(basicsRes.statusCode, 200);
      assert.equal(basicsRes.body.seconds, duration, `Basics ${duration}s returned incorrect seconds`);
      assert.equal(basicsRes.body.duration_seconds, duration, `Basics ${duration}s returned incorrect duration_seconds`);
      assert.equal(basicsRes.body.time_limit_seconds, duration);
      assert.equal(basicsRes.body.prep_seconds, 3);
      assert.equal(basicsRes.body.settings.duration_seconds, duration);

      const basicsSession = adminClient.store.drill_sessions.get(basicsRes.body.session_id);
      assert.ok(basicsSession);
      assert.equal(basicsSession.settings.duration_seconds, duration);
      const basicsSessionDuration = Math.round(
        (new Date(basicsSession.expires_at).getTime() - new Date(basicsSession.started_at).getTime()) / 1000
      );
      assert.equal(basicsSessionDuration, 3 + duration + 15, 'Basics server deadline matches 3s prep + duration + 15s');

      // 3c. Memoriad
      const memTaskId = crypto.randomUUID();
      adminClient.store.daily_tasks.set(memTaskId, {
        id: memTaskId,
        title: `Memoriad ${duration}s`,
        section: 'memoriad',
        activity_key: 'calendar',
        duration_seconds: duration,
        required_count: 1,
        active: true,
      });
      adminClient.store.daily_task_recipients.add(`${memTaskId}:${student.id}`);

      const memRes = createMockRes();
      await memoriadHandler(
        createMockReq({
          body: { action: 'start', module: 'calendar', todo_task_id: memTaskId },
          student,
          adminSupabase: adminClient,
        }),
        memRes
      );
      assert.equal(memRes.statusCode, 200);
      assert.equal(memRes.body.time_limit_seconds, duration, `Memoriad ${duration}s returned incorrect time_limit_seconds`);
      assert.equal(memRes.body.duration_seconds, duration);
      assert.equal(memRes.body.concentration_seconds, 5);
      assert.equal(memRes.body.settings.duration_seconds, duration);

      const memSession = adminClient.store.drill_sessions.get(memRes.body.session_id);
      assert.ok(memSession);
      assert.equal(memSession.settings.duration_seconds, duration);
      const memSessionDuration = Math.round(
        (new Date(memSession.expires_at).getTime() - new Date(memSession.started_at).getTime()) / 1000
      );
      assert.equal(memSessionDuration, 5 + duration + 30, 'Memoriad server deadline matches 5s conc + duration + 30s');
    }
  });

  it('4. Expiry saves cleanly: 10s, 60s, and 130s rounds save without session-expired error', async () => {
    const adminClient = createMockAdminClient();
    const student = { id: 'student-charlie', active: true };
    adminClient.store.profiles.set(student.id, student);

    for (const duration of [10, 60, 130]) {
      // Setup Elements task
      const taskId = crypto.randomUUID();
      adminClient.store.daily_tasks.set(taskId, {
        id: taskId,
        title: `Elements ${duration}s Task`,
        section: 'elements',
        activity_key: 'day_codes',
        duration_seconds: duration,
        required_count: 1,
        active: true,
      });
      adminClient.store.daily_task_recipients.add(`${taskId}:${student.id}`);

      // Start session
      const startRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: { action: 'start', drill: 'day_codes', todo_task_id: taskId },
          student,
          adminSupabase: adminClient,
        }),
        startRes
      );
      assert.equal(startRes.statusCode, 200);
      const sessionId = startRes.body.session_id;

      // Simulate client timer expiring after exactly `duration` seconds
      // Time-up auto submit: client sends answered questions with duration_seconds = duration
      const sessionRow = adminClient.store.drill_sessions.get(sessionId);
      // Simulate that the session started (3s prep + duration + 1s transit) ago
      sessionRow.started_at = new Date(Date.now() - (3 + duration + 1) * 1000).toISOString();
      sessionRow.expires_at = new Date(Date.now() + 25 * 1000).toISOString();

      const answers = new Array(sessionRow.questions.length).fill('');
      answers[0] = '0';
      answers[1] = '6';

      const submitRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'submit',
            session_id: sessionId,
            answers,
            duration_seconds: duration,
          },
          student,
          adminSupabase: adminClient,
        }),
        submitRes
      );

      assert.equal(submitRes.statusCode, 200, `Elements ${duration}s must save cleanly (not 410 or expired error)`);
      assert.equal(submitRes.body.seconds, duration);

      // Verify the session is submitted, not expired
      const updatedSession = adminClient.store.drill_sessions.get(sessionId);
      assert.equal(updatedSession.status, 'submitted');
      assert.ok(adminClient.store.activity_results.size > 0);
    }
  });

  it('5. Flash Trainer initialization: imports resolveHistoryTargetStudent and declares activeHistoryStudent', () => {
    // Verify that the imports exist and are functions
    assert.equal(typeof resolveHistoryTargetStudent, 'function');
    assert.equal(typeof renderTargetStudentBanner, 'function');

    // Verify that js/flash.js imports both from historyFilters.js
    const flashJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'flash.js'), 'utf-8');
    assert.ok(flashJs.includes('resolveHistoryTargetStudent'), 'js/flash.js must import resolveHistoryTargetStudent');
    assert.ok(flashJs.includes('renderTargetStudentBanner'), 'js/flash.js must import renderTargetStudentBanner');
    assert.ok(flashJs.includes('let activeHistoryStudent = null;'), 'js/flash.js must declare activeHistoryStudent at module level');
  });

  it('6. Memoriad assigned launch: startAssignedMemoriadPractice directly launches assigned practice', () => {
    const memoriadPlayJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'memoriadPlay.js'), 'utf-8');

    // Verify startAssignedMemoriadPractice is defined
    assert.ok(memoriadPlayJs.includes('async function startAssignedMemoriadPractice('), 'startAssignedMemoriadPractice must be defined');

    // Verify initMemoriadPlayPage branches on activeTodoTaskId
    assert.ok(
      memoriadPlayJs.includes('if (activeTodoTaskId) {\n    startAssignedMemoriadPractice();\n  } else {\n    renderSettingsView();\n  }'),
      'initMemoriadPlayPage must bypass renderSettingsView for assigned tasks'
    );

    // Verify renderSettingsView also guards against activeTodoTaskId
    assert.ok(
      memoriadPlayJs.includes('if (activeTodoTaskId) {\n    startAssignedMemoriadPractice();\n    return;\n  }'),
      'renderSettingsView must redirect to startAssignedMemoriadPractice if activeTodoTaskId is set'
    );

    // Verify locked badge in stage shell
    assert.ok(
      memoriadPlayJs.includes('Daily Task (${limitSeconds}s locked)'),
      'Stage shells must display accurate assigned duration and locked status'
    );
  });

  it('7. Code inspection & helper assertions (not staging browser tests): admin links, weekly test completion, competition series', async () => {
    // 1. Admin student detail links source verification
    const studentDetailJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'studentDetail.js'), 'utf-8');
    assert.ok(studentDetailJs.includes('/pages/basics.html?student_id=${studentParam}'));
    assert.ok(studentDetailJs.includes('/pages/flash.html?student_id=${studentParam}'));
    assert.ok(studentDetailJs.includes('/pages/elements.html?student_id=${studentParam}'));
    assert.ok(studentDetailJs.includes('/pages/memoriad.html?student_id=${studentParam}'));

    // 2. Weekly test completion status pure helper
    const { getWeeklyTestCompletionState } = await import('../js/weeklyTestView.js');
    const mockCompletedOnlineTest = {
      type: 'online',
      state: 'open',
      sections: [
        { section_id: 's1', attempt: 'submitted', correct: 10, total: 10 },
        { section_id: 's2', attempt: 'submitted', correct: 8, total: 10 },
      ],
    };
    const compState = getWeeklyTestCompletionState(mockCompletedOnlineTest);
    assert.equal(compState.isCompleted, true);
    assert.equal(compState.state, 'completed');
    assert.equal(compState.label, 'Completed');

    // 3. Rounds series filtering source verification
    const roundsJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'rounds.js'), 'utf-8');
    assert.ok(roundsJs.includes("from('round_series')") || roundsJs.includes('DemoDB.getRoundSeries()'));
    assert.ok(roundsJs.includes('select-series-filter'));
  });

  it('8. Memoriad assigned navigation uses existing /pages/student.html, preserving free practice', () => {
    const memoriadPlayJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'memoriadPlay.js'), 'utf-8');

    // 1. Must NOT link to non-existent student-today.html
    assert.equal(
      memoriadPlayJs.includes('student-today.html'),
      false,
      'js/memoriadPlay.js must not reference non-existent /pages/student-today.html'
    );

    // 2. Error screen: Back to Daily Tasks links to /pages/student.html
    assert.ok(
      memoriadPlayJs.includes('<a href="/pages/student.html" class="btn btn-outline" style="text-decoration: none;">Back to Daily Tasks</a>'),
      'Assigned start error screen must link to /pages/student.html'
    );

    // 2b. Submission error overlay and unsupported module back target
    assert.ok(
      memoriadPlayJs.includes("activeTodoTaskId ? '/pages/student.html' : '/pages/memoriad.html'"),
      'Submission error and unsupported module must resolve /pages/student.html for assigned tasks and /pages/memoriad.html for free practice'
    );
    assert.ok(
      memoriadPlayJs.includes("activeTodoTaskId ? 'Back to Daily Tasks' : 'Back to Memoriad'"),
      'Back label must resolve "Back to Daily Tasks" for assigned tasks and "Back to Memoriad" for free practice'
    );

    // 3. Exit modal: assigned practice exits to /pages/student.html
    assert.ok(
      memoriadPlayJs.includes("if (activeTodoTaskId) {\n          window.location.href = '/pages/student.html';\n          return;\n        }"),
      'Assigned exit modal must navigate to /pages/student.html'
    );

    // 4. Results view: assigned practice links to /pages/student.html
    assert.ok(
      memoriadPlayJs.includes('<a href="/pages/student.html" class="btn btn-outline" style="text-decoration: none;">\n                      Back to Daily Tasks\n                    </a>'),
      'Assigned results view must link to /pages/student.html'
    );

    // 5. Ordinary free-practice navigation remains unchanged
    assert.ok(
      memoriadPlayJs.includes('renderSettingsView();'),
      'Ordinary exit must return to settings view'
    );
    assert.ok(
      memoriadPlayJs.includes('<a href="/pages/memoriad.html" class="btn btn-outline" style="text-decoration: none;">\n                      Back to Memoriad\n                    </a>'),
      'Free practice results view must link to /pages/memoriad.html'
    );
  });

  it('9. Navigation targets verification: all referenced pages exist on disk', () => {
    const pagesDir = path.join(ROOT_DIR, 'pages');

    const expectedTargets = [
      'student.html',
      'memoriad.html',
      'memoriad-play.html',
      'basics.html',
      'basics-practice.html',
      'flash.html',
      'elements.html',
      'element-drill.html',
      'weekly-test.html',
      'rounds.html',
      'round-scores.html',
      'student-detail.html',
    ];

    for (const target of expectedTargets) {
      assert.ok(
        fs.existsSync(path.join(pagesDir, target)),
        `Target page pages/${target} must exist on disk`
      );
    }

    // Explicitly verify non-existence of student-today.html
    assert.equal(
      fs.existsSync(path.join(pagesDir, 'student-today.html')),
      false,
      'pages/student-today.html must not exist'
    );
  });

  it('10. Memoriad empty-expiry result message: derives banner from server response (saved empty assigned vs unsaved vs normal)', async () => {
    // 1. Verify server response contract on empty assigned expiry
    const adminClient = createMockAdminClient();
    const student = { id: 'student-empty-expiry', active: true };
    adminClient.store.profiles.set(student.id, student);

    const memTaskId = crypto.randomUUID();
    adminClient.store.daily_tasks.set(memTaskId, {
      id: memTaskId,
      title: 'Memoriad 10s Empty Expiry Task',
      section: 'memoriad',
      activity_key: 'calendar',
      duration_seconds: 10,
      required_count: 1,
      active: true,
    });
    adminClient.store.daily_task_recipients.add(`${memTaskId}:${student.id}`);

    // Start session
    const startRes = createMockRes();
    await memoriadHandler(
      createMockReq({
        body: { action: 'start', module: 'calendar', todo_task_id: memTaskId },
        student,
        adminSupabase: adminClient,
      }),
      startRes
    );
    assert.equal(startRes.statusCode, 200);
    const sessionId = startRes.body.session_id;

    // Simulate time up expiry with NO answers attempted
    const sessionRow = adminClient.store.drill_sessions.get(sessionId);
    sessionRow.started_at = new Date(Date.now() - (5 + 10 + 1) * 1000).toISOString();
    sessionRow.expires_at = new Date(Date.now() + 25 * 1000).toISOString();

    const emptyAnswers = new Array(sessionRow.questions.length).fill(null);
    const submitRes = createMockRes();
    await memoriadHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: sessionId,
          answers: emptyAnswers,
          used_seconds: 10,
          finished_by: 'time_up',
        },
        student,
        adminSupabase: adminClient,
      }),
      submitRes
    );

    assert.equal(submitRes.statusCode, 200);
    assert.equal(submitRes.body.saved, true, 'Empty assigned expiry must be saved');
    assert.equal(submitRes.body.empty_expiry, true, 'Empty assigned expiry must have empty_expiry flag');
    assert.equal(submitRes.body.total, 0);
    assert.equal(
      submitRes.body.message,
      'Attempt saved. No questions were answered, so this round earned no Daily To-do credit.',
      'Server response message must match Phase 19 empty-expiry requirement'
    );

    // 2. Client helper deriveMemoriadSaveBanner tests
    // 2a. Direct server empty-expiry response
    const bannerFromResponse = deriveMemoriadSaveBanner(submitRes.body);
    assert.equal(
      bannerFromResponse.text,
      'Attempt saved. No questions were answered, so this round earned no Daily To-do credit.'
    );
    assert.equal(bannerFromResponse.bannerClass, 'banner-info');
    assert.equal(bannerFromResponse.saved, true);
    assert.equal(bannerFromResponse.emptyExpiry, true);

    // 2b. Saved empty expiry with total = 0, attempted = 0 (even without explicit empty_expiry flag)
    const bannerSavedZero = deriveMemoriadSaveBanner({
      saved: true,
      attempted: 0,
      total: 0,
      message: 'Attempt saved. No questions were answered, so this round earned no Daily To-do credit.',
    });
    assert.equal(
      bannerSavedZero.text,
      'Attempt saved. No questions were answered, so this round earned no Daily To-do credit.'
    );
    assert.equal(bannerSavedZero.bannerClass, 'banner-info');
    assert.equal(bannerSavedZero.saved, true);
    assert.equal(bannerSavedZero.emptyExpiry, true);

    // 2c. Actually unsaved attempt with 0 attempts (free practice abandoned without answers)
    const bannerUnsavedZero = deriveMemoriadSaveBanner({
      saved: false,
      attempted: 0,
      total: 0,
      message: 'No questions were attempted, so no score was saved.',
    });
    assert.equal(bannerUnsavedZero.text, 'No questions were attempted, so no score was saved.');
    assert.equal(bannerUnsavedZero.bannerClass, 'banner-demo');
    assert.equal(bannerUnsavedZero.saved, false);
    assert.equal(bannerUnsavedZero.emptyExpiry, false);

    // 2d. Actually unsaved attempt with fallback message
    const bannerUnsavedNoMsg = deriveMemoriadSaveBanner({
      saved: false,
      attempted: 0,
    });
    assert.equal(bannerUnsavedNoMsg.text, 'No questions were attempted, so no score was saved.');
    assert.equal(bannerUnsavedNoMsg.bannerClass, 'banner-demo');
    assert.equal(bannerUnsavedNoMsg.saved, false);

    // 2e. Null / undefined response safety
    const bannerNull = deriveMemoriadSaveBanner(null);
    assert.equal(bannerNull.text, 'No questions were attempted, so no score was saved.');
    assert.equal(bannerNull.bannerClass, 'banner-demo');
    assert.equal(bannerNull.saved, false);

    // 2f. Normal saved attempt
    const bannerNormalSaved = deriveMemoriadSaveBanner({
      saved: true,
      attempted: 20,
      total: 20,
      correct: 18,
    });
    assert.equal(bannerNormalSaved.text, 'Saved to your scores.');
    assert.equal(bannerNormalSaved.bannerClass, 'banner-success');
    assert.equal(bannerNormalSaved.saved, true);
    assert.equal(bannerNormalSaved.emptyExpiry, false);

    // 2g. Weekly test saved attempt
    const bannerWeeklySaved = deriveMemoriadSaveBanner(
      {
        saved: true,
        attempted: 15,
        total: 15,
        correct: 14,
        test_title: 'Week 2 Assessment',
      },
      { isTestMode: true, activeTestTitle: 'Week 2 Assessment' }
    );
    assert.equal(bannerWeeklySaved.text, 'Saved as part of Week 2 Assessment');
    assert.equal(bannerWeeklySaved.bannerClass, 'banner-success');
    assert.equal(bannerWeeklySaved.saved, true);

    // 3. Focused rendering verification: banner DOM/HTML output
    function renderBannerHtml(res, options = {}) {
      const bannerInfo = deriveMemoriadSaveBanner(res, options);
      const icon = res?.saved ? (bannerInfo.emptyExpiry ? 'ℹ️' : '✅') : 'ℹ️';
      return `
        <div class="banner ${bannerInfo.bannerClass}" style="margin-bottom: var(--space-4);">
          <span class="banner-icon" aria-hidden="true">${icon}</span>
          <div class="banner-body">
            <strong>${bannerInfo.text}</strong>
          </div>
        </div>
      `.trim();
    }

    // 3a. Rendered empty expiry HTML
    const emptyExpiryHtml = renderBannerHtml(submitRes.body);
    assert.ok(emptyExpiryHtml.includes('class="banner banner-info"'));
    assert.ok(emptyExpiryHtml.includes('ℹ️'));
    assert.ok(
      emptyExpiryHtml.includes(
        '<strong>Attempt saved. No questions were answered, so this round earned no Daily To-do credit.</strong>'
      )
    );
    assert.equal(
      emptyExpiryHtml.includes('No questions were attempted, so no score was saved.'),
      false,
      'Rendered empty expiry banner must NOT say no score was saved'
    );

    // 3b. Rendered unsaved attempt HTML
    const unsavedHtml = renderBannerHtml({
      saved: false,
      attempted: 0,
      message: 'No questions were attempted, so no score was saved.',
    });
    assert.ok(unsavedHtml.includes('class="banner banner-demo"'));
    assert.ok(unsavedHtml.includes('ℹ️'));
    assert.ok(unsavedHtml.includes('<strong>No questions were attempted, so no score was saved.</strong>'));

    // 3c. Rendered normal saved attempt HTML
    const normalHtml = renderBannerHtml({
      saved: true,
      attempted: 25,
      correct: 24,
    });
    assert.ok(normalHtml.includes('class="banner banner-success"'));
    assert.ok(normalHtml.includes('✅'));
    assert.ok(normalHtml.includes('<strong>Saved to your scores.</strong>'));
  });
});
