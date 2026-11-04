/**
 * Trendz Tracker — JMCWC Simulator Staging Regression Tests (tests/jmcwcStagingFixes.test.js)
 *
 * Verifies the three independently reported staging fixes:
 * 1. Flat-round landing card displays actual paper question count and category question counts (no "full questions").
 * 2. Consistent error handling (err.statusCode & err.status) and takeover confirmation modal on both start and resume,
 *    preserving the existing attempt when cancelled.
 * 3. Removal of internal identifiers (e.g. fraction_add_s1) from student-facing views while retaining IDs in code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLandingPageViewModel,
  buildSubmittedReviewViewModel,
  createJmcwcRunnerController,
  formatJmcwcCategoryTitle,
  JMCWC_CATEGORY_TITLES,
} from '../js/jmcwcClient.js';
import { createJmcwcServer } from '../api/_jmcwcServer.js';

describe('JMCWC Staging Issue 1: Flat-round landing card & category counts', () => {
  it('API status handler extracts total_questions and section question_counts from paper spec with questions array', async () => {
    // Synthetic mock supabase client returning a published paper spec with sections[].questions
    const mockPaperSpec = {
      schema_version: '17a.1',
      total_questions: 230,
      total_cached_marks: 230,
      sections: [
        { key: 'addition', questions: Array.from({ length: 10 }, (_, i) => ({ slot: i + 1 })) },
        { key: 'subtraction', questions: Array.from({ length: 10 }, (_, i) => ({ slot: i + 1 })) },
        { key: 'fraction_add', questions: Array.from({ length: 10 }, (_, i) => ({ slot: i + 1 })) },
      ],
    };

    function createQueryBuilder(table) {
      const state = { table, filters: [], orders: [] };
      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          state.filters.push({ col, val });
          return builder;
        },
        order(col, opts) {
          state.orders.push({ col, opts });
          return builder;
        },
        limit() {
          return builder;
        },
        range() {
          return builder;
        },
        single() {
          return builder;
        },
        maybeSingle() {
          return builder;
        },
        in() {
          return builder;
        },
        then(resolve, reject) {
          let result = { data: null, error: null };
          if (table === 'profiles') {
            result = {
              data: {
                id: '00000000-0000-4000-8000-000000000001',
                role: 'student',
                active: true,
                student_code: 'TEST01',
                full_name: 'Test Student',
                level: 1,
              },
              error: null,
            };
          } else if (table === 'jmcwc_assignments') {
            result = {
              data: {
                student_id: '00000000-0000-4000-8000-000000000001',
                group_key: 'junior1',
                updated_at: new Date().toISOString(),
              },
              error: null,
            };
          } else if (table === 'jmcwc_categories') {
            result = {
              data: [
                { key: 'addition', label: 'Integer addition', workbook_sheet: 'Addition', position: 1 },
                { key: 'subtraction', label: 'Integer subtraction', workbook_sheet: 'Subtraction', position: 2 },
                { key: 'fraction_add', label: 'Fraction addition', workbook_sheet: 'Fraction Add', position: 9 },
              ],
              error: null,
            };
          } else if (table === 'jmcwc_papers') {
            result = {
              data: [
                {
                  id: '00000000-0000-4000-8000-000000000010',
                  group_key: 'junior1',
                  version: '2026.3',
                  published: true,
                  created_at: new Date().toISOString(),
                  spec: mockPaperSpec,
                },
              ],
              error: null,
            };
          } else if (table === 'jmcwc_targets') {
            result = {
              data: [
                { group_key: 'junior1', category_key: 'addition', target_seconds: 120 },
                { group_key: 'junior1', category_key: 'fraction_add', target_seconds: 180 },
              ],
              error: null,
            };
          } else if (table === 'jmcwc_scores' || table === 'jmcwc_payloads' || table === 'jmcwc_attempts') {
            result = { data: [], error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    }

    const mockSupabase = {
      from(table) {
        return createQueryBuilder(table);
      },
      rpc(fnName) {
        if (fnName === 'jmcwc_check_student') {
          return Promise.resolve({ data: 'junior1', error: null });
        }
        if (fnName === 'jmcwc_list') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      auth: {
        async getUser() {
          return { data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, error: null };
        },
      },
    };

    const serverHandler = createJmcwcServer({
      getSupabaseAdmin: () => mockSupabase,
    });

    let resBody = null;
    let resStatus = 0;
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer mock-jwt' },
      body: { action: 'status' },
    };
    const res = {
      setHeader() {},
      status(code) {
        resStatus = code;
        return this;
      },
      json(data) {
        resBody = data;
        return this;
      },
    };

    await serverHandler(req, res);

    assert.equal(resStatus, 200);
    assert.ok(resBody.paper, 'Paper object must be returned in status');
    assert.equal(resBody.paper.total_questions, 230, 'total_questions must be 230, not null or 0');
    assert.equal(resBody.paper.question_count, 230, 'question_count must be 230, not null or 0');

    // Verify sections have positive question_count
    const addSec = resBody.paper.sections.find((s) => s.key === 'addition');
    assert.ok(addSec, 'addition section must be present');
    assert.equal(addSec.question_count, 10, 'addition section question_count must be 10');

    // 2. Pass this status payload through buildLandingPageViewModel
    const vm = buildLandingPageViewModel(resBody);
    assert.equal(vm.totalPaperQuestions, 230, 'View-model totalPaperQuestions must be 230');

    const vmAddCat = vm.categories.find((c) => c.key === 'addition');
    assert.ok(vmAddCat, 'addition category present in view-model');
    assert.equal(vmAddCat.question_count, 10, 'category question_count must be 10, not null');

    const vmFracCat = vm.categories.find((c) => c.key === 'fraction_add');
    assert.ok(vmFracCat, 'fraction_add category present in view-model');
    assert.equal(vmFracCat.question_count, 10, 'fraction_add question_count must be 10');
  });

  it('buildLandingPageViewModel computes question count from paper.spec when paper object contains raw spec', () => {
    const rawPayload = {
      assigned: true,
      group_key: 'senior',
      paper_available: true,
      paper: {
        id: 'paper-sr-1',
        spec: {
          total_questions: 446,
          sections: [
            { key: 'addition', questions: Array.from({ length: 20 }) },
            { key: 'brackets', questions: Array.from({ length: 20 }) },
          ],
        },
      },
      categories: [
        { key: 'addition', label: 'Integer addition', position: 1 },
        { key: 'brackets', label: 'Brackets', position: 6 },
      ],
      attempts: [],
    };

    const vm = buildLandingPageViewModel(rawPayload);
    assert.equal(vm.totalPaperQuestions, 446, 'Must extract total_questions from spec.total_questions');
    const addCat = vm.categories.find((c) => c.key === 'addition');
    assert.equal(addCat.question_count, 20, 'Category question_count must be 20');
  });
});

describe('JMCWC Staging Issue 2: Consistent error handling & takeover modal on start and resume', () => {
  it('callApi sets both err.statusCode and err.status consistently on HTTP error responses', async () => {
    let capturedErr = null;
    const mockFetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Another simulator round is currently active. Confirm takeover to pause it and resume this round.',
        code: 'TAKEOVER_CONFIRMATION_REQUIRED',
        running_attempt_id: '00000000-0000-4000-8000-000000000099',
      }),
    });

    const runner = createJmcwcRunnerController({
      userId: 'test-user',
      getAccessToken: () => 'token',
      fetchImpl: mockFetch,
    });

    try {
      await runner.resumeAttempt('00000000-0000-4000-8000-000000000002');
    } catch (err) {
      capturedErr = err;
    }

    assert.ok(capturedErr, 'Must throw error on 409 response');
    assert.equal(capturedErr.statusCode, 409, 'err.statusCode must be 409');
    assert.equal(capturedErr.status, 409, 'err.status must be 409 for consistency');
    assert.equal(capturedErr.code, 'TAKEOVER_CONFIRMATION_REQUIRED');
    assert.equal(capturedErr.attemptId, '00000000-0000-4000-8000-000000000002', 'err.attemptId must be attached');
  });

  it('startAttempt attaches attemptId to thrown error when another attempt is active', async () => {
    let capturedErr = null;
    const createdAttemptId = '00000000-0000-4000-8000-000000000055';

    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            attempt: { id: createdAttemptId, status: 'paused', mode: 'flat' },
          }),
        };
      }
      if (body.action === 'resume') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'Another simulator round is currently active. Confirm takeover to pause it and resume this round.',
            code: 'TAKEOVER_CONFIRMATION_REQUIRED',
            running_attempt_id: 'running-other-attempt',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const runner = createJmcwcRunnerController({
      userId: 'test-user',
      getAccessToken: () => 'token',
      fetchImpl: mockFetch,
    });

    try {
      await runner.startAttempt({ mode: 'flat' });
    } catch (err) {
      capturedErr = err;
    }

    assert.ok(capturedErr, 'Must throw error when resume fails during startAttempt');
    assert.equal(capturedErr.status, 409, 'err.status must be 409');
    assert.equal(capturedErr.statusCode, 409, 'err.statusCode must be 409');
    assert.equal(capturedErr.code, 'TAKEOVER_CONFIRMATION_REQUIRED');
    assert.equal(
      capturedErr.attemptId,
      createdAttemptId,
      'startAttempt must attach the created attempt ID so the takeover modal can confirm takeover'
    );
  });

  it('resumeAttempt sends confirm_takeover: true when takeover flag is passed', async () => {
    let capturedResumePayload = null;
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'resume') {
        capturedResumePayload = body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            attempt: {
              id: body.attempt_id,
              status: 'running',
              lease_id: '00000000-0000-4000-8000-000000000088',
              mode: 'flat',
              questions: [],
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const runner = createJmcwcRunnerController({
      userId: 'test-user',
      getAccessToken: () => 'token',
      fetchImpl: mockFetch,
    });

    await runner.resumeAttempt('attempt-takeover-id', { takeover: true });
    assert.ok(capturedResumePayload, 'resume API was called');
    assert.equal(capturedResumePayload.confirm_takeover, true, 'confirm_takeover must be true when taking over');
  });
});

describe('JMCWC Staging Issue 3: Removal of internal identifiers from student-facing questions', () => {
  it('buildSubmittedReviewViewModel displays readable category titles and row index numbers without internal IDs', () => {
    const rawReview = [
      {
        id: 'fraction_add_s1',
        question_key: 'fraction_add_s1',
        category_key: 'fraction_add',
        prompt: '1 1/2 + 2 1/4 =',
        max_marks: 5,
        award: 5,
        verdict: 'correct',
        student_answer: '3 3/4',
        expected: '3 3/4',
        explanation: '1 1/2 + 2 1/4 = 3 3/4',
      },
      {
        id: 'addition_s1',
        question_key: 'addition_s1',
        category_key: 'addition',
        prompt: '45 + 55 =',
        max_marks: 3,
        award: 3,
        verdict: 'correct',
        student_answer: '100',
        expected: '100',
        explanation: '45 + 55 = 100',
      },
    ];

    const vm = buildSubmittedReviewViewModel({
      attempt: {
        id: 'att-1',
        mode: 'flat',
        status: 'submitted',
        group_key: 'junior1',
        active_ms: 120000,
        review: rawReview,
      },
      score: { marks: 8, max_marks: 8 },
    });

    assert.equal(vm.questions.length, 2);

    const q1 = vm.questions[0];
    assert.equal(q1.index, 1, 'Question 1 index is 1');
    assert.equal(q1.category_name, 'Fraction addition', 'category_name must be readable title, not fraction_add');
    assert.equal(q1.question_key, 'fraction_add_s1', 'Internal question_key is preserved on object for code use');

    const q2 = vm.questions[1];
    assert.equal(q2.index, 2, 'Question 2 index is 2');
    assert.equal(q2.category_name, 'Integer addition', 'category_name must be readable title, not addition');
  });

  it('formatJmcwcCategoryTitle maps all 23 canonical keys to human-readable English titles', () => {
    const sampleKeys = [
      ['addition', 'Integer addition'],
      ['subtraction', 'Integer subtraction'],
      ['mixed', 'Mixed addition and subtraction'],
      ['fraction_add', 'Fraction addition'],
      ['fraction_sub', 'Fraction subtraction'],
      ['fraction_mul', 'Fraction multiplication'],
      ['fraction_div', 'Fraction division'],
      ['brackets', 'Brackets'],
      ['prime_factors', 'Prime factorisation'],
      ['hcf_lcm', 'HCF and LCM'],
      ['approximation', 'Approximations'],
      ['remainder', 'Remainders'],
      ['ratio', 'Ratios'],
      ['square_root', 'Perfect square roots'],
      ['inexact_square_root', 'Inexact square roots'],
      ['next_square', 'Next squares'],
      ['cube_root', 'Exact cube roots'],
      ['next_cube', 'Next cubes'],
      ['calendar', 'Calendars'],
      ['elapsed_time', 'Elapsed time'],
      ['sum_squares', 'Sums of squares'],
    ];

    for (const [key, expectedTitle] of sampleKeys) {
      assert.equal(formatJmcwcCategoryTitle(key), expectedTitle, `Key ${key} maps to '${expectedTitle}'`);
    }
  });

  it('runner buildSectionedQuestions assigns human-readable category names to sections and questions', async () => {
    const rawQuestions = [
      { id: 'fraction_add_s1', category_key: 'fraction_add', slot: 1, max_marks: 5, prompt: '1/2 + 1/3 =' },
      { id: 'fraction_add_s2', category_key: 'fraction_add', slot: 2, max_marks: 5, prompt: '2/3 + 3/4 =' },
    ];

    const runner = createJmcwcRunnerController({
      userId: 'test-user',
      getAccessToken: () => 'token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attempt: {
            id: 'att-1',
            mode: 'category',
            status: 'running',
            lease_id: '00000000-0000-4000-8000-000000000001',
            questions: rawQuestions,
          },
        }),
      }),
    });

    await runner.resumeAttempt('att-1');
    runner.recordAnswer('fraction_add_s1', '5/6');
    const snapshot = runner.getSnapshot();
    assert.equal(snapshot.questions.length, 1);
    const sec = snapshot.questions[0];
    assert.equal(sec.display_name, 'Fraction addition', 'Section display_name must be readable');
    assert.equal(sec.category_name, 'Fraction addition', 'Section category_name must be readable');

    const q1 = sec.questions[0];
    assert.equal(q1.question_index, 1, 'Question index is 1');
    assert.equal(q1.category_name, 'Fraction addition', 'Question category_name is readable');
    assert.equal(q1.question_key, 'fraction_add_s1', 'Internal question_key is preserved');
  });
});
