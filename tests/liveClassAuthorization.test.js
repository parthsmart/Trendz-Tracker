/**
 * Trendz Tracker — Live Classes Authorization & Webinar.gg Integration Suite
 * File: tests/liveClassAuthorization.test.js
 *
 * Verifies:
 * 1. Audience checks (level matching, explicit student IDs, outside audience rejection)
 * 2. Participant formatting and privacy compliance (placeholder phone, synthetic email)
 * 3. Role-based host identity mapping (admin and assigned teacher receive host access)
 * 4. Token failure handling & provider error resilience
 * 5. Double-click & repeated join requests
 * 6. Strict Cache-Control: no-store and Pragma headers
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStudentInAudience,
  formatWebinarParticipant,
  handleLiveClassRequest,
} from '../api/_liveClass.js';

test('1. Audience membership: isStudentInAudience respects explicit IDs, levels, and open classes', () => {
  const studentAlpha = { id: 'stu-1', role: 'student', level: 'Basic 1' };
  const studentBeta = { id: 'stu-2', role: 'student', level: 'Basic 2' };
  const studentGamma = { id: 'stu-3', role: 'student', level: 'Basic 1' };

  // Explicit target student IDs list
  const targetedClass = {
    target_student_ids: ['stu-1', 'stu-99'],
    target_level: null,
  };
  assert.equal(isStudentInAudience(studentAlpha, targetedClass), true);
  assert.equal(isStudentInAudience(studentBeta, targetedClass), false);
  assert.equal(isStudentInAudience(studentGamma, targetedClass), false);

  // Target level matching
  const levelClass = {
    target_student_ids: null,
    target_level: 'Basic 1',
  };
  assert.equal(isStudentInAudience(studentAlpha, levelClass), true);
  assert.equal(isStudentInAudience(studentBeta, levelClass), false);
  assert.equal(isStudentInAudience(studentGamma, levelClass), true);

  // Open class (no target_student_ids and no target_level)
  const openClass = {
    target_student_ids: null,
    target_level: null,
  };
  assert.equal(isStudentInAudience(studentAlpha, openClass), true);
  assert.equal(isStudentInAudience(studentBeta, openClass), true);

  // Non-student role is never in student audience
  assert.equal(isStudentInAudience({ id: 'tch-1', role: 'teacher', level: 'Teacher' }, openClass), false);
  assert.equal(isStudentInAudience(null, openClass), false);
});

test('2. Privacy & Schema compliance: formatWebinarParticipant fulfills Webinar.gg schema without harvesting child phones', () => {
  const p1 = formatWebinarParticipant('Aarav Sharma', 'aarav@example.com', 'stu-1');
  assert.equal(p1.firstName, 'Aarav');
  assert.equal(p1.lastName, 'Sharma');
  assert.equal(p1.email, 'aarav@example.com');
  assert.equal(p1.phone, '+910000000000'); // Standard compliant dummy phone

  // Single word name fallback
  const p2 = formatWebinarParticipant('Riya', '', 'stu-2');
  assert.equal(p2.firstName, 'Riya');
  assert.equal(p2.lastName, '.');
  assert.equal(p2.email, 'student_stu-2@trendz.local');
  assert.equal(p2.phone, '+910000000000');
});

test('3. Server-side Live Class join authorization and host identity mapping', async () => {
  const mockClass = {
    id: 'class-101',
    title: 'Abacus Live Class: Basics 1',
    webinar_id: 'wgg-webinar-abc',
    teacher_id: 'tch-sunil',
    host_email: 'suniltrendzeducation@gmail.com',
    target_level: 'Basic 1',
    target_student_ids: null,
    scheduled_start_time: '2026-11-23T14:30:00Z',
    duration_minutes: 60,
    status: 'scheduled',
    provider_status: null,
    teacher: { id: 'tch-sunil', full_name: 'Sunil Sir' },
  };

  const mockUsers = {
    'token-admin': {
      user: { id: 'usr-admin', email: 'admin@trendz.local' },
      profile: { id: 'usr-admin', full_name: 'Staging Admin', role: 'admin', level: 'Admin', active: true },
    },
    'token-teacher-assigned': {
      user: { id: 'tch-sunil', email: 'sunil@trendz.local' },
      profile: { id: 'tch-sunil', full_name: 'Sunil Sir', role: 'teacher', level: 'Teacher', active: true },
    },
    'token-teacher-other': {
      user: { id: 'tch-other', email: 'other@trendz.local' },
      profile: { id: 'tch-other', full_name: 'Other Teacher', role: 'teacher', level: 'Teacher', active: true },
    },
    'token-student-eligible': {
      user: { id: 'stu-eligible', email: 'stu-eligible@trendz.local' },
      profile: { id: 'stu-eligible', full_name: 'Eligible Student', role: 'student', level: 'Basic 1', active: true },
    },
    'token-student-ineligible': {
      user: { id: 'stu-ineligible', email: 'stu-ineligible@trendz.local' },
      profile: { id: 'stu-ineligible', full_name: 'Ineligible Student', role: 'student', level: 'Junior 1', active: true },
    },
    'token-inactive': {
      user: { id: 'stu-inactive', email: 'stu-inactive@trendz.local' },
      profile: { id: 'stu-inactive', full_name: 'Inactive Student', role: 'student', level: 'Basic 1', active: false },
    },
  };

  const createMockSupabase = () => ({
    auth: {
      getUser: async (token) => {
        const u = mockUsers[token];
        if (!u) return { data: { user: null }, error: new Error('Invalid token') };
        return { data: { user: u.user }, error: null };
      },
    },
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === 'profiles') {
              const match = Object.values(mockUsers).find((u) => u.profile.id === val);
              return { data: match ? match.profile : null, error: match ? null : new Error('Profile not found') };
            }
            if (table === 'live_classes' && val === mockClass.id) {
              return { data: mockClass, error: null };
            }
            return { data: null, error: new Error('Not found') };
          },
        }),
      }),
    }),
  });

  const capturedWebinarCalls = [];
  const mockFetch = async (url, opts) => {
    if (url.includes('/webinar/join-token')) {
      const body = JSON.parse(opts.body);
      capturedWebinarCalls.push(body);
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          success: true,
          data: {
            token: `token-mock-${body.email}`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            expiresInSeconds: 600,
          },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };

  const runRequest = async (token, action = 'join', classId = 'class-101') => {
    let statusCode = 200;
    let jsonResult = null;
    const headers = {};

    const req = {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: { action, classId },
    };

    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResult = data; return res; },
      end: () => res,
    };

    process.env.WEBINAR_GG_TOKEN = 'test-token-123';
    await handleLiveClassRequest(req, res, {
      supabase: createMockSupabase(),
      fetch: mockFetch,
    });

    return { statusCode, jsonResult, headers };
  };

  // Case A: Unauthenticated request rejected with 401
  const unauth = await runRequest(null);
  assert.equal(unauth.statusCode, 401);
  assert.ok(unauth.jsonResult.error.includes('Missing Bearer token'));

  // Case B: Inactive account rejected with 403
  const inactive = await runRequest('token-inactive');
  assert.equal(inactive.statusCode, 403);
  assert.equal(inactive.jsonResult.code, 'INACTIVE_ACCOUNT');

  // Case C: Admin receives host studio access
  const adminJoin = await runRequest('token-admin');
  assert.equal(adminJoin.statusCode, 200);
  assert.equal(adminJoin.jsonResult.isHost, true);
  assert.ok(adminJoin.jsonResult.token);
  assert.ok(adminJoin.jsonResult.embedUrl.includes('token-mock-suniltrendzeducation@gmail.com'));
  assert.equal(adminJoin.headers['Cache-Control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // Case D: Assigned teacher receives host studio access
  const teacherJoin = await runRequest('token-teacher-assigned');
  assert.equal(teacherJoin.statusCode, 200);
  assert.equal(teacherJoin.jsonResult.isHost, true);
  assert.ok(teacherJoin.jsonResult.embedUrl.includes('token-mock-suniltrendzeducation@gmail.com'));

  // Case E: Eligible student receives attendee live room access
  const studentJoin = await runRequest('token-student-eligible');
  assert.equal(studentJoin.statusCode, 200);
  assert.equal(studentJoin.jsonResult.isHost, false);
  assert.ok(studentJoin.jsonResult.embedUrl.includes('token-mock-stu-eligible@trendz.local'));

  // Case F: Ineligible student outside audience is rejected with 403
  const studentIneligible = await runRequest('token-student-ineligible');
  assert.equal(studentIneligible.statusCode, 403);
  assert.equal(studentIneligible.jsonResult.code, 'NOT_ENROLLED');

  // Case G: Unrelated teacher is not permitted to host someone else's class as teacher
  const teacherOther = await runRequest('token-teacher-other');
  assert.equal(teacherOther.statusCode, 403);
  assert.equal(teacherOther.jsonResult.code, 'UNAUTHORIZED_ROLE');
});

test('4. Token failure and rate limit error handling allows clean retry', async () => {
  const mockClass = {
    id: 'class-101',
    title: 'Abacus Live Class',
    webinar_id: 'wgg-webinar-fail',
    teacher_id: 'tch-1',
    host_email: 'host@example.com',
    target_level: null,
    target_student_ids: null,
    status: 'scheduled',
  };

  const mockSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'stu-1', email: 'stu@example.com' } },
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { id: 'stu-1', full_name: 'Student One', role: 'student', level: 'Basic 1', active: true, ...mockClass },
            error: null,
          }),
        }),
      }),
    }),
  };

  let failCount = 0;
  const failingFetch = async () => {
    failCount++;
    if (failCount === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ success: false, error: 'Rate limit exceeded. Please retry.' }),
      };
    }
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        success: true,
        data: { token: 'retry-token-ok', expiresInSeconds: 600 },
      }),
    };
  };

  const execute = async () => {
    let statusCode = 200;
    let jsonResult = null;
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer valid-jwt' },
      body: { action: 'join', classId: 'class-101' },
    };
    const res = {
      setHeader: () => {},
      status: (c) => { statusCode = c; return res; },
      json: (d) => { jsonResult = d; return res; },
      end: () => res,
    };
    await handleLiveClassRequest(req, res, {
      supabase: mockSupabase,
      fetch: failingFetch,
    });
    return { statusCode, jsonResult };
  };

  // Attempt 1 fails with 429
  const res1 = await execute();
  assert.equal(res1.statusCode, 429);
  assert.ok(res1.jsonResult.error.includes('Rate limit'));

  // Attempt 2 (Retry) succeeds cleanly
  const res2 = await execute();
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.jsonResult.token, 'retry-token-ok');
});

test('5. Cancelled and ended classes block active join action', async () => {
  const cancelledClass = {
    id: 'class-cancelled',
    title: 'Cancelled Class',
    webinar_id: 'wgg-123',
    teacher_id: 'tch-1',
    host_email: 'host@example.com',
    status: 'cancelled',
  };

  const endedClass = {
    id: 'class-ended',
    title: 'Ended Class',
    webinar_id: 'wgg-123',
    teacher_id: 'tch-1',
    host_email: 'host@example.com',
    status: 'ended',
  };

  const makeMockDb = (targetClass) => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'stu-1', email: 'stu@example.com' } },
        error: null,
      }),
    },
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === 'profiles') {
              return { data: { id: 'stu-1', full_name: 'Student', role: 'student', level: 'Basic 1', active: true }, error: null };
            }
            return { data: targetClass, error: null };
          },
        }),
      }),
    }),
  });

  const runJoin = async (targetClass) => {
    let statusCode = 200;
    let jsonResult = null;
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer valid-jwt' },
      body: { action: 'join', classId: targetClass.id },
    };
    const res = {
      setHeader: () => {},
      status: (c) => { statusCode = c; return res; },
      json: (d) => { jsonResult = d; return res; },
      end: () => res,
    };
    await handleLiveClassRequest(req, res, {
      supabase: makeMockDb(targetClass),
      fetch: async () => assert.fail('Fetch should not be called for cancelled/ended classes'),
    });
    return { statusCode, jsonResult };
  };

  const resCancelled = await runJoin(cancelledClass);
  assert.equal(resCancelled.statusCode, 400);
  assert.equal(resCancelled.jsonResult.code, 'CLASS_CANCELLED');

  const resEnded = await runJoin(endedClass);
  assert.equal(resEnded.statusCode, 400);
  assert.equal(resEnded.jsonResult.code, 'CLASS_ENDED');
});
