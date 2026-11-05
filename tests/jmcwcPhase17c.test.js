/**
 * Trendz Tracker — Phase 17c Unit & Controller Tests (tests/jmcwcPhase17c.test.js)
 *
 * Covers:
 * 1. Browser bundle safety: shared/jmcwcSaveQueue.js, js/jmcwcClient.js, js/roundScores.js, and js/rounds.js
 *    never import server credentials, generators, or graders, and never invent nonexistent DB columns (like last_heartbeat_at).
 * 2. Round Scores Landing Page view model: assigned group non-editable label, unassigned message, unpublished paper block,
 *    3-unfinished-flat-round cap with disabled explanation, category/manual rounds not occupying flat slots, unfinished flat cards.
 * 3. Category-wise & Manual Category Target comparison: neutral actual-time vs target comparison, no forced stopping or penalty,
 *    and legacy manual category target lookup via jmcwc_categories.legacy_category_id.
 * 4. Runner accessible inputs & no marked-for-review feature across all 14 answer types preserving raw text and decimal precision.
 * 5. Controllable clock timing, explicit Pause, pagehide/visibilitychange keepalive, lease loss (409 LEASE_MISMATCH),
 *    and 2-hour (7,200,000 ms) expiry auto-finalizing saved answers.
 * 6. Local unsent recovery scoped by user + attempt, cleared on sign-out/account change/submission, conflict detection,
 *    and never restoring into submitted or expired attempts.
 * 7. Completed Review & History: frozen max_marks, partial marks, "One valid answer", Manual / Online labels,
 *    and strict isolation from legacy accuracy, Points leaderboard, and weekly-test scores.
 * 8. Admin student deletion preview/execution & forbidden attempt-delete shortcut (no bypass of 3-flat-round cap).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  JMCWC_FLAT_ROUND_LIMIT_MS,
  JMCWC_MAX_UNFINISHED_FLAT,
  formatJmcwcGroupLabel,
  formatActiveDurationMs,
  formatDurationSeconds,
  formatNeutralTargetComparison,
  resolveManualCategoryTargetSeconds,
  computeMonotonicTimerState,
  buildLandingPageViewModel,
  saveLocalUnsentRecovery,
  loadLocalUnsentRecovery,
  clearLocalUnsentForAttempt,
  clearAllJmcwcLocalRecovery,
  syncJmcwcRecoveryUserScope,
  evaluateLocalUnsentRecovery,
  describeQuestionInputSpec,
  splitMultiValueRaw,
  joinMultiValueRaw,
  hasAlternativeValidAnswers,
  buildSubmittedReviewViewModel,
  formatOnlineAttemptsForRoundHistory,
  createJmcwcRunnerController,
} from '../js/jmcwcClient.js';
import {
  JMCWC_MAX_PAUSE_BODY_BYTES,
  buildPauseKeepalivePayload,
  createJmcwcSaveQueue,
} from '../shared/jmcwcSaveQueue.js';
import { createJmcwcServer } from '../api/_jmcwcServer.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
  };
}

describe('Phase 17c — 1. Browser Module Boundary & Schema Column Integrity', () => {
  it('shared/jmcwcSaveQueue.js and browser JS modules have zero server imports and never reference nonexistent last_heartbeat_at column', () => {
    const clientFiles = [
      'shared/jmcwcSaveQueue.js',
      'js/jmcwcClient.js',
      'js/roundScores.js',
      'js/rounds.js',
      'pages/round-scores.html',
      'pages/rounds.html',
    ];

    for (const relPath of clientFiles) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const source = fs.readFileSync(fullPath, 'utf8');

      assert.ok(!source.includes('_jmcwcGenerate'), `${relPath} must not import server generator _jmcwcGenerate`);
      assert.ok(!source.includes('_jmcwcGrade'), `${relPath} must not import server grader _jmcwcGrade`);
      assert.ok(!source.includes('_supabaseAdmin'), `${relPath} must not import server _supabaseAdmin`);
      assert.ok(!source.includes('SUPABASE_SERVICE_ROLE_KEY'), `${relPath} must not reference SUPABASE_SERVICE_ROLE_KEY`);
      assert.ok(!source.includes('last_heartbeat_at'), `${relPath} must not invent nonexistent last_heartbeat_at column`);
      assert.ok(!source.includes('marked_for_review'), `${relPath} must not implement a marked-for-review feature`);
    }
  });
});

describe('Phase 17c — 2. Round Scores Landing Page & 3-Unfinished-Flat-Round Cap', () => {
  it('displays unassigned student notice and disables online practice when group is unassigned', () => {
    const vm = buildLandingPageViewModel({
      assigned: false,
      group_key: null,
      paper_available: false,
      attempts: [],
      categories: [],
      targets: {},
    });

    assert.equal(vm.assigned, false);
    assert.equal(vm.groupLabel, 'Unassigned');
    assert.equal(vm.unassignedMessage, 'Ask your teacher to assign your JMCWC group.');
    assert.equal(vm.canStartNewFlat, false);
  });

  it('keeps online practice unavailable to students when assigned group paper is unpublished in production', () => {
    const vm = buildLandingPageViewModel({
      assigned: true,
      group_key: 'junior1',
      paper_available: false,
      paper: null,
      message: 'Online practice is currently unavailable while papers await publication.',
      attempts: [],
      categories: [{ key: 'addition', label: 'Addition', position: 1 }],
      targets: {},
    });

    assert.equal(vm.assigned, true);
    assert.equal(vm.groupLabel, 'Junior 1');
    assert.equal(vm.paperAvailable, false);
    assert.equal(vm.canStartNewFlat, false);
    assert.ok(vm.flatDisabledReason.includes('unavailable'));
  });

  it('enforces the 3-unfinished-flat-round cap, ignores category rounds for flat slots, and formats unfinished cards', () => {
    const attempts = [
      {
        id: 'flat-1',
        mode: 'flat',
        status: 'paused',
        active_ms: 600_000, // 10m used
        answered_count: 15,
        question_count: 115,
        created_at: '2026-11-01T10:00:00Z',
      },
      {
        id: 'flat-2',
        mode: 'flat',
        status: 'running',
        active_ms: 1_800_000, // 30m used
        answered_count: 42,
        question_count: 115,
        created_at: '2026-11-02T10:00:00Z',
      },
      {
        id: 'cat-1',
        mode: 'category',
        category_key: 'addition',
        status: 'paused',
        active_ms: 45_000,
        answered_count: 3,
        question_count: 5,
        created_at: '2026-11-02T11:00:00Z',
      },
    ];

    // With 2 unfinished flat rounds + 1 unfinished category round: still 1 flat slot open
    const vm2 = buildLandingPageViewModel({
      assigned: true,
      group_key: 'senior',
      paper_available: true,
      paper: { id: 'p-sen', version: '2026.1' },
      attempts,
      categories: [{ key: 'addition', label: 'Addition', position: 1 }],
      targets: { addition: 120 },
    });

    assert.equal(vm2.unfinishedFlatCount, 2);
    assert.equal(vm2.flatCapReached, false);
    assert.equal(vm2.canStartNewFlat, true);
    assert.equal(vm2.flatDisabledReason, null);
    assert.equal(vm2.unfinishedFlatCards.length, 2);
    assert.equal(vm2.unfinishedFlatCards[0].answered_count, 15);
    assert.equal(vm2.unfinishedFlatCards[0].active_time_label, '0:10:00');
    assert.equal(vm2.unfinishedFlatCards[0].remaining_time_label, '1:50:00');
    assert.equal(vm2.unfinishedCategoryAttempts.length, 1);

    // Add 3rd unfinished flat round -> New flat round is disabled with clear explanation
    const attempts3 = [
      ...attempts,
      {
        id: 'flat-3',
        mode: 'flat',
        status: 'paused',
        active_ms: 300_000,
        answered_count: 8,
        question_count: 115,
        created_at: '2026-11-03T09:00:00Z',
      },
    ];
    const vm3 = buildLandingPageViewModel({
      assigned: true,
      group_key: 'senior',
      paper_available: true,
      paper: { id: 'p-sen', version: '2026.1' },
      attempts: attempts3,
      categories: [{ key: 'addition', label: 'Addition', position: 1 }],
      targets: {},
    });

    assert.equal(vm3.unfinishedFlatCount, JMCWC_MAX_UNFINISHED_FLAT);
    assert.equal(vm3.canStartNewFlat, false);
    assert.ok(vm3.flatDisabledReason.includes('three unfinished flat rounds'));

    // Completing flat-3 frees a slot
    const attemptsFreed = attempts3.map((a) =>
      a.id === 'flat-3' ? { ...a, status: 'submitted', score: { marks: 120, max_marks: 200 } } : a
    );
    const vmFreed = buildLandingPageViewModel({
      assigned: true,
      group_key: 'senior',
      paper_available: true,
      paper: { id: 'p-sen', version: '2026.1' },
      attempts: attemptsFreed,
      categories: [{ key: 'addition', label: 'Addition', position: 1 }],
      targets: {},
    });
    assert.equal(vmFreed.unfinishedFlatCount, 2);
    assert.equal(vmFreed.canStartNewFlat, true);
  });
});

describe('Phase 17c — 3. Category-wise & Manual Category Targets (Neutral Comparison, Zero Penalty)', () => {
  it('formats neutral actual-time vs target comparisons and resolves manual category targets via legacy_category_id', () => {
    const noTarget = formatNeutralTargetComparison(95_000, null);
    assert.equal(noTarget.hasTarget, false);
    assert.equal(noTarget.actualText, '1:35');
    assert.equal(noTarget.comparisonText, 'Actual time: 1:35');

    const faster = formatNeutralTargetComparison(100_000, 120);
    assert.equal(faster.hasTarget, true);
    assert.equal(faster.deltaSeconds, -20);
    assert.equal(faster.comparisonText, 'Actual: 1:40 vs Target: 2:00 (0:20 under target)');

    const slower = formatNeutralTargetComparison(150_000, 120);
    assert.equal(slower.hasTarget, true);
    assert.equal(slower.deltaSeconds, 30);
    assert.equal(slower.comparisonText, 'Actual: 2:30 vs Target: 2:00 (0:30 over target)');

    const exact = formatNeutralTargetComparison(120_000, 120);
    assert.equal(exact.deltaSeconds, 0);
    assert.equal(exact.comparisonText, 'Actual: 2:00 vs Target: 2:00 (Matches target)');

    // Manual category entry target lookup strictly requires explicit legacy_category_id mapping
    const targetSec = resolveManualCategoryTargetSeconds(
      { id: 'leg-cat-add', name: 'ADD' },
      [
        { key: 'addition', label: 'Addition', legacy_category_id: 'leg-cat-add' },
        { key: 'subtraction', label: 'Subtraction', legacy_category_id: 'leg-cat-sub' },
      ],
      { addition: 105 }
    );
    assert.equal(targetSec, 105);
    assert.equal(formatDurationSeconds(targetSec), '1:45');

    // Unmapped manual category must NOT silently receive a guessed target by name ('ADD' / 'Addition')
    const unmappedSameName = resolveManualCategoryTargetSeconds(
      { id: 'leg-cat-unmapped', name: 'ADD' },
      [
        { key: 'addition', label: 'Addition', legacy_category_id: null },
        { key: 'subtraction', label: 'Subtraction', legacy_category_id: 'leg-cat-sub' },
      ],
      { addition: 105, subtraction: 90 }
    );
    assert.equal(unmappedSameName, null);

    const missingId = resolveManualCategoryTargetSeconds(
      { id: '', name: 'Addition' },
      [{ key: 'addition', label: 'Addition', legacy_category_id: 'leg-cat-add' }],
      { addition: 105 }
    );
    assert.equal(missingId, null);
  });
});

describe('Phase 17c — 4. Accessible Answer Inputs & Raw Precision Preservation', () => {
  it('describes accessible input specs for all 14 answer types and preserves multi_value raw strings', () => {
    const types = [
      'integer',
      'signed_number',
      'decimal',
      'fraction_or_decimal',
      'repeating_decimal',
      'mixed_number',
      'base_representation',
      'ratio',
      'time_24h',
      'day_of_week',
      'multi_value',
      'prime_factorization',
      'money_decimal',
      'expression_or_number',
    ];

    for (const answer_type of types) {
      const spec = describeQuestionInputSpec({
        id: `q_${answer_type}`,
        input: {
          answer_type,
          fields:
            answer_type === 'multi_value'
              ? [
                  { key: 'x', label: 'x' },
                  { key: 'y', label: 'y' },
                  { key: 'z', label: 'z' },
                ]
              : undefined,
        },
      });
      assert.equal(spec.answerType, answer_type);
      assert.ok(spec.hint.length > 0);
      if (answer_type === 'day_of_week') {
        assert.equal(spec.widget, 'day_of_week');
        assert.equal(spec.options.length, 7);
      } else if (answer_type === 'multi_value') {
        assert.equal(spec.widget, 'multi_value');
        assert.equal(spec.fields.length, 3);
      }
    }

    const parts = splitMultiValueRaw('0.12500, -3/4, 100', 3);
    assert.deepEqual(parts, ['0.12500', '-3/4', '100']);
    assert.equal(joinMultiValueRaw(parts), '0.12500, -3/4, 100');
    assert.equal(joinMultiValueRaw(['', '', '']), '');
  });

  it('maps real question generator outputs for each category/subtype to correct accessible controls, placeholders, hints, and mobile keyboards', async () => {
    const { generateQuestionsFromBlueprint } = await import('../api/_jmcwcGenerate.js');
    const { JMCWC_PAPERS } = await import('../api/_jmcwcBlueprints.js');

    const paper = generateQuestionsFromBlueprint(JMCWC_PAPERS.senior.spec);
    assert.ok(paper.publicQuestions.length > 0);

    for (const q of paper.publicQuestions) {
      const spec = describeQuestionInputSpec(q);
      assert.ok(spec.ariaLabel && spec.ariaLabel.length > 0);
      assert.ok(spec.placeholder && spec.placeholder.length > 0);
      assert.ok(spec.helperText && spec.helperText.length > 0);
      assert.ok(spec.inputMode && ['numeric', 'decimal', 'text'].includes(spec.inputMode));

      if (q.input.type === 'integer') {
        assert.equal(spec.inputMode, 'numeric');
        assert.equal(spec.answerType, 'integer');
      } else if (q.input.type === 'decimal') {
        assert.equal(spec.inputMode, 'decimal');
        assert.equal(spec.answerType, 'decimal');
      } else if (q.input.type === 'fraction') {
        assert.equal(spec.inputMode, 'text');
        assert.ok(spec.quickInsertTokens.includes('/'));
      } else if (q.input.type === 'sum_squares') {
        assert.equal(spec.widget, 'sum_squares');
        assert.ok(spec.quickInsertTokens.includes('^2'));
      } else if (q.input.type === 'elapsed_time') {
        assert.ok(spec.quickInsertTokens.includes(':'));
      }
    }
  });
});

describe('Phase 17c — 5. Controllable Clock Timing, Pause, Keepalive, Lease Loss & Expiry', () => {
  it('computes monotonic timer state from server active_ms and handles pause, pagehide keepalive, lease loss, and 2-hour expiry', async () => {
    let clockMs = 1_000_000;
    const nowFn = () => clockMs;
    const storage = createMemoryStorage();
    const fetchLog = [];

    let serverState = {
      id: 'att-flat-1',
      mode: 'flat',
      group_key: 'junior1',
      status: 'paused',
      active_ms: 7_190_000, // 10 seconds before 2-hour limit
      save_seq: -1,
      revision: 0,
      lease_id: 'lease-1',
      answers: {},
      questions: [
        { id: 'addition_q1', category_key: 'addition', index: 1, prompt: { text: '12 + 34' }, max_marks: 5, input: { answer_type: 'integer' } },
        { id: 'addition_q2', category_key: 'addition', index: 2, prompt: { text: '56 + 78' }, max_marks: 5, input: { answer_type: 'integer' } },
      ],
    };

    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body || '{}');
      fetchLog.push({ url, init, payload });

      if (payload.action === 'resume') {
        serverState.status = 'running';
        serverState.lease_id = 'lease-active-1';
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState, answers: { ...serverState.answers } } }),
        };
      }
      if (payload.action === 'save') {
        if (payload.lease_id !== serverState.lease_id) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ code: 'LEASE_MISMATCH', error: 'Another device resumed this attempt.' }),
          };
        }
        serverState.save_seq = payload.save_seq;
        Object.assign(serverState.answers, payload.answers || {});
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState, answers: { ...serverState.answers } } }),
        };
      }
      if (payload.action === 'pause') {
        serverState.status = 'paused';
        if (payload.answers) {
          serverState.save_seq = payload.save_seq;
          Object.assign(serverState.answers, payload.answers);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            attempt: {
              id: serverState.id,
              mode: serverState.mode,
              status: 'paused',
              active_ms: serverState.active_ms,
              save_seq: serverState.save_seq,
            },
          }),
        };
      }
      if (payload.action === 'heartbeat' || payload.action === 'read' || payload.action === 'submit') {
        if (serverState.active_ms >= JMCWC_FLAT_ROUND_LIMIT_MS || payload.action === 'submit') {
          serverState.status = 'submitted';
          serverState.submitted_reason =
            serverState.active_ms >= JMCWC_FLAT_ROUND_LIMIT_MS ? 'time_limit' : 'early';
          serverState.score = {
            marks: 5,
            max_marks: 10,
            correct: 1,
            partial: 0,
            wrong: 0,
            skipped: 1,
          };
          serverState.review = [
            { id: 'addition_q1', category_key: 'addition', award: 5, max_marks: 5, verdict: 'correct', student_answer: '46', expected: '46', explanation: '12+34=46' },
            { id: 'addition_q2', category_key: 'addition', award: 0, max_marks: 5, verdict: 'skipped', student_answer: null, expected: '134', explanation: '56+78=134' },
          ];
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt: { ...serverState } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, attempt: { ...serverState } }) };
    };

    const runner = createJmcwcRunnerController({
      userId: 'stu-1',
      getAccessToken: () => 'jwt-secret-token-xyz',
      fetchImpl,
      nowFn,
      storage,
    });

    // 1. Resume attempt
    await runner.resumeAttempt('att-flat-1');
    assert.equal(runner.getSnapshot().questionsVisible, true);
    assert.equal(runner.getSnapshot().timer.activeMs, 7_190_000);
    assert.equal(runner.getSnapshot().timer.remainingMs, 10_000);

    // 2. Advance clock by 4 seconds -> monotonic timer shows 7,194,000 ms (6s remaining)
    clockMs += 4_000;
    assert.equal(runner.getSnapshot().timer.activeMs, 7_194_000);
    assert.equal(runner.getSnapshot().timer.remainingMs, 6_000);

    // 3. Edit answer -> queued in saveQueue + saved in local unsent recovery
    runner.editAnswer('addition_q1', '46');
    await runner.saveQueue.flush();
    assert.equal(serverState.answers.addition_q1, '46');
    assert.equal(runner.getSnapshot().saveIndicator, 'Saved');

    // 4. Test pagehide/visibilitychange keepalive:
    const keepaliveSpec = await runner.handleVisibilityHiddenOrPageHide();
    assert.ok(keepaliveSpec);
    assert.equal(runner.getSnapshot().questionsVisible, false);
    assert.equal(runner.getSnapshot().attempt.status, 'paused');
    const keepaliveCall = fetchLog.find((c) => c.init.keepalive === true);
    assert.ok(keepaliveCall);
    assert.equal(keepaliveCall.url, '/api/jmcwc');
    // Token is in Authorization header, NEVER in URL
    assert.ok(!keepaliveCall.url.includes('jwt-secret-token-xyz'));
    assert.equal(keepaliveCall.init.headers.Authorization, 'Bearer jwt-secret-token-xyz');

    // 5. Explicit resume required after pause
    await runner.resumeAttempt('att-flat-1');
    assert.equal(runner.getSnapshot().questionsVisible, true);

    // 6. Simulate lease loss on next save (another device took over)
    serverState.lease_id = 'other-device-lease';
    runner.editAnswer('addition_q2', '134');
    await runner.saveQueue.flush().catch(() => {});
    assert.ok(runner.getSnapshot().leaseLostMessage);
    assert.equal(runner.getSnapshot().questionsVisible, false);

    // 7. Re-acquire lease via explicit resume and advance clock past 2 hours (7,200,000 ms)
    await runner.resumeAttempt('att-flat-1');
    assert.equal(runner.getSnapshot().questionsVisible, true);
    clockMs += 15_000; // 7,190,000 + 15,000 = 7,205,000 >= 7,200,000
    serverState.active_ms = 7_200_000;
    await runner.sendHeartbeat();
    assert.equal(runner.getSnapshot().questionsVisible, false);
    assert.equal(runner.getSnapshot().attempt.status, 'submitted');
  });

  it('falls back to heartbeat-only pause payload when dirty patch exceeds 48 KB keepalive limit', () => {
    const hugeAnswers = {};
    for (let i = 0; i < 30; i += 1) {
      hugeAnswers[`q_${i}`] = '9'.repeat(2000);
    }
    const built = buildPauseKeepalivePayload({
      attempt_id: 'att-1',
      lease_id: 'lease-1',
      save_seq: 5,
      answers: hugeAnswers,
      maxBytes: JMCWC_MAX_PAUSE_BODY_BYTES,
    });
    assert.equal(built.droppedOversizedPatch, true);
    assert.ok(built.byteLength <= JMCWC_MAX_PAUSE_BODY_BYTES);
    assert.equal(built.payload.answers, null);
  });
});

describe('Phase 17c — 6. Local Unsent Answer Recovery Scoped by User + Attempt', () => {
  it('scopes recovery by userId + attemptId, detects conflicts, blocks restore on submitted/expired attempts, and clears on sign-out or user switch', () => {
    const storage = createMemoryStorage();

    saveLocalUnsentRecovery('user-A', 'att-1', { q1: '42', q2: '108' }, storage);

    // Different user cannot load user-A's recovery
    assert.equal(loadLocalUnsentRecovery('user-B', 'att-1', storage), null);

    // Evaluate against server state where q1 is already '42' and q2 is '99' (conflict on q2)
    const evalActive = evaluateLocalUnsentRecovery(
      'user-A',
      {
        id: 'att-1',
        mode: 'flat',
        status: 'paused',
        active_ms: 500_000,
        answers: { q1: '42', q2: '99' },
      },
      storage
    );
    assert.equal(evalActive.eligible, true);
    assert.equal(evalActive.hasConflict, true);
    assert.deepEqual(evalActive.diffPatch, { q2: '108' });
    assert.deepEqual(evalActive.conflictingQuestionIds, ['q2']);

    // Never restore into submitted or expired attempts
    const evalSubmitted = evaluateLocalUnsentRecovery(
      'user-A',
      {
        id: 'att-1',
        mode: 'flat',
        status: 'submitted',
        active_ms: 500_000,
        answers: {},
      },
      storage
    );
    assert.equal(evalSubmitted.eligible, false);
    assert.equal(loadLocalUnsentRecovery('user-A', 'att-1', storage), null);

    // Re-save and verify account change clears all recovery entries
    saveLocalUnsentRecovery('user-A', 'att-2', { q1: '7' }, storage);
    syncJmcwcRecoveryUserScope('user-A', storage);
    assert.ok(loadLocalUnsentRecovery('user-A', 'att-2', storage) !== null);

    // Account switch to user-B purges user-A's cached unsent recovery
    syncJmcwcRecoveryUserScope('user-B', storage);
    assert.equal(loadLocalUnsentRecovery('user-A', 'att-2', storage), null);

    // Explicit clearAllJmcwcLocalRecovery on sign-out
    saveLocalUnsentRecovery('user-B', 'att-3', { q1: '19' }, storage);
    clearAllJmcwcLocalRecovery({ storage });
    assert.equal(loadLocalUnsentRecovery('user-B', 'att-3', storage), null);
  });
});

describe('Phase 17c — 7. Completed Review View Model ("One valid answer", Frozen Max Marks & History Labels)', () => {
  it('uses frozen attempt max_marks, labels alternative answers as "One valid answer", and formats Online history rows without polluting legacy scores', () => {
    const attempt = {
      id: 'att-rev-1',
      mode: 'category',
      group_key: 'senior',
      category_key: 'sum_squares',
      status: 'submitted',
      active_ms: 110_000,
      target_seconds: 120,
      submitted_reason: 'early',
      finished_at: '2026-11-03T10:30:00Z',
      score: {
        marks: 12.5,
        max_marks: 15, // Frozen attempt-specific max_marks
        correct: 1,
        partial: 1,
        wrong: 0,
        skipped: 0,
      },
      review: [
        {
          id: 'sum_squares_q1',
          category_key: 'sum_squares',
          slot: 1,
          prompt: { text: 'Express 50 as a sum of two squares' },
          award: 5,
          max_marks: 5,
          verdict: 'correct',
          student_answer: '5, 5',
          expected: '1^2 + 7^2',
          explanation: 'One valid decomposition of 50 into squares.',
        },
        {
          id: 'approximation_q2',
          category_key: 'approximation',
          slot: 2,
          prompt: { text: 'Approximate 355 / 113' },
          award: 7.5,
          max_marks: 10,
          verdict: 'partial',
          student_answer: '3.14',
          expected: '3.1416',
          explanation: 'Within 1% tolerance earns half marks.',
        },
      ],
    };

    const reviewVm = buildSubmittedReviewViewModel(attempt, [
      { key: 'sum_squares', label: 'Sum of Squares' },
      { key: 'approximation', label: 'Approximation' },
    ]);

    assert.equal(reviewVm.earned_marks, 12.5);
    assert.equal(reviewVm.max_marks, 15);
    assert.equal(reviewVm.partial, 1);
    assert.equal(reviewVm.partial_marks_earned, 7.5);
    assert.equal(reviewVm.items[0].expected_label, 'One valid answer');
    assert.equal(reviewVm.items[1].expected_label, 'Expected answer');
    assert.equal(reviewVm.items[1].verdict, 'partial');

    const historyRows = formatOnlineAttemptsForRoundHistory([attempt], [
      { key: 'sum_squares', label: 'Sum of Squares' },
    ]);
    assert.equal(historyRows.length, 1);
    assert.equal(historyRows[0].source_badge, 'Online');
    assert.equal(historyRows[0].excludes_from_legacy_points_and_accuracy, true);
    assert.equal(historyRows[0].marks_display, '12.5 / 15');
  });
});

describe('Phase 17c — 8. Admin Student Deletion Preview/Execution & Attempt Delete Shortcut Rejection', () => {
  it('computes student deletion counts, blocks attempt-delete shortcuts (403), and deletes only student-owned JMCWC rows', async () => {
    const stuId = '11111111-1111-4111-8111-111111111111';
    const otherStuId = '22222222-2222-4222-8222-222222222222';
    const adminId = '99999999-9999-4999-8999-999999999999';

    const state = {
      profiles: [
        { id: adminId, student_code: 'ADMIN1', full_name: 'Admin Teacher', role: 'admin', active: true },
        { id: stuId, student_code: 'STU1', full_name: 'Aarav', role: 'student', active: true },
      ],
      jmcwc_assignments: [
        { student_id: stuId, group_key: 'junior1' },
        { student_id: otherStuId, group_key: 'senior' },
      ],
      jmcwc_attempts: [
        { id: 'att-stu-1', student_id: stuId },
        { id: 'att-stu-2', student_id: stuId },
        { id: 'att-other-1', student_id: otherStuId },
      ],
      jmcwc_payloads: [
        { attempt_id: 'att-stu-1', questions: [{ answer_key: '42' }] },
        { attempt_id: 'att-stu-2', questions: [{ answer_key: '99' }] },
        { attempt_id: 'att-other-1', questions: [{ answer_key: '7' }] },
      ],
      jmcwc_scores: [
        { attempt_id: 'att-stu-1', marks: 10 },
        { attempt_id: 'att-other-1', marks: 20 },
      ],
      jmcwc_papers: [{ id: 'paper-1', group_key: 'junior1', version: '2026.1', published: false }],
      jmcwc_categories: [{ key: 'addition', label: 'Addition', position: 1 }],
      jmcwc_targets: [{ group_key: 'junior1', category_key: 'addition', target_seconds: 120 }],
    };

    const mockSupabase = {
      auth: {
        async getUser(token) {
          if (token === 'admin-token') {
            return { data: { user: { id: adminId } }, error: null };
          }
          return { data: { user: null }, error: { message: 'Invalid token' } };
        },
      },
      from(table) {
        return {
          select() {
            return {
              eq(col, val) {
                const rows = (state[table] || []).filter((r) => r[col] === val);
                return {
                  single: async () => ({ data: rows[0] || null, error: rows[0] ? null : { message: 'Not found' } }),
                  maybeSingle: async () => ({ data: rows[0] || null, error: null }),
                  then(resolve) {
                    resolve({ data: rows, error: null });
                  },
                };
              },
              in(col, vals) {
                const set = new Set(vals);
                const rows = (state[table] || []).filter((r) => set.has(r[col]));
                return Promise.resolve({ data: rows, error: null });
              },
            };
          },
          delete() {
            return {
              eq(col, val) {
                state[table] = (state[table] || []).filter((r) => r[col] !== val);
                return Promise.resolve({ data: null, error: null });
              },
              in(col, vals) {
                const set = new Set(vals);
                state[table] = (state[table] || []).filter((r) => !set.has(r[col]));
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      },
    };

    const handler = createJmcwcServer({ getSupabaseAdmin: () => mockSupabase });

    const callHandler = async (body) => {
      let status = 200;
      let jsonBody = null;
      const req = {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token' },
        body,
      };
      const res = {
        setHeader() {},
        status(c) {
          status = c;
          return this;
        },
        json(b) {
          jsonBody = b;
          return this;
        },
      };
      await handler(req, res);
      return { status, body: jsonBody };
    };

    // 1. Preview student deletion counts
    const prev = await callHandler({
      action: 'admin_get_student_deletion_preview',
      student_id: stuId,
    });
    assert.equal(prev.status, 200);
    assert.deepEqual(prev.body.counts, {
      jmcwc_assignments: 1,
      jmcwc_attempts: 2,
      jmcwc_payloads: 2,
      jmcwc_scores: 1,
    });
    assert.deepEqual(prev.body.preserved_shared_tables, [
      'jmcwc_papers',
      'jmcwc_categories',
      'jmcwc_targets',
    ]);

    // 2. Attempt to delete JMCWC attempts without confirm_student_account_deletion -> rejected with 403
    const shortcutAttempt = await callHandler({
      action: 'admin_delete_student_jmcwc_data',
      student_id: stuId,
      confirm_student_account_deletion: false,
    });
    assert.equal(shortcutAttempt.status, 403);
    assert.equal(shortcutAttempt.body.code, 'ATTEMPT_DELETE_SHORTCUT_FORBIDDEN');
    assert.equal(state.jmcwc_attempts.length, 3); // Unchanged

    // 3. Confirmed student account deletion removes only stuId's rows and preserves shared tables + other students
    const confirmedDel = await callHandler({
      action: 'admin_delete_student_jmcwc_data',
      student_id: stuId,
      confirm_student_account_deletion: true,
    });
    assert.equal(confirmedDel.status, 200);
    assert.equal(state.jmcwc_assignments.length, 1);
    assert.equal(state.jmcwc_attempts.length, 1);
    assert.equal(state.jmcwc_payloads.length, 1);
    assert.equal(state.jmcwc_scores.length, 1);
    assert.equal(state.jmcwc_papers.length, 1);
    assert.equal(state.jmcwc_categories.length, 1);
    assert.equal(state.jmcwc_targets.length, 1);
  });
});
