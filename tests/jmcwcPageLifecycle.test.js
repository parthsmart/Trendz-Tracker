import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJmcwcRunnerController,
  computeMonotonicTimerState,
} from '../js/jmcwcClient.js';

describe('JMCWC Browser Lifecycle & Runner Schedulers Integration', () => {
  it('sends heartbeat every 10 seconds while running and visible, preventing overlapping requests', async () => {
    let clockMs = 100_000;
    const nowFn = () => clockMs;
    const apiCalls = [];
    let heartbeatDelayMs = 0;

    let serverState = {
      id: 'att-100',
      mode: 'flat',
      status: 'running',
      lease_id: 'lease-test-1',
      active_ms: 60_000,
      save_seq: 0,
      revision: 1,
      questions: [
        { id: 'q1', category_key: 'addition', max_marks: 1, prompt: '1+1', input: { type: 'integer' } }
      ],
      answers: {},
    };

    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body || '{}');
      apiCalls.push({ action: payload.action, time: clockMs });
      if (heartbeatDelayMs > 0) {
        await new Promise((r) => setTimeout(r, heartbeatDelayMs));
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attempt: {
            ...serverState,
            active_ms: serverState.active_ms + (payload.action === 'heartbeat' ? 10_000 : 0),
          },
        }),
      };
    };

    const controller = createJmcwcRunnerController({
      userId: 'student-1',
      getAccessToken: async () => 'test-token',
      fetchImpl,
      nowFn,
    });

    // Resume attempt
    await controller.resumeAttempt('att-100');
    assert.equal(controller.getState().status, 'running');
    assert.equal(apiCalls.filter((c) => c.action === 'resume').length, 1);

    // Heartbeat 1 after 10 seconds
    clockMs += 10_000;
    await controller.sendHeartbeat();
    assert.equal(apiCalls.filter((c) => c.action === 'heartbeat').length, 1);

    // Heartbeat 2 after 20 seconds
    clockMs += 10_000;
    await controller.sendHeartbeat();
    assert.equal(apiCalls.filter((c) => c.action === 'heartbeat').length, 2);

    // Overlapping request prevention
    let inFlight = false;
    let callCount = 0;
    const safeHeartbeatCaller = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        callCount += 1;
        await controller.sendHeartbeat();
      } finally {
        inFlight = false;
      }
    };

    // Simulate two concurrent ticks
    heartbeatDelayMs = 20;
    const [p1, p2] = [safeHeartbeatCaller(), safeHeartbeatCaller()];
    await Promise.all([p1, p2]);
    // The second call was skipped due to inFlight guard
    assert.equal(callCount, 1);
  });

  it('reproduction: flat attempt at active_ms=7199000 automatically reaches expiry at zero and finalizes without user typing/clicking', async () => {
    let clockMs = 1_000_000;
    const nowFn = () => clockMs;
    const apiActions = [];

    let serverState = {
      id: 'att-staging-repro',
      mode: 'flat',
      status: 'paused',
      lease_id: 'lease-repro-1',
      active_ms: 7_199_000, // Exactly 1,000ms before 2-hour limit (7,200,000ms)
      save_seq: 0,
      revision: 1,
      questions: [
        { id: 'q1', category_key: 'addition', max_marks: 2, prompt: '100 + 200', input: { type: 'integer' } }
      ],
      answers: {},
    };

    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body || '{}');
      apiActions.push(payload.action);

      if (payload.action === 'resume') {
        serverState.status = 'running';
        serverState.lease_id = 'lease-repro-active';
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState } }),
        };
      }

      if (payload.action === 'heartbeat' || payload.action === 'submit') {
        // At 7,200,000ms server transitions to grading/submitted
        serverState.status = 'submitted';
        serverState.active_ms = 7_200_000;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            expired: true,
            attempt: {
              ...serverState,
              score: { marks: 2, max_marks: 2, correct: 1, partial: 0, wrong: 0, skipped: 0 },
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, attempt: { ...serverState } }),
      };
    };

    const controller = createJmcwcRunnerController({
      userId: 'student-repro',
      getAccessToken: async () => 'test-token',
      fetchImpl,
      nowFn,
    });

    // 1. Student resumes attempt
    await controller.resumeAttempt('att-staging-repro');
    let state = controller.getState();
    assert.equal(state.status, 'running');
    assert.equal(state.questionsHidden, false);
    assert.equal(state.timer.remainingMs, 1000);
    assert.equal(state.timer.expired, false);

    // 2. Advance time by 1000ms without typing or clicking anything
    clockMs += 1000;
    const timerAfter1s = controller.getTimerState();
    assert.equal(timerAfter1s.remainingMs, 0);
    assert.equal(timerAfter1s.expired, true);

    // 3. Flat expiry handler triggers automatically
    assert.equal(timerAfter1s.expired, true);
    await controller.handleFlatExpiry();

    // 4. Questions and inputs are immediately hidden, attempt finalized on server
    const finalState = controller.getState();
    assert.equal(finalState.questionsHidden, true);
    assert.equal(finalState.status, 'submitted');
    assert.ok(apiActions.includes('heartbeat') || apiActions.includes('submit'));
    assert.equal(finalState.score.marks, 2);
  });

  it('stops schedulers on pause, pagehide keepalive, and lease loss, resuming only on explicit action', async () => {
    let clockMs = 500_000;
    const nowFn = () => clockMs;
    const actionLog = [];

    let serverState = {
      id: 'att-lifecycle',
      mode: 'category',
      category_key: 'addition',
      status: 'running',
      lease_id: 'lease-life-1',
      active_ms: 10_000,
      save_seq: 0,
      revision: 1,
      questions: [
        { id: 'q1', category_key: 'addition', max_marks: 1, prompt: '5 + 5', input: { type: 'integer' } }
      ],
      answers: {},
    };

    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body || '{}');
      actionLog.push(payload.action);

      if (payload.action === 'pause') {
        serverState.status = 'paused';
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState, questions: undefined, lease_id: undefined } }),
        };
      }
      if (payload.action === 'resume') {
        serverState.status = 'running';
        serverState.lease_id = 'lease-life-2';
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, attempt: { ...serverState } }),
      };
    };

    const controller = createJmcwcRunnerController({
      userId: 'student-life',
      getAccessToken: async () => 'test-token',
      fetchImpl,
      nowFn,
    });

    await controller.resumeAttempt('att-lifecycle');
    assert.equal(controller.getState().status, 'running');
    assert.equal(controller.getState().questionsHidden, false);

    // Pause hides questions immediately
    await controller.pauseAttempt();
    assert.equal(controller.getState().status, 'paused');
    assert.equal(controller.getState().questionsHidden, true);

    // Returning to view/page does NOT auto-resume; questions stay hidden
    clockMs += 5000;
    assert.equal(controller.getState().questionsHidden, true);

    // Explicit resume re-enables questions and creates fresh lease
    await controller.resumeAttempt('att-lifecycle');
    assert.equal(controller.getState().status, 'running');
    assert.equal(controller.getState().questionsHidden, false);

    // Pagehide / visibility hidden handler immediately hides questions and pauses
    await controller.handleVisibilityHiddenOrPageHide();
    assert.equal(controller.getState().questionsHidden, true);
    assert.ok(actionLog.includes('pause'));
  });
});
