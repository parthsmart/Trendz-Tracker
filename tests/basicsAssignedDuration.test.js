import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import drillHandler from '../api/drill.js';
import {
  computeBasicsPoolForDuration,
  resolveBasicsModeSpec,
  BASICS_TIMED_POOLS,
  BASICS_UNLIMITED_POOL,
} from '../api/_drills.js';

// Helper to create mock HTTP req/res
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

// In-memory Supabase mock client tailored for /api/drill tests
function createInMemorySupabase() {
  const store = {
    drill_sessions: new Map(),
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
      select(cols = '*', options = {}) {
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
      insert(payload) {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const item of rows) {
          const row = {
            id: item.id || crypto.randomUUID(),
            created_at: item.created_at || new Date().toISOString(),
            ...item,
          };
          if (store[table]) {
            store[table].set(row.id, row);
          }
          inserted.push(row);
        }
        return {
          select(cols = '*') {
            return {
              single() {
                return Promise.resolve({ data: inserted[0], error: null });
              },
              maybeSingle() {
                return Promise.resolve({ data: inserted[0] || null, error: null });
              },
              then(resolve, reject) {
                return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
              },
            };
          },
          then(resolve, reject) {
            return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
          },
        };
      },
      update(updates) {
        const updateFilters = [];
        const updateBuilder = {
          eq(col, val) {
            updateFilters.push((row) => row[col] === val);
            return updateBuilder;
          },
          select(cols = '*') {
            return {
              then(resolve, reject) {
                const map = store[table];
                if (!map) return Promise.resolve({ data: [], error: null }).then(resolve, reject);
                const updated = [];
                for (const [id, row] of map.entries()) {
                  if (updateFilters.every((fn) => fn(row))) {
                    const newRow = { ...row, ...updates };
                    map.set(id, newRow);
                    updated.push(newRow);
                  }
                }
                return Promise.resolve({ data: updated, error: null }).then(resolve, reject);
              },
            };
          },
          then(resolve, reject) {
            const map = store[table];
            if (!map) return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            for (const [id, row] of map.entries()) {
              if (updateFilters.every((fn) => fn(row))) {
                map.set(id, { ...row, ...updates });
              }
            }
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
        return updateBuilder;
      },
      delete() {
        const deleteFilters = [];
        const deleteBuilder = {
          eq(col, val) {
            deleteFilters.push((row) => row[col] === val);
            return deleteBuilder;
          },
          then(resolve, reject) {
            const map = store[table];
            if (map) {
              for (const [id, row] of map.entries()) {
                if (deleteFilters.every((fn) => fn(row))) {
                  map.delete(id);
                }
              }
            }
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
        return deleteBuilder;
      },
    };
    return selectBuilder;
  }

  return {
    from,
    rpc(fnName, args) {
      if (fnName === 'today_ist') {
        const now = new Date();
        const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
        return Promise.resolve({ data: ist.toISOString().slice(0, 10), error: null });
      }
      if (fnName === 'get_student_effective_access') {
        return Promise.resolve({
          data: {
            ok: true,
            student_id: args?.p_student_id,
            scope: 'default',
            source_label: 'Default (Full access)',
            settings: {
              basics: { all: true, categories: [] },
              elements: { all: true, drills: [] },
              flash: { allowed: true },
              memoriad: { all: true, modules: [], calendar_variants: [25, 50, 75, 100, 125] },
              main_round: { all: true, categories: [] },
            },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    store,
  };
}

describe('Basics Assigned Practice Duration & Authorization Tests', () => {
  describe('1. computeBasicsPoolForDuration pure helper', () => {
    it('returns exact presets for 30s, 60s, 120s, and 300s', () => {
      assert.equal(computeBasicsPoolForDuration(30), 50);
      assert.equal(computeBasicsPoolForDuration(60), 100);
      assert.equal(computeBasicsPoolForDuration(120), 200);
      assert.equal(computeBasicsPoolForDuration(300), 500);
    });

    it('derives scaled pools for arbitrary durations 5..3600s', () => {
      // 10s: max(20, ceil(10 * 5/3 = 17)) = 20 questions
      assert.equal(computeBasicsPoolForDuration(10), 20);

      // 130s: ceil(130 * 5/3 = 216.67) = 217 questions
      assert.equal(computeBasicsPoolForDuration(130), 217);

      // 5s (min admin): max(20, ceil(5 * 5/3 = 9)) = 20 questions
      assert.equal(computeBasicsPoolForDuration(5), 20);

      // 3600s (max admin): min(1000, ceil(3600 * 5/3 = 6000)) = 1000
      assert.equal(computeBasicsPoolForDuration(3600), BASICS_UNLIMITED_POOL);
    });

    it('handles fallback safely for invalid or non-positive duration', () => {
      assert.equal(computeBasicsPoolForDuration(0), 20);
      assert.equal(computeBasicsPoolForDuration(-10), 20);
      assert.equal(computeBasicsPoolForDuration(null), 20);
      assert.equal(computeBasicsPoolForDuration('abc'), 20);
    });
  });

  describe('2. Authoritative Daily Task Duration Enforcement via /api/drill', () => {
    const studentAlice = { id: crypto.randomUUID(), level: 'Level 1' };
    const studentBob = { id: crypto.randomUUID(), level: 'Level 1' };
    const cat1Id = crypto.randomUUID();

    function setupFixtures(supabase) {
      // Insert category
      supabase.store.categories.set(cat1Id, {
        id: cat1Id,
        name: '1D 3R',
        section: 'basics',
        active: true,
      });

      // Insert profiles
      supabase.store.profiles.set(studentAlice.id, {
        id: studentAlice.id,
        level: studentAlice.level,
        active: true,
      });
      supabase.store.profiles.set(studentBob.id, {
        id: studentBob.id,
        level: studentBob.level,
        active: true,
      });
    }

    it('starts valid 10-second assigned task with locked duration, pool=20, and earns todo credit at deadline', async () => {
      const supabase = createInMemorySupabase();
      setupFixtures(supabase);

      const taskId10s = crypto.randomUUID();
      supabase.store.daily_tasks.set(taskId10s, {
        id: taskId10s,
        title: 'QA Phase19 Basics 10s',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 10,
        required_count: 1,
        target_scope: 'all',
        active: true,
      });

      // Student starts the session
      const startRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 10,
            todo_task_id: taskId10s,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        startRes
      );

      assert.equal(startRes.statusCode, 200);
      assert.equal(startRes.body.mode, 'timed');
      assert.equal(startRes.body.seconds, 10);
      assert.equal(startRes.body.duration_seconds, 10);
      assert.equal(startRes.body.time_limit_seconds, 10);
      assert.equal(startRes.body.prep_seconds, 3);
      assert.equal(startRes.body.pool, 20);
      assert.equal(startRes.body.questions.length, 20);

      // Verify session stored in DB
      const session = supabase.store.drill_sessions.get(startRes.body.session_id);
      assert.ok(session);
      assert.equal(session.settings.duration_seconds, 10);
      assert.equal(session.settings.pool, 20);
      assert.equal(session.settings.is_todo, true);
      assert.equal(session.settings.todo_task_id, taskId10s);

      // Simulate student solving for full duration: started 14 seconds ago (> 3s prep + 10s duration = 13s deadline)
      session.started_at = new Date(Date.now() - 14000).toISOString();

      const submitRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'submit',
            session_id: session.id,
            answers: ['5', '6', '7', '8', '9'],
            duration_seconds: 10,
            finished_reason: 'time_up',
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        submitRes
      );

      assert.equal(submitRes.statusCode, 200);
      assert.equal(submitRes.body.used_seconds, 10);
      assert.equal(submitRes.body.attempted, 5);

      // Verify drill_sessions settings updated with authoritative todo_credit = true
      const updatedSession = supabase.store.drill_sessions.get(session.id);
      assert.equal(updatedSession.status, 'submitted');
      assert.equal(updatedSession.settings.todo_credit, true);
      assert.equal(updatedSession.settings.completed_duration, true);
      assert.equal(updatedSession.settings.early_finish, false);
      assert.ok(updatedSession.result_row_id);
    });

    it('starts valid 130-second assigned task with locked duration and pool=217', async () => {
      const supabase = createInMemorySupabase();
      setupFixtures(supabase);

      const taskId130s = crypto.randomUUID();
      supabase.store.daily_tasks.set(taskId130s, {
        id: taskId130s,
        title: 'Basics 130s Challenge',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 130,
        required_count: 1,
        target_scope: 'all',
        active: true,
      });

      const startRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 130,
            todo_task_id: taskId130s,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        startRes
      );

      assert.equal(startRes.statusCode, 200);
      assert.equal(startRes.body.mode, 'timed');
      assert.equal(startRes.body.seconds, 130);
      assert.equal(startRes.body.duration_seconds, 130);
      assert.equal(startRes.body.pool, 217);
      assert.equal(startRes.body.questions.length, 217);
    });

    it('neutralizes duration tampering: client-supplied mode or seconds cannot override assigned task timing', async () => {
      const supabase = createInMemorySupabase();
      setupFixtures(supabase);

      const taskId10s = crypto.randomUUID();
      supabase.store.daily_tasks.set(taskId10s, {
        id: taskId10s,
        title: 'Tamper Test Task 10s',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 10,
        required_count: 1,
        target_scope: 'all',
        active: true,
      });

      // 1. Client attempts to switch to 'unlimited' mode with null seconds
      const tamperUnlimitedRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'unlimited',
            seconds: null,
            todo_task_id: taskId10s,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        tamperUnlimitedRes
      );

      assert.equal(tamperUnlimitedRes.statusCode, 200);
      assert.equal(tamperUnlimitedRes.body.mode, 'timed', 'Mode must be forced to timed');
      assert.equal(tamperUnlimitedRes.body.seconds, 10, 'Seconds must be forced to task duration 10s');
      assert.equal(tamperUnlimitedRes.body.pool, 20, 'Pool must match 10s duration');

      // 2. Client attempts to extend duration to 300 seconds
      const tamperSecondsRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 300,
            todo_task_id: taskId10s,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        tamperSecondsRes
      );

      assert.equal(tamperSecondsRes.statusCode, 200);
      assert.equal(tamperSecondsRes.body.seconds, 10, 'Client-sent seconds=300 must be overridden by task duration=10');
      assert.equal(tamperSecondsRes.body.duration_seconds, 10);
      assert.equal(tamperSecondsRes.body.pool, 20);

      // 3. Client attempts to send arbitrary invalid mode
      const tamperInvalidModeRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'sprint',
            seconds: 10,
            todo_task_id: taskId10s,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        tamperInvalidModeRes
      );

      assert.equal(tamperInvalidModeRes.statusCode, 200);
      assert.equal(tamperInvalidModeRes.body.mode, 'timed', 'Mode must be forced to timed');
      assert.equal(tamperInvalidModeRes.body.seconds, 10);
    });

    it('rejects unauthorized task assignments: targeting, level mismatch, inactive, and mismatched section/category', async () => {
      const supabase = createInMemorySupabase();
      setupFixtures(supabase);

      // Targeted task assigned ONLY to Bob
      const targetedTaskId = crypto.randomUUID();
      supabase.store.daily_tasks.set(targetedTaskId, {
        id: targetedTaskId,
        title: 'Bobs Private Task',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 10,
        target_scope: 'targeted',
        active: true,
      });
      supabase.store.daily_task_recipients.add(`${targetedTaskId}:${studentBob.id}`);

      // Alice tries to start Bob's targeted task -> 403 Forbidden
      const unassignedRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 10,
            todo_task_id: targetedTaskId,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        unassignedRes
      );

      assert.equal(unassignedRes.statusCode, 403);
      assert.match(unassignedRes.body.error, /not assigned to this daily task/i);

      // Level mismatch: task is for Level 3, student is Level 1 -> 403 Forbidden
      const levelTaskId = crypto.randomUUID();
      supabase.store.daily_tasks.set(levelTaskId, {
        id: levelTaskId,
        title: 'Level 3 Only Task',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 10,
        target_scope: 'all',
        level: 'Level 3',
        active: true,
      });

      const levelMismatchRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 10,
            todo_task_id: levelTaskId,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        levelMismatchRes
      );

      assert.equal(levelMismatchRes.statusCode, 403);
      assert.match(levelMismatchRes.body.error, /Level 3, but your profile is level Level 1/i);

      // Inactive task -> 404
      const inactiveTaskId = crypto.randomUUID();
      supabase.store.daily_tasks.set(inactiveTaskId, {
        id: inactiveTaskId,
        title: 'Old Inactive Task',
        section: 'basics',
        category_id: cat1Id,
        duration_seconds: 10,
        target_scope: 'all',
        active: false,
      });

      const inactiveRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'timed',
            seconds: 10,
            todo_task_id: inactiveTaskId,
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        inactiveRes
      );

      assert.equal(inactiveRes.statusCode, 404);
      assert.match(inactiveRes.body.error, /not found or is no longer active/i);

      // Category mismatch: task is for category 1, client requests category 2
      const cat2Id = crypto.randomUUID();
      supabase.store.categories.set(cat2Id, {
        id: cat2Id,
        name: '2D 4R',
        section: 'basics',
        active: true,
      });

      const catMismatchRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat2Id, // Mismatched category
            mode: 'timed',
            seconds: 10,
            todo_task_id: targetedTaskId,
          },
          student: studentBob,
          adminSupabase: supabase,
        }),
        catMismatchRes
      );

      assert.equal(catMismatchRes.statusCode, 400);
      assert.match(catMismatchRes.body.error, /category mismatch/i);
    });

    it('preserves standalone practice presets and rejects non-preset durations when not assigned', async () => {
      const supabase = createInMemorySupabase();
      setupFixtures(supabase);

      // Standalone timed practice with valid presets (30, 60, 120, 300)
      for (const [secStr, expectedPool] of Object.entries(BASICS_TIMED_POOLS)) {
        const sec = Number(secStr);
        const res = createMockRes();
        await drillHandler(
          createMockReq({
            body: {
              action: 'start',
              kind: 'basics',
              category_id: cat1Id,
              mode: 'timed',
              seconds: sec,
            },
            student: studentAlice,
            adminSupabase: supabase,
          }),
          res
        );
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.mode, 'timed');
        assert.equal(res.body.seconds, sec);
        assert.equal(res.body.pool, expectedPool);
      }

      // Standalone unlimited mode
      const unlimRes = createMockRes();
      await drillHandler(
        createMockReq({
          body: {
            action: 'start',
            kind: 'basics',
            category_id: cat1Id,
            mode: 'unlimited',
          },
          student: studentAlice,
          adminSupabase: supabase,
        }),
        unlimRes
      );
      assert.equal(unlimRes.statusCode, 200);
      assert.equal(unlimRes.body.mode, 'unlimited');
      assert.equal(unlimRes.body.pool, BASICS_UNLIMITED_POOL);

      // Standalone timed practice with non-preset duration (10s, 45s, 130s) MUST be rejected with 400
      for (const invalidSec of [10, 45, 130]) {
        const invalidRes = createMockRes();
        await drillHandler(
          createMockReq({
            body: {
              action: 'start',
              kind: 'basics',
              category_id: cat1Id,
              mode: 'timed',
              seconds: invalidSec,
            },
            student: studentAlice,
            adminSupabase: supabase,
          }),
          invalidRes
        );
        assert.equal(invalidRes.statusCode, 400);
        assert.equal(invalidRes.body.error, 'Timed mode requires seconds to be 30, 60, 120, or 300.');
      }
    });
  });

  describe('3. Five-Task Daily Plan Flow & Streak Status UI Parity', () => {
    it('completing 1 of 5 tasks (the 10s Basics task) keeps "Today counts: Not yet" until all 5 tasks are done', async () => {
      const { summary } = await import('../js/todoProgress.js');
      const { renderStreakCard } = await import('../js/dashboardComponents.js');

      // Setup DOM mock
      const domElements = new Map();
      function getOrCreate(id) {
        if (!domElements.has(id)) {
          domElements.set(id, {
            id,
            textContent: '',
            innerHTML: '',
            style: {},
            classList: {
              classes: new Set(),
              add(c) { this.classes.add(c); },
              remove(c) { this.classes.delete(c); },
              contains(c) { return this.classes.has(c); },
            },
          });
        }
        return domElements.get(id);
      }
      global.document = {
        getElementById: (id) => getOrCreate(id),
      };

      // 5 daily tasks assigned to student today
      const fiveTasks = [
        { id: 'task-1', title: 'QA Phase19 Basics 10s', section: 'basics', duration_seconds: 10, required_count: 1, done: false, done_count: 0 },
        { id: 'task-2', title: 'Speed Addition', section: 'elements', duration_seconds: 60, required_count: 1, done: false, done_count: 0 },
        { id: 'task-3', title: 'Flash Anzan 3D', section: 'flash', required_count: 1, done: false, done_count: 0 },
        { id: 'task-4', title: 'Multiplication Drill', section: 'basics', duration_seconds: 60, required_count: 1, done: false, done_count: 0 },
        { id: 'task-5', title: 'Division Drill', section: 'basics', duration_seconds: 60, required_count: 1, done: false, done_count: 0 },
      ];

      // Initial state: 0 of 5 done
      let taskSummary = summary(fiveTasks);
      assert.equal(taskSummary.done, 0);
      assert.equal(taskSummary.total, 5);
      assert.equal(taskSummary.text, '0 of 5 tasks done today');

      let streakData = {
        current_streak: 3,
        best_streak: 10,
        shields: 1,
        active_today: false,
      };

      renderStreakCard(streakData, fiveTasks);

      let badgeEl = domElements.get('streak-today-badge');
      let ruleNoteEl = domElements.get('streak-rule-note');
      assert.match(badgeEl.innerHTML, /Today counts:\s*Not yet/i);
      assert.match(ruleNoteEl.textContent, /0 of 5 done/i);

      // Student completes task-1 (10s Basics task)
      fiveTasks[0].done = true;
      fiveTasks[0].done_count = 1;

      // New state: 1 of 5 done
      taskSummary = summary(fiveTasks);
      assert.equal(taskSummary.done, 1);
      assert.equal(taskSummary.total, 5);
      assert.equal(taskSummary.text, '1 of 5 tasks done today');

      // Streak rule invariant: streak credit is NOT granted today because only 1 of 5 tasks is complete
      streakData.active_today = taskSummary.done === taskSummary.total; // false
      assert.equal(streakData.active_today, false);

      renderStreakCard(streakData, fiveTasks);

      badgeEl = domElements.get('streak-today-badge');
      ruleNoteEl = domElements.get('streak-rule-note');
      assert.match(badgeEl.innerHTML, /Today counts:\s*Not yet/i, 'Must still show "Today counts: Not yet"');
      assert.match(ruleNoteEl.textContent, /1 of 5 done/i);

      // When the remaining 4 tasks are completed
      for (let i = 1; i < 5; i++) {
        fiveTasks[i].done = true;
        fiveTasks[i].done_count = 1;
      }

      taskSummary = summary(fiveTasks);
      assert.equal(taskSummary.done, 5);
      assert.equal(taskSummary.total, 5);
      assert.equal(taskSummary.text, '5 of 5 tasks done today');

      // All done -> active_today becomes true
      streakData.active_today = taskSummary.done === taskSummary.total; // true
      assert.equal(streakData.active_today, true);

      renderStreakCard(streakData, fiveTasks);

      badgeEl = domElements.get('streak-today-badge');
      ruleNoteEl = domElements.get('streak-rule-note');
      assert.match(badgeEl.innerHTML, /Today counts:\s*Yes/i, 'Must show "Today counts: Yes" when all 5 are done');
      assert.match(ruleNoteEl.textContent, /5 of 5 done/i);
    });
  });
});
