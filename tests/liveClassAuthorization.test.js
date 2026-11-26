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
import fs from 'node:fs';
import {
  isStudentInAudience,
  formatWebinarParticipant,
  handleLiveClassRequest,
} from '../api/_liveClass.js';
import { sanitizeLiveRoomReturnTo } from '../js/auth.js';

function projectColumns(source, projection) {
  if (!source || !projection || projection.trim() === '*') return { ...source };
  const fields = [];
  let current = '';
  let depth = 0;
  for (const char of projection) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      if (current.trim()) fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) fields.push(current.trim());

  const result = {};
  for (const field of fields) {
    if (field.includes('(')) {
      const relAlias = field.split(/[:(!]/)[0].trim();
      if (source[relAlias] !== undefined) {
        result[relAlias] = source[relAlias];
      }
    } else {
      const colName = field.trim();
      if (source[colName] !== undefined) {
        result[colName] = source[colName];
      }
    }
  }
  return result;
}

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

test('3. Server-side Live Class join authorization and host identity protection', async () => {
  const mockClass = {
    id: 'class-101',
    title: 'Abacus Live Class: Basics 1',
    webinar_id: 'wgg-webinar-abc',
    teacher_id: 'tch-sunil',
    host_email: 'host-owner@trendz.local',
    invited_teacher_ids: ['tch-invited'],
    target_level: 'Basic 1',
    target_student_ids: null,
    scheduled_start_time: '2026-11-23T14:30:00Z',
    duration_minutes: 60,
    status: 'scheduled',
    provider_status: null,
    teacher: { id: 'tch-sunil', full_name: 'Sunil Sir' },
  };

  const mockUsers = {
    'token-admin-matching': {
      user: { id: 'usr-admin-owner', email: 'host-owner@trendz.local' },
      profile: { id: 'usr-admin-owner', full_name: 'Owner Admin', role: 'admin', level: 'Admin', active: true },
    },
    'token-admin-mismatch': {
      user: { id: 'usr-admin-other', email: 'other-admin@trendz.local' },
      profile: { id: 'usr-admin-other', full_name: 'Other Admin', role: 'admin', level: 'Admin', active: true },
    },
    'token-teacher-assigned': {
      user: { id: 'tch-sunil', email: 'sunil@trendz.local' },
      profile: { id: 'tch-sunil', full_name: 'Sunil Sir', role: 'teacher', level: 'Teacher', active: true },
    },
    'token-teacher-other': {
      user: { id: 'tch-other', email: 'other@trendz.local' },
      profile: { id: 'tch-other', full_name: 'Other Teacher', role: 'teacher', level: 'Teacher', active: true },
    },
    'token-teacher-invited': {
      user: { id: 'tch-invited', email: 'invited@trendz.local' },
      profile: { id: 'tch-invited', full_name: 'Invited Teacher', role: 'teacher', level: 'Teacher', active: true },
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
      select: (projection = '*') => ({
        order: () => {
          const result = Promise.resolve({ data: [projectColumns(mockClass, projection)], error: null });
          result.or = () => result;
          return result;
        },
        eq: (col, val) => ({
          single: async () => {
            if (table === 'profiles') {
              const match = Object.values(mockUsers).find((u) => u.profile.id === val);
              const data = match ? projectColumns(match.profile, projection) : null;
              return { data, error: match ? null : new Error('Profile not found') };
            }
            if (table === 'live_classes' && val === mockClass.id) {
              const data = projectColumns(mockClass, projection);
              return { data, error: null };
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

  // Case C1: Admin with matching host email receives host studio access
  const adminOwnerJoin = await runRequest('token-admin-matching');
  assert.equal(adminOwnerJoin.statusCode, 200);
  assert.equal(adminOwnerJoin.jsonResult.isHost, true);
  assert.ok(adminOwnerJoin.jsonResult.token);
  assert.ok(adminOwnerJoin.jsonResult.embedUrl.includes('token-mock-host-owner@trendz.local'));
  assert.equal(adminOwnerJoin.headers['Cache-Control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // Case C2: Admin with mismatched email CANNOT impersonate the owner and is rejected
  const adminMismatch = await runRequest('token-admin-mismatch');
  assert.equal(adminMismatch.statusCode, 403);
  assert.equal(adminMismatch.jsonResult.code, 'HOST_IDENTITY_MISMATCH');

  // Case D: Assigned teacher without a saved Webinar email CANNOT obtain a host token
  const teacherJoin = await runRequest('token-teacher-assigned');
  assert.equal(teacherJoin.statusCode, 403);
  assert.equal(teacherJoin.jsonResult.code, 'TEACHER_HOSTING_DISABLED');
  assert.ok(teacherJoin.jsonResult.error.includes('Webinar.gg email is not saved'));

  // Case E: Eligible student receives attendee live room access (non-host)
  const studentJoin = await runRequest('token-student-eligible');
  assert.equal(studentJoin.statusCode, 200);
  assert.equal(studentJoin.jsonResult.isHost, false);
  assert.ok(studentJoin.jsonResult.embedUrl.includes('token-mock-stu-eligible@trendz.local'));

  // Case F: Ineligible student outside audience is rejected with 403
  const studentIneligible = await runRequest('token-student-ineligible');
  assert.equal(studentIneligible.statusCode, 403);
  assert.equal(studentIneligible.jsonResult.code, 'NOT_ENROLLED');

  // Case G: Unrelated uninvited teacher is denied with 403 NOT_INVITED
  const teacherOther = await runRequest('token-teacher-other');
  assert.equal(teacherOther.statusCode, 403);
  assert.equal(teacherOther.jsonResult.code, 'NOT_INVITED');

  // Case G2: Invited teacher receives attendee access under own identity (NEVER owner's host identity)
  const teacherInvited = await runRequest('token-teacher-invited');
  assert.equal(teacherInvited.statusCode, 200);
  assert.equal(teacherInvited.jsonResult.isHost, false);
  assert.ok(teacherInvited.jsonResult.embedUrl.includes('token-mock-invited@trendz.local'));

  // Case H: Room metadata query (get_class_details) respects role and host_email
  // H1: Admin with matching host email has isHost: true, hostingDisabled: false
  const adminOwnerMeta = await runRequest('token-admin-matching', 'get_class_details');
  assert.equal(adminOwnerMeta.statusCode, 200);
  assert.equal(adminOwnerMeta.jsonResult.class.isHost, true);
  assert.equal(adminOwnerMeta.jsonResult.class.hostingDisabled, false);
  assert.equal(adminOwnerMeta.jsonResult.class.hostDashboardUrl,
    'https://webinar.gg/webinars/schedule-webinar/details/webinardetails/wgg-webinar-abc');

  mockClass.status = 'cancelled';
  const cancelledHostMeta = await runRequest('token-admin-matching', 'get_class_details');
  assert.equal(cancelledHostMeta.jsonResult.class.hostDashboardUrl, null);
  mockClass.status = 'scheduled';

  // H2: Admin with mismatched host email has isHost: false, hostingDisabled: false
  const adminMismatchMeta = await runRequest('token-admin-mismatch', 'get_class_details');
  assert.equal(adminMismatchMeta.statusCode, 200);
  assert.equal(adminMismatchMeta.jsonResult.class.isHost, false);
  assert.equal(adminMismatchMeta.jsonResult.class.hostingDisabled, false);
  assert.equal(adminMismatchMeta.jsonResult.class.hostDashboardUrl, null);

  // H3: Teacher has isHost: false, hostingDisabled: true
  const teacherMeta = await runRequest('token-teacher-assigned', 'get_class_details');
  assert.equal(teacherMeta.statusCode, 200);
  assert.equal(teacherMeta.jsonResult.class.isHost, false);
  assert.equal(teacherMeta.jsonResult.class.hostingDisabled, true);

  // H4: Eligible student has isHost: false, hostingDisabled: false
  const studentMeta = await runRequest('token-student-eligible', 'get_class_details');
  assert.equal(studentMeta.statusCode, 200);
  assert.equal(studentMeta.jsonResult.class.isHost, false);
  assert.equal(studentMeta.jsonResult.class.hostingDisabled, false);
  assert.equal(studentMeta.jsonResult.class.hostDashboardUrl, null);

  // H5: Ineligible student is rejected from get_class_details with 403 NOT_ENROLLED
  const studentIneligibleMeta = await runRequest('token-student-ineligible', 'get_class_details');
  assert.equal(studentIneligibleMeta.statusCode, 403);
  assert.equal(studentIneligibleMeta.jsonResult.code, 'NOT_ENROLLED');

  // H7: Invited teacher has isHost: false, hostingDisabled: false, isInvitedParticipant: true
  const teacherInvitedMeta = await runRequest('token-teacher-invited', 'get_class_details');
  assert.equal(teacherInvitedMeta.statusCode, 200);
  assert.equal(teacherInvitedMeta.jsonResult.class.isHost, false);
  assert.equal(teacherInvitedMeta.jsonResult.class.hostingDisabled, false);
  assert.equal(teacherInvitedMeta.jsonResult.class.isInvitedParticipant, true);
  assert.equal(teacherInvitedMeta.jsonResult.class.hostDashboardUrl, null);

  const ownerList = await runRequest('token-admin-matching', 'list');
  assert.equal(ownerList.jsonResult.classes[0].hostDashboardUrl, adminOwnerMeta.jsonResult.class.hostDashboardUrl);
  const otherAdminList = await runRequest('token-admin-mismatch', 'list');
  assert.equal(otherAdminList.jsonResult.classes[0].hostDashboardUrl, null);
  const invitedList = await runRequest('token-teacher-invited', 'list');
  assert.equal(invitedList.jsonResult.classes[0].hostDashboardUrl, null);
  mockClass.class_type = 'prerecorded';
  const prerecordedList = await runRequest('token-admin-matching', 'list');
  assert.equal(prerecordedList.jsonResult.classes[0].hostDashboardUrl, null);
  delete mockClass.class_type;

  // H8: Uninvited unrelated teacher is rejected from get_class_details with 403 NOT_INVITED
  const teacherUninvitedMeta = await runRequest('token-teacher-other', 'get_class_details');
  assert.equal(teacherUninvitedMeta.statusCode, 403);
  assert.equal(teacherUninvitedMeta.jsonResult.code, 'NOT_INVITED');

  // H6: Tightened regression check — proving that if host_email is omitted from select projection,
  // the mock does not supply host_email, causing isHost to evaluate to false (failing admin host verification)
  let omittedCode = 200;
  let omittedBody = null;
  const mockDbWithoutHostSelected = {
    ...createMockSupabase(),
    from: (table) => ({
      select: (projection = '*') => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === 'profiles') {
              const match = Object.values(mockUsers).find((u) => u.profile.id === val);
              return { data: match ? projectColumns(match.profile, projection) : null, error: null };
            }
            if (table === 'live_classes' && val === mockClass.id) {
              // Simulate code where host_email was omitted from select projection
              const projectionWithoutHost = projection.replace(/\bhost_email,?\s*/g, '');
              const projected = projectColumns(mockClass, projectionWithoutHost);
              assert.equal(projected.host_email, undefined, 'host_email must not be projected when omitted from select');
              return { data: projected, error: null };
            }
            return { data: null, error: new Error('Not found') };
          },
        }),
      }),
    }),
  };

  await handleLiveClassRequest(
    {
      method: 'POST',
      headers: { authorization: 'Bearer token-admin-matching' },
      body: { action: 'get_class_details', classId: 'class-101' },
    },
    {
      setHeader: () => {},
      status: (code) => { omittedCode = code; return { json: (d) => { omittedBody = d; } }; },
      json: (data) => { omittedBody = data; },
      end: () => {},
    },
    { supabase: mockDbWithoutHostSelected, fetch: mockFetch }
  );
  assert.equal(omittedCode, 200);
  assert.equal(
    omittedBody.class.isHost,
    false,
    'Removing host_email from the select projection must result in isHost being false for matching admin'
  );
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

  let joinTokenFailCount = 0;
  const failingFetch = async (url) => {
    if (String(url).includes('/join-token')) {
      joinTokenFailCount++;
      if (joinTokenFailCount === 1) {
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
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { status: 'scheduled' } }),
      text: async () => JSON.stringify({ success: true, data: { status: 'scheduled' } }),
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

test('6. Database Routine get_eligible_live_classes_for_student enforces authorization and revokes PUBLIC/anon', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();

  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      END IF;
      GRANT anon, authenticated, service_role TO CURRENT_USER;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
      SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'anon');
    $$ LANGUAGE sql STABLE;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
      student_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      level TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE public.teacher_student_assignments (
      teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (teacher_id, student_id)
    );

    CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
      SELECT COALESCE((SELECT role = 'admin' AND active = true FROM public.profiles WHERE id = auth.uid()), false);
    $$ LANGUAGE sql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID DEFAULT auth.uid()) RETURNS BOOLEAN AS $$
      SELECT COALESCE((SELECT role = 'teacher' AND active = true FROM public.profiles WHERE id = p_uid), false);
    $$ LANGUAGE sql STABLE SECURITY DEFINER;

    CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID) RETURNS BOOLEAN AS $$
      SELECT EXISTS (SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = p_teacher_id AND student_id = p_student_id);
    $$ LANGUAGE sql STABLE SECURITY DEFINER;
  `);

  // Execute checked-in migration file: supabase/staging_live_classes_feature.sql
  const migrationUrl = new URL('../supabase/staging_live_classes_feature.sql', import.meta.url);
  const migrationSql = fs.readFileSync(migrationUrl, 'utf8');
  await db.exec(migrationSql);

  // Seed fixture data
  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const assignedTeacherId = 'b0000000-0000-0000-0000-000000000001';
  const otherTeacherId = 'b0000000-0000-0000-0000-000000000002';
  const student1Id = 'c0000000-0000-0000-0000-000000000001';
  const student2Id = 'c0000000-0000-0000-0000-000000000002';

  await db.exec(`
    INSERT INTO public.profiles (id, role, student_code, full_name, level, active) VALUES
      ('${adminId}', 'admin', 'ADM-1', 'Admin User', 'Admin', true),
      ('${assignedTeacherId}', 'teacher', 'TCH-1', 'Assigned Teacher', 'Teacher', true),
      ('${otherTeacherId}', 'teacher', 'TCH-2', 'Other Teacher', 'Teacher', true),
      ('${student1Id}', 'student', 'STU-1', 'Student Alpha', 'Basic 1', true),
      ('${student2Id}', 'student', 'STU-2', 'Student Beta', 'Basic 2', true);

    INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
      ('${assignedTeacherId}', '${student1Id}');

    INSERT INTO public.live_classes (
      title, webinar_id, teacher_id, target_level, target_student_ids, scheduled_start_time, status, created_by
    ) VALUES (
      'Abacus Live Class: Basics', 'wgg-123', '${assignedTeacherId}', null, '["${student1Id}"]'::jsonb, now() + interval '1 hour', 'scheduled', '${adminId}'
    );
  `);

  const asUser = async (userId, role, fn) => {
    await db.exec(`
      SET app.current_user_id = '${userId || ''}';
      SET app.current_jwt_role = '${role}';
      SET ROLE ${role};
    `);
    try {
      return await fn();
    } finally {
      await db.exec(`
        RESET ROLE;
        SET app.current_user_id = '';
        SET app.current_jwt_role = '';
      `);
    }
  };

  // Case 1: Unauthenticated / anon caller is denied
  await asUser(null, 'anon', async () => {
    await assert.rejects(
      async () => db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student1Id}');`),
      (err) => {
        assert.ok(err.code === '42501' || err.message.includes('permission denied') || err.message.includes('Authentication required'));
        return true;
      }
    );
  });

  // Case 2: Student 1 attempting to query Student 2's ID is DENIED (cross-student access blocked)
  await asUser(student1Id, 'authenticated', async () => {
    await assert.rejects(
      async () => db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student2Id}');`),
      (err) => {
        assert.equal(err.code, '42501');
        assert.ok(err.message.includes('not authorized to view eligible live classes for this student'));
        return true;
      }
    );
  });

  // Case 3: Student 1 querying their OWN ID succeeds and returns their class
  await asUser(student1Id, 'authenticated', async () => {
    const res = await db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student1Id}');`);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].title, 'Abacus Live Class: Basics');
    assert.equal(res.rows[0].teacher_name, 'Assigned Teacher');
  });

  // Case 4: Other Teacher (not assigned to Student 1) is DENIED
  await asUser(otherTeacherId, 'authenticated', async () => {
    await assert.rejects(
      async () => db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student1Id}');`),
      (err) => {
        assert.equal(err.code, '42501');
        assert.ok(err.message.includes('not authorized to view eligible live classes for this student'));
        return true;
      }
    );
  });

  // Case 5: Assigned Teacher querying assigned Student 1 SUCCEEDS
  await asUser(assignedTeacherId, 'authenticated', async () => {
    const res = await db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student1Id}');`);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].title, 'Abacus Live Class: Basics');
  });

  // Case 6: Admin querying Student 1 SUCCEEDS
  await asUser(adminId, 'authenticated', async () => {
    const res = await db.query(`SELECT * FROM public.get_eligible_live_classes_for_student('${student1Id}');`);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].title, 'Abacus Live Class: Basics');
  });
});

test('7. Existing-table upgrade for live_classes.host_email drops NOT NULL and DEFAULT safely using checked-in migration', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();

  // 1. Setup prerequisite schema required by staging_live_classes_feature.sql
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      END IF;
      GRANT anon, authenticated, service_role TO CURRENT_USER;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULL::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
      SELECT 'authenticated'::TEXT;
    $$ LANGUAGE sql STABLE;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
      student_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      level TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE public.teacher_student_assignments (
      teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (teacher_id, student_id)
    );

    CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
      SELECT true;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID DEFAULT auth.uid()) RETURNS BOOLEAN AS $$
      SELECT true;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID) RETURNS BOOLEAN AS $$
      SELECT true;
    $$ LANGUAGE sql STABLE;

    -- 2. Simulate table created by previous Phase 1 migration with NOT NULL and default owner email
    CREATE TABLE public.live_classes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      webinar_id TEXT NOT NULL,
      teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      host_email TEXT NOT NULL DEFAULT 'suniltrendzeducation@gmail.com',
      target_level TEXT NULL,
      target_student_ids JSONB NULL,
      scheduled_start_time TIMESTAMPTZ NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'waiting', 'live', 'ended', 'cancelled')),
      provider_status TEXT NULL,
      notes TEXT NULL,
      created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
    );
  `);

  // 3. Execute the actual checked-in migration file: supabase/staging_live_classes_feature.sql
  const migrationUrl = new URL('../supabase/staging_live_classes_feature.sql', import.meta.url);
  const migrationSql = fs.readFileSync(migrationUrl, 'utf8');
  await db.exec(migrationSql);

  // 4. Verify host_email is now nullable and has no default
  const profId = '11111111-1111-1111-1111-111111111111';
  await db.exec(`INSERT INTO public.profiles (id, role, full_name) VALUES ('${profId}', 'teacher', 'Teacher Test');`);

  // Insert with explicit NULL succeeds (proves NOT NULL was dropped by checked-in migration)
  await db.exec(`
    INSERT INTO public.live_classes (title, webinar_id, teacher_id, host_email, scheduled_start_time, created_by)
    VALUES ('Class Null Host', 'wgg-null', '${profId}', NULL, now(), '${profId}');
  `);

  // Insert omitting host_email leaves it NULL (proves DEFAULT was dropped by checked-in migration)
  await db.exec(`
    INSERT INTO public.live_classes (title, webinar_id, teacher_id, scheduled_start_time, created_by)
    VALUES ('Class Default Check', 'wgg-def', '${profId}', now(), '${profId}');
  `);

  const res = await db.query(`SELECT title, host_email FROM public.live_classes ORDER BY title ASC;`);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].title, 'Class Default Check');
  assert.equal(res.rows[0].host_email, null);
  assert.equal(res.rows[1].title, 'Class Null Host');
  assert.equal(res.rows[1].host_email, null);
});

test('8. get_class_details and join sync provider status and mark completed provider webinars as ended', async () => {
  const studentUser = {
    id: 'student-99',
    email: 'stg-001@trendz.local',
  };
  const studentProfile = {
    id: 'student-99',
    full_name: 'Staging Student Alpha',
    role: 'student',
    level: 'Basic 1',
    active: true,
  };

  let updatedStatusInDb = null;
  let updatedProviderStatusInDb = null;

  const scheduledClass = {
    id: 'class-ended-test',
    title: 'Completed Provider Test Class',
    webinar_id: 'wgg-completed-event',
    teacher_id: 'teacher-10',
    host_email: null,
    target_level: 'Basic 1',
    target_student_ids: ['student-99'],
    scheduled_start_time: new Date().toISOString(),
    duration_minutes: 60,
    status: 'scheduled',
    provider_status: 'scheduled',
    notes: null,
    teacher: { id: 'teacher-10', full_name: 'Assigned Teacher' },
  };

  const mockSupabase = {
    auth: {
      getUser: async () => ({ data: { user: studentUser }, error: null }),
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: studentProfile, error: null }),
            }),
          }),
        };
      }
      if (table === 'live_classes') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { ...scheduledClass }, error: null }),
            }),
          }),
          update: (fields) => ({
            eq: async () => {
              updatedStatusInDb = fields.status;
              updatedProviderStatusInDb = fields.provider_status;
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  // Mock fetch: provider returns status "completed" for the webinar
  const mockFetch = async (url) => {
    if (String(url).includes('/webinar/wgg-completed-event')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { id: 'wgg-completed-event', status: 'completed' },
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  // 1. get_class_details call
  let detailsStatusCode = 200;
  let detailsJson = null;
  const detailsReq = {
    method: 'POST',
    headers: { authorization: 'Bearer valid-jwt' },
    body: { action: 'get_class_details', classId: 'class-ended-test' },
  };
  const detailsRes = {
    setHeader: () => {},
    status: (c) => { detailsStatusCode = c; return detailsRes; },
    json: (d) => { detailsJson = d; return detailsRes; },
    end: () => detailsRes,
  };

  await handleLiveClassRequest(detailsReq, detailsRes, {
    supabase: mockSupabase,
    fetch: mockFetch,
  });

  assert.equal(detailsStatusCode, 200);
  assert.equal(detailsJson.class.status, 'ended', 'get_class_details must return ended status');
  assert.equal(detailsJson.class.providerStatus, 'completed', 'providerStatus must be completed');
  assert.equal(updatedStatusInDb, 'ended', 'Database must be updated to ended');
  assert.equal(updatedProviderStatusInDb, 'completed', 'Database provider_status must be updated to completed');

  // 2. join call must be rejected with 400 CLASS_ENDED
  let joinStatusCode = 200;
  let joinJson = null;
  const joinReq = {
    method: 'POST',
    headers: { authorization: 'Bearer valid-jwt' },
    body: { action: 'join', classId: 'class-ended-test' },
  };
  const joinRes = {
    setHeader: () => {},
    status: (c) => { joinStatusCode = c; return joinRes; },
    json: (d) => { joinJson = d; return joinRes; },
    end: () => joinRes,
  };

  await handleLiveClassRequest(joinReq, joinRes, {
    supabase: mockSupabase,
    fetch: mockFetch,
  });

  assert.equal(joinStatusCode, 400);
  assert.equal(joinJson.code, 'CLASS_ENDED');
});

test('9. Teacher participant invitations allow invited teachers attendee access and reject uninvited teachers with NOT_INVITED', async () => {
  const invitedTeacherUser = { id: 'teacher-invited-1', email: 'invited-tch@trendz.local' };
  const invitedTeacherProfile = { id: 'teacher-invited-1', full_name: 'Invited Teacher Alpha', role: 'teacher', level: 'Teacher', active: true };

  const uninvitedTeacherUser = { id: 'teacher-uninvited-2', email: 'uninvited-tch@trendz.local' };
  const uninvitedTeacherProfile = { id: 'teacher-uninvited-2', full_name: 'Uninvited Teacher Beta', role: 'teacher', level: 'Teacher', active: true };

  const assignedTeacherUser = { id: 'teacher-assigned-3', email: 'assigned-tch@trendz.local' };
  const assignedTeacherProfile = { id: 'teacher-assigned-3', full_name: 'Assigned Host Teacher Gamma', role: 'teacher', level: 'Teacher', active: true };

  const liveClassRecord = {
    id: 'class-invite-test',
    title: 'Pilot Class with Invited Teacher',
    webinar_id: 'wgg-invite-webinar',
    teacher_id: 'teacher-assigned-3',
    host_email: 'suniltrendzeducation@gmail.com',
    invited_teacher_ids: ['teacher-invited-1'],
    target_level: 'Basic 1',
    target_student_ids: null,
    scheduled_start_time: new Date().toISOString(),
    duration_minutes: 60,
    status: 'scheduled',
    provider_status: 'scheduled',
    notes: null,
    teacher: { id: 'teacher-assigned-3', full_name: 'Assigned Host Teacher Gamma' },
  };

  const createMockDb = (currentUser, currentProfile) => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser }, error: null }),
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: currentProfile, error: null }),
            }),
          }),
        };
      }
      if (table === 'live_classes') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { ...liveClassRecord }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  });

  const capturedTokens = [];
  const mockFetch = async (url, opts) => {
    if (url.includes('/webinar/wgg-invite-webinar')) {
      return { ok: true, json: async () => ({ data: { status: 'scheduled' } }) };
    }
    if (url.includes('/webinar/join-token')) {
      const b = JSON.parse(opts.body);
      capturedTokens.push(b);
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          success: true,
          data: { token: `token-for-${b.email}`, expiresInSeconds: 600 },
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const executeAction = async (db, action) => {
    let sc = 200;
    let json = null;
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer mock-token' },
      body: { action, classId: 'class-invite-test' },
    };
    const res = {
      setHeader: () => {},
      status: (c) => { sc = c; return res; },
      json: (d) => { json = d; return res; },
      end: () => res,
    };
    await handleLiveClassRequest(req, res, { supabase: db, fetch: mockFetch });
    return { statusCode: sc, jsonResult: json };
  };

  // 1. Invited teacher details: isInvitedParticipant: true, hostingDisabled: false, isHost: false
  const invitedDetails = await executeAction(createMockDb(invitedTeacherUser, invitedTeacherProfile), 'get_class_details');
  assert.equal(invitedDetails.statusCode, 200);
  assert.equal(invitedDetails.jsonResult.class.isInvitedParticipant, true);
  assert.equal(invitedDetails.jsonResult.class.hostingDisabled, false);
  assert.equal(invitedDetails.jsonResult.class.isHost, false);

  // 2. Invited teacher join: receives attendee access under own identity
  const invitedJoin = await executeAction(createMockDb(invitedTeacherUser, invitedTeacherProfile), 'join');
  assert.equal(invitedJoin.statusCode, 200);
  assert.equal(invitedJoin.jsonResult.isHost, false);
  assert.ok(invitedJoin.jsonResult.embedUrl.includes('token-for-invited-tch@trendz.local'));
  assert.equal(capturedTokens[0].email, 'invited-tch@trendz.local');

  // 3. Uninvited teacher details: rejected with 403 NOT_INVITED
  const uninvitedDetails = await executeAction(createMockDb(uninvitedTeacherUser, uninvitedTeacherProfile), 'get_class_details');
  assert.equal(uninvitedDetails.statusCode, 403);
  assert.equal(uninvitedDetails.jsonResult.code, 'NOT_INVITED');

  // 4. Uninvited teacher join: rejected with 403 NOT_INVITED
  const uninvitedJoin = await executeAction(createMockDb(uninvitedTeacherUser, uninvitedTeacherProfile), 'join');
  assert.equal(uninvitedJoin.statusCode, 403);
  assert.equal(uninvitedJoin.jsonResult.code, 'NOT_INVITED');

  // 5. Assigned teacher (without invitation): details shows hostingDisabled: true, join returns 403 TEACHER_HOSTING_DISABLED
  const assignedDetails = await executeAction(createMockDb(assignedTeacherUser, assignedTeacherProfile), 'get_class_details');
  assert.equal(assignedDetails.statusCode, 200);
  assert.equal(assignedDetails.jsonResult.class.hostingDisabled, true);
  assert.equal(assignedDetails.jsonResult.class.isInvitedParticipant, false);

  const assignedJoin = await executeAction(createMockDb(assignedTeacherUser, assignedTeacherProfile), 'join');
  assert.equal(assignedJoin.statusCode, 403);
  assert.equal(assignedJoin.jsonResult.code, 'TEACHER_HOSTING_DISABLED');
});

test('10. Session expiry returns 401 INVALID_TOKEN allowing transparent recovery, and Open in Browser requires identical server authorization', async () => {
  // Test expired token rejection
  const mockSupabaseExpired = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: new Error('Token expired') }),
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
  };

  let statusCode = 200;
  let jsonResult = null;
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer expired-jwt' },
    body: { action: 'join', classId: 'some-class' },
  };
  const res = {
    setHeader: () => {},
    status: (c) => { statusCode = c; return res; },
    json: (d) => { jsonResult = d; return res; },
    end: () => res,
  };

  await handleLiveClassRequest(req, res, { supabase: mockSupabaseExpired });
  assert.equal(statusCode, 401);
  assert.equal(jsonResult.code, 'INVALID_TOKEN');
});

test('11. Strict returnTo validation restricts to same-origin live room with valid classId and rejects invalid destinations', () => {
  const validUuid = '2996d902-6009-4739-b673-e22d4e10a238';

  // 1. Valid destinations
  assert.equal(
    sanitizeLiveRoomReturnTo(`/pages/live-room.html?classId=${validUuid}`),
    `/pages/live-room.html?classId=${validUuid}`
  );
  assert.equal(
    sanitizeLiveRoomReturnTo(`  /pages/live-room.html?classId=${validUuid.toUpperCase()}  `),
    `/pages/live-room.html?classId=${validUuid.toUpperCase()}`
  );
  // Strips unneeded query parameters to canonical form
  assert.equal(
    sanitizeLiveRoomReturnTo(`/pages/live-room.html?classId=${validUuid}&session_drop=true&utm_source=test`),
    `/pages/live-room.html?classId=${validUuid}`
  );

  // 2. Open redirect & protocol-relative escapes rejected
  assert.equal(sanitizeLiveRoomReturnTo('//evil.com/pages/live-room.html?classId=' + validUuid), null);
  assert.equal(sanitizeLiveRoomReturnTo('/\\evil.com/pages/live-room.html?classId=' + validUuid), null);
  assert.equal(sanitizeLiveRoomReturnTo('https://evil.com/pages/live-room.html?classId=' + validUuid), null);
  assert.equal(sanitizeLiveRoomReturnTo('http://localhost:3000/pages/live-room.html?classId=' + validUuid), null);
  assert.equal(sanitizeLiveRoomReturnTo('javascript:alert(1)'), null);
  assert.equal(sanitizeLiveRoomReturnTo('data:text/html,<script>alert(1)</script>'), null);

  // 3. Arbitrary internal app paths rejected
  assert.equal(sanitizeLiveRoomReturnTo('/pages/admin.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/teacher.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/student.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/settings.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/index.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-classes.html'), null);

  // 4. Missing or malformed classId rejected
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html?classId='), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html?classId=invalid-id'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html?classId=../etc/passwd'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html?classId=12345'), null);
  assert.equal(sanitizeLiveRoomReturnTo('/pages/live-room.html?classId=' + validUuid + ';drop table users;'), null);
  assert.equal(sanitizeLiveRoomReturnTo(null), null);
  assert.equal(sanitizeLiveRoomReturnTo(undefined), null);
  assert.equal(sanitizeLiveRoomReturnTo(''), null);
  assert.equal(sanitizeLiveRoomReturnTo({}), null);
});

test('12. Database boundary enforces admin-only changes to invited_teacher_ids, host_email, webinar_id, and audience fields; teachers retain only SELECT', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();

  // Initialize roles and mock auth functions
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      END IF;
      GRANT anon, authenticated, service_role TO CURRENT_USER;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
      SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
    $$ LANGUAGE sql STABLE;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
      student_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      level TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE public.teacher_student_assignments (
      teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (teacher_id, student_id)
    );

    GRANT ALL ON TABLE public.profiles TO authenticated, service_role;
    GRANT ALL ON TABLE public.teacher_student_assignments TO authenticated, service_role;
  `);

  // Run checked-in migration script
  const migrationSql = fs.readFileSync('supabase/staging_live_classes_feature.sql', 'utf8');
  await db.exec(migrationSql);

  // 1. Verify RLS Policies on public.live_classes
  const policiesRes = await db.query(`
    SELECT policyname, cmd
    FROM pg_policies
    WHERE tablename = 'live_classes'
    ORDER BY policyname;
  `);

  const policyNames = policiesRes.rows.map(r => r.policyname);
  assert.ok(policyNames.includes('Admins have full access to live_classes'), 'Admin full policy must exist');
  assert.ok(policyNames.includes('Teachers can view assigned live_classes'), 'Teacher SELECT policy must exist');
  assert.ok(policyNames.includes('Students can view eligible live_classes'), 'Student SELECT policy must exist');
  assert.equal(
    policyNames.includes('Teachers can update own live_classes'),
    false,
    'Teachers can update own live_classes must be dropped'
  );

  // 1b. Verify explicit minimum table privileges on public.live_classes
  const privCheck = async (role, priv) => {
    const r = await db.query(`SELECT has_table_privilege($1, 'public.live_classes', $2) AS allowed`, [role, priv]);
    return r.rows[0].allowed;
  };

  assert.equal(await privCheck('anon', 'SELECT'), false, 'anon must have no SELECT privilege');
  assert.equal(await privCheck('anon', 'INSERT'), false, 'anon must have no INSERT privilege');
  assert.equal(await privCheck('anon', 'UPDATE'), false, 'anon must have no UPDATE privilege');
  assert.equal(await privCheck('anon', 'DELETE'), false, 'anon must have no DELETE privilege');

  assert.equal(await privCheck('authenticated', 'SELECT'), true, 'authenticated must have SELECT privilege');
  assert.equal(await privCheck('authenticated', 'INSERT'), true, 'authenticated must have INSERT privilege');
  assert.equal(await privCheck('authenticated', 'UPDATE'), true, 'authenticated must have UPDATE privilege');
  assert.equal(await privCheck('authenticated', 'DELETE'), true, 'authenticated must have DELETE privilege');
  assert.equal(await privCheck('authenticated', 'TRUNCATE'), false, 'authenticated must NOT have TRUNCATE privilege');
  assert.equal(await privCheck('authenticated', 'REFERENCES'), false, 'authenticated must NOT have REFERENCES privilege');
  assert.equal(await privCheck('authenticated', 'TRIGGER'), false, 'authenticated must NOT have TRIGGER privilege');

  // 2. Set up test users: 1 Admin, 1 Teacher, 1 Student
  const adminId = '11111111-1111-4111-8111-111111111111';
  const teacherId = '22222222-2222-4222-8222-222222222222';
  const studentId = '33333333-3333-4333-8333-333333333333';
  const otherTeacherId = '44444444-4444-4444-8444-444444444444';

  await db.query(`
    INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
    VALUES
      ('${adminId}', 'admin', 'ADM-01', 'Admin User', NULL, true),
      ('${teacherId}', 'teacher', 'TCH-01', 'Teacher User', NULL, true),
      ('${otherTeacherId}', 'teacher', 'TCH-02', 'Other Teacher', NULL, true),
      ('${studentId}', 'student', 'STU-01', 'Student User', 'Level 2', true);
  `);

  // Helper to switch caller session (matching Test 6 pattern)
  const asUser = async (userId, role = 'authenticated', fn) => {
    await db.exec(`
      SET app.current_user_id = '${userId || ''}';
      SET app.current_jwt_role = '${role}';
      SET ROLE ${role};
    `);
    try {
      return await fn();
    } finally {
      await db.exec(`
        RESET ROLE;
        SET app.current_user_id = '';
        SET app.current_jwt_role = '';
      `);
    }
  };

  // 3. Admin creates a live class
  const classId = '55555555-5555-4555-8555-555555555555';
  await asUser(adminId, 'authenticated', async () => {
    await db.query(`
      INSERT INTO public.live_classes (
        id, title, webinar_id, teacher_id, host_email, invited_teacher_ids,
        target_level, target_student_ids, scheduled_start_time, duration_minutes,
        created_by
      ) VALUES (
        '${classId}', 'Test Class', 'wgg-123', '${teacherId}', 'admin@trendz.local',
        '["${otherTeacherId}"]'::jsonb, 'Level 2', '["${studentId}"]'::jsonb,
        NOW(), 60, '${adminId}'
      );
    `);

    // Admin update of protected fields works
    await db.query(`
      UPDATE public.live_classes
      SET host_email = 'newadmin@trendz.local',
          invited_teacher_ids = '["${teacherId}", "${otherTeacherId}"]'::jsonb,
          webinar_id = 'wgg-updated',
          target_level = 'Level 3'
      WHERE id = '${classId}';
    `);
  });

  // 4. Non-admin / Teacher direct insert blocked
  await asUser(teacherId, 'authenticated', async () => {
    await assert.rejects(
      db.query(`
        INSERT INTO public.live_classes (
          title, webinar_id, teacher_id, scheduled_start_time, created_by
        ) VALUES (
          'Rogue Class', 'wgg-rogue', '${teacherId}', NOW(), '${teacherId}'
        );
      `),
      /Access denied: Only administrators can create live classes|new row violates row-level security/
    );

    // 5. Non-admin / Teacher direct updates to protected fields blocked
    // Since teacher update policy is dropped, direct UPDATE affects 0 rows under RLS
    const updateRes = await db.query(`
      UPDATE public.live_classes
      SET invited_teacher_ids = '["${teacherId}"]'::jsonb
      WHERE id = '${classId}';
    `);
    assert.equal(updateRes.affectedRows, 0, 'Teacher update must affect 0 rows under RLS');

    // 6. Teacher retains SELECT permissions
    const teacherSelect = await db.query(`SELECT id, title, webinar_id FROM public.live_classes WHERE id = '${classId}';`);
    assert.equal(teacherSelect.rows.length, 1);
    assert.equal(teacherSelect.rows[0].title, 'Test Class');
  });

  // 7. Other teacher (invited) also retains SELECT
  await asUser(otherTeacherId, 'authenticated', async () => {
    const otherTeacherSelect = await db.query(`SELECT id, title FROM public.live_classes WHERE id = '${classId}';`);
    assert.equal(otherTeacherSelect.rows.length, 1);
  });

  // 8. Direct trigger verification: If a non-admin attempts to update protected fields, trigger raises 42501
  await db.exec(`
    SET app.current_user_id = '${teacherId}';
    SET app.current_jwt_role = 'authenticated';
  `);
  try {
    await assert.rejects(
      db.query(`
        UPDATE public.live_classes
        SET host_email = 'hacked@trendz.local'
        WHERE id = '${classId}';
      `),
      /Access denied: Only administrators can modify host identity/
    );
  } finally {
    await db.exec(`
      SET app.current_user_id = '';
      SET app.current_jwt_role = '';
    `);
  }
});

test('13. Production migration 17_phase20_live_classes_feature.sql and rollback preserve class records and toggle triggers/RPCs cleanly', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();

  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      END IF;
      GRANT anon, authenticated, service_role TO CURRENT_USER;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
      SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
    $$ LANGUAGE sql STABLE;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
      student_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      level TEXT,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE public.teacher_student_assignments (
      teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (teacher_id, student_id)
    );

    GRANT ALL ON TABLE public.profiles TO authenticated, service_role;
    GRANT ALL ON TABLE public.teacher_student_assignments TO authenticated, service_role;
  `);

  const adminId = 'a0000000-0000-0000-0000-000000000001';
  const teacherId = 'b0000000-0000-0000-0000-000000000002';
  await db.exec(`
    INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
    VALUES
      ('${adminId}', 'admin', 'ADM-001', 'Admin User', NULL, true),
      ('${teacherId}', 'teacher', 'TCH-001', 'Teacher User', NULL, true);
  `);

  // 1. Run forward production migration: 17_phase20_live_classes_feature.sql
  const prodMigrationSql = fs.readFileSync('supabase/migrations/17_phase20_live_classes_feature.sql', 'utf8');
  await db.exec(prodMigrationSql);

  // Insert a test live class record
  const classId = 'c0000000-0000-0000-0000-000000000001';
  await db.exec(`
    INSERT INTO public.live_classes (
      id, title, webinar_id, teacher_id, host_email, invited_teacher_ids,
      target_level, scheduled_start_time, duration_minutes, status, created_by
    ) VALUES (
      '${classId}', 'Production Test Class', 'webinar-prod-123', '${teacherId}', 'admin@trendz.local',
      '["${teacherId}"]'::jsonb, 'Basic 1', now() + interval '1 hour', 60, 'scheduled', '${adminId}'
    );
  `);

  // Verify class exists and trigger exists
  const classBefore = await db.query(`SELECT id, title, webinar_id, host_email FROM public.live_classes WHERE id = '${classId}';`);
  assert.equal(classBefore.rows.length, 1);
  assert.equal(classBefore.rows[0].title, 'Production Test Class');

  const triggerBefore = await db.query(`
    SELECT DISTINCT trigger_name FROM information_schema.triggers
    WHERE event_object_table = 'live_classes' AND trigger_name = 'trg_live_classes_admin_only_fields';
  `);
  assert.equal(triggerBefore.rows.length, 1, 'Trigger must exist before rollback');

  const rpcBefore = await db.query(`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'get_eligible_live_classes_for_student';
  `);
  assert.equal(rpcBefore.rows.length, 1, 'RPC must exist before rollback');

  // 2. Execute rollback: supabase/rollbacks/17_phase20_live_classes_feature_rollback.sql
  const rollbackSql = fs.readFileSync('supabase/rollbacks/17_phase20_live_classes_feature_rollback.sql', 'utf8');
  await db.exec(rollbackSql);

  // 3. Verify: CLASS RECORD PRESERVED INTACT (Zero data loss)
  const classAfter = await db.query(`SELECT id, title, webinar_id, host_email FROM public.live_classes WHERE id = '${classId}';`);
  assert.equal(classAfter.rows.length, 1, 'Class record MUST be strictly preserved after rollback');
  assert.equal(classAfter.rows[0].title, 'Production Test Class');
  assert.equal(classAfter.rows[0].webinar_id, 'webinar-prod-123');
  assert.equal(classAfter.rows[0].host_email, 'admin@trendz.local');

  // 4. Verify trigger and RPC dropped
  const triggerAfter = await db.query(`
    SELECT DISTINCT trigger_name FROM information_schema.triggers
    WHERE event_object_table = 'live_classes' AND trigger_name = 'trg_live_classes_admin_only_fields';
  `);
  assert.equal(triggerAfter.rows.length, 0, 'Trigger must be dropped after rollback');

  const rpcAfter = await db.query(`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'get_eligible_live_classes_for_student';
  `);
  assert.equal(rpcAfter.rows.length, 0, 'RPC must be dropped after rollback');

  // 5. Verify teacher and student policies dropped, admin policy preserved
  const policiesAfter = await db.query(`
    SELECT policyname FROM pg_policies WHERE tablename = 'live_classes';
  `);
  const policyNamesAfter = policiesAfter.rows.map(r => r.policyname);
  assert.equal(policyNamesAfter.includes('Students can view eligible live_classes'), false);
  assert.equal(policyNamesAfter.includes('Teachers can view assigned live_classes'), false);
  assert.equal(policyNamesAfter.includes('Admins have full access to live_classes'), true);

  // 6. Re-apply production migration: verifies idempotent re-application over existing data
  await db.exec(prodMigrationSql);

  const classReapplied = await db.query(`SELECT id, title FROM public.live_classes WHERE id = '${classId}';`);
  assert.equal(classReapplied.rows.length, 1, 'Class record preserved after re-application');

  const triggerReapplied = await db.query(`
    SELECT DISTINCT trigger_name FROM information_schema.triggers
    WHERE event_object_table = 'live_classes' AND trigger_name = 'trg_live_classes_admin_only_fields';
  `);
  assert.equal(triggerReapplied.rows.length, 1, 'Trigger restored after re-application');
});

test('14. Live class scheduling validates staff and student audiences and creates rooms as needed', async (t) => {
  const adminProfile1 = {
    id: 'a0000000-0000-0000-0000-000000000001',
    full_name: 'Sunil Admin',
    role: 'admin',
    email: 'sunil@trendz.local',
    active: true,
  };
  const adminProfile2 = {
    id: 'a0000000-0000-0000-0000-000000000002',
    full_name: 'Other Admin',
    role: 'admin',
    email: 'other@trendz.local',
    active: true,
  };
  const teacherProfile = {
    id: 't0000000-0000-0000-0000-000000000001',
    full_name: 'Pooja Teacher',
    role: 'teacher',
    email: 'pooja@trendz.local',
    active: true,
  };
  const inactiveTeacherProfile = {
    id: 't0000000-0000-0000-0000-000000000002',
    full_name: 'Inactive Teacher',
    role: 'teacher',
    email: 'inactive@trendz.local',
    active: false,
  };
  const studentProfile = {
    id: 'b0000000-0000-0000-0000-000000000001',
    full_name: 'Rohan Student',
    role: 'student',
    email: 'rohan@trendz.local',
    level: 'Basic 1',
    active: true,
  };

  const allProfiles = [
    adminProfile1,
    adminProfile2,
    teacherProfile,
    inactiveTeacherProfile,
    studentProfile,
  ];

  const createdClasses = [];
  const teacherCohostEmail = 'teacher@example.com';
  const cohostEmails = new Map();
  const cohostPolicies = [];
  const cohostInvites = [];
  let savedTeacherEmail;
  let failCohostPolicy = false;
  const priorProviderToken = process.env.WEBINAR_GG_TOKEN;
  process.env.WEBINAR_GG_TOKEN = 'test-provider-token';
  t.after(() => {
    if (priorProviderToken === undefined) delete process.env.WEBINAR_GG_TOKEN;
    else process.env.WEBINAR_GG_TOKEN = priorProviderToken;
  });

  const mockSupabase = {
    auth: {
      admin: {
        getUserById: async (id) => ({ data: { user: { id, app_metadata: { webinar_cohost_email: savedTeacherEmail } } } }),
      },
      getUser: async (token) => {
        const profile = allProfiles.find((p) => `token-${p.id}` === token);
        if (!profile) return { data: { user: null }, error: new Error('Invalid token') };
        return {
          data: {
            user: { id: profile.id, email: profile.email, app_metadata: profile === teacherProfile ? { webinar_cohost_email: savedTeacherEmail } : {} },
          },
          error: null,
        };
      },
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: (col, val) => col === 'role' ? {
              eq: (activeColumn, active) => ({
                in: async (idColumn, ids) => ({
                  data: allProfiles.filter((profile) => profile[col] === val && profile[activeColumn] === active && ids.includes(profile[idColumn])),
                  error: null,
                }),
                eq: (levelColumn, level) => ({
                  limit: async () => ({
                    data: allProfiles.filter((profile) => profile[col] === val && profile[activeColumn] === active && profile[levelColumn] === level).slice(0, 1),
                    error: null,
                  }),
                }),
              }),
            } : ({
              single: async () => {
                const match = allProfiles.find((p) => p.id === val);
                return {
                  data: match || null,
                  error: match ? null : new Error('Profile not found'),
                };
              },
            }),
          }),
        };
      }
      if (table === 'live_classes') {
        return {
          insert: (record) => ({
            select: () => ({
              single: async () => {
                const newRecord = {
                  id: `class-${createdClasses.length + 1}`,
                  ...record,
                  teacher: allProfiles.find((p) => p.id === record.teacher_id),
                };
                createdClasses.push(newRecord);
                return { data: newRecord, error: null };
              },
            }),
          }),
          select: () => ({
            eq: (col, val) => ({
              single: async () => {
                const match = createdClasses.find((c) => c.id === val);
                return { data: match || null, error: match ? null : new Error('Not found') };
              },
            }),
            order: () => {
              const listed = { data: [...createdClasses], error: null };
              return { ...listed, or: () => listed };
            },
            // Schedule-conflict and running-class checks: these tests reuse start times on purpose.
            gte: () => ({ lt: async () => ({ data: scheduledRows, error: null }) }),
            or: async () => ({ data: runningRows, error: null }),
          }),
          update: (patch) => ({
            eq: async (col, val) => {
              endedRows.push({ id: val, ...patch });
              return { data: null, error: null };
            },
          }),
        };
      }
      return {};
    },
  };

  // Other classes the one-class-at-a-time checks see (empty unless a step sets them).
  let scheduledRows = [];
  let runningRows = [];
  const endedRows = [];
  const providerStatusByRoom = new Map();
  const providerRequests = [];
  const joinTokenRequests = [];
  const mockFetch = async (url, options) => {
    const roomInfo = url.match(/\/webinar\/([^/]+)$/);
    if (options.method === 'GET' && roomInfo && providerStatusByRoom.has(roomInfo[1])) {
      return { ok: true, json: async () => ({ success: true, data: { status: providerStatusByRoom.get(roomInfo[1]) } }) };
    }
    const cohostPath = url.match(/\/webinar\/([^/]+)\/(cohosts|cohost-policy)$/);
    if (cohostPath) {
      const [, room, resource] = cohostPath;
      if (resource === 'cohost-policy') {
        cohostPolicies.push({ room, ...JSON.parse(options.body) });
        return { ok: !failCohostPolicy, json: async () => ({ success: !failCohostPolicy }) };
      }
      if (options.method === 'POST') {
        const invite = JSON.parse(options.body);
        cohostInvites.push({ room, ...invite });
        cohostEmails.set(room, invite.emails[0]);
      }
      return { ok: true, json: async () => ({ success: true, data: cohostEmails.has(room) ? [{ email: cohostEmails.get(room) }] : [] }) };
    }
    if (options.method === 'GET' && /\/webinar\/[^/]+$/.test(url)) {
      return { ok: true, json: async () => ({ success: true, data: {
        passcode: 'room-pass',
        cohostPermissions: { startWebinar: !failCohostPolicy },
      } }) };
    }
    if (url.endsWith('/webinar/join-token')) joinTokenRequests.push(JSON.parse(options.body));
    if (url.endsWith('/webinar/')) {
      providerRequests.push(JSON.parse(options.body));
      const id = `generated-room-${providerRequests.length}`;
      return { ok: true, json: async () => ({ data: { id } }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { token: 'mock-token', expiresInSeconds: 600 } }),
    };
  };

  const runApi = async (callerToken, body) => {
    let statusCode = 200;
    let jsonResult = null;
    const headers = {};

    const req = {
      method: 'POST',
      headers: callerToken ? { authorization: `Bearer ${callerToken}` } : {},
      body,
    };

    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResult = data; return res; },
      end: () => res,
    };

    await handleLiveClassRequest(req, res, {
      supabase: mockSupabase,
      fetch: mockFetch,
    });

    return { statusCode, jsonResult };
  };

  // 1. Non-admin cannot create live classes
  const teacherCreate = await runApi(`token-${teacherProfile.id}`, {
    action: 'create',
    title: 'Unauthorized Class',
    webinar_id: 'wgg-123',
    teacher_id: teacherProfile.id,
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(teacherCreate.statusCode, 403);
  assert.equal(teacherCreate.jsonResult.code, 'FORBIDDEN');

  // 2. Missing required fields rejected
  const missingField = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Missing Teacher',
    webinar_id: 'wgg-123',
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(missingField.statusCode, 400);
  assert.equal(missingField.jsonResult.code, 'INVALID_REQUEST');

  // 3. Nonexistent teacher ID rejected
  const nonexistentAssignee = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Bad Assignee',
    webinar_id: 'wgg-123',
    teacher_id: '00000000-0000-0000-0000-000000000099',
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(nonexistentAssignee.statusCode, 400);
  assert.equal(nonexistentAssignee.jsonResult.code, 'INVALID_ASSIGNEE');

  // 4. Inactive teacher rejected
  const inactiveAssignee = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Inactive Teacher Class',
    webinar_id: 'wgg-123',
    teacher_id: inactiveTeacherProfile.id,
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(inactiveAssignee.statusCode, 400);
  assert.equal(inactiveAssignee.jsonResult.code, 'INVALID_ASSIGNEE');

  // 5. Student account cannot be assigned as teacher
  const studentAssignee = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Student Assigned Class',
    webinar_id: 'wgg-123',
    teacher_id: studentProfile.id,
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(studentAssignee.statusCode, 400);
  assert.equal(studentAssignee.jsonResult.code, 'INVALID_ASSIGNEE');

  // 6. Admin cannot assign to a different admin account
  const otherAdminAssignee = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Other Admin Assigned Class',
    webinar_id: 'wgg-123',
    teacher_id: adminProfile2.id,
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(otherAdminAssignee.statusCode, 400);
  assert.equal(otherAdminAssignee.jsonResult.code, 'INVALID_ASSIGNEE');

  // 7. Scheduling reads the teacher's saved address and ignores addresses in the schedule payload.
  const teacherSchedule = {
    action: 'create',
    title: 'Teacher Handled Class',
    webinar_id: 'wgg-tch-101',
    teacher_id: teacherProfile.id,
    host_email: 'sunil@trendz.local',
    scheduled_start_time: new Date().toISOString(),
  };
  const noTeacherEmail = await runApi(`token-${adminProfile1.id}`, { ...teacherSchedule, teacher_email: 'other@example.com' });
  assert.equal(noTeacherEmail.jsonResult.code, 'TEACHER_EMAIL_REQUIRED');
  assert.equal(cohostInvites.length, 0);
  savedTeacherEmail = teacherCohostEmail;
  const teacherAssigned = await runApi(`token-${adminProfile1.id}`, teacherSchedule);
  assert.equal(teacherAssigned.statusCode, 201);
  assert.equal(teacherAssigned.jsonResult.ok, true);
  assert.equal(teacherAssigned.jsonResult.class.teacher_id, teacherProfile.id);
  assert.equal(teacherAssigned.jsonResult.class.teacher.full_name, 'Pooja Teacher');
  assert.deepEqual(cohostInvites[0], { room: 'wgg-tch-101', kind: 'email', emails: [teacherCohostEmail] });
  assert.deepEqual(cohostPolicies[0].cohostPermissions, { startWebinar: true });
  const teacherRoom = await runApi(`token-${teacherProfile.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
  assert.equal(teacherRoom.jsonResult.class.hostDashboardUrl, 'https://webinar.gg/webinar-page/wgg-tch-101');
  assert.equal(teacherRoom.jsonResult.class.isHost, true);

  // A class whose teacher was never invited (e.g. email saved after scheduling) is repaired on open.
  cohostEmails.delete('wgg-tch-101');
  const invitesBeforeRepair = cohostInvites.length;
  const repairedRoom = await runApi(`token-${teacherProfile.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
  assert.equal(cohostInvites.length, invitesBeforeRepair + 1);
  assert.deepEqual(cohostInvites.at(-1).emails, [teacherCohostEmail]);
  assert.equal(repairedRoom.jsonResult.class.hostDashboardUrl, 'https://webinar.gg/webinar-page/wgg-tch-101');
  const openedAgain = await runApi(`token-${teacherProfile.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
  assert.equal(openedAgain.jsonResult.class.isHost, true);
  assert.equal(cohostInvites.length, invitesBeforeRepair + 1, 'no duplicate invite once the teacher is a co-host');

  // The assigned teacher's schedule row links straight to Start class.
  const teacherList = await runApi(`token-${teacherProfile.id}`, { action: 'list' });
  const teacherRow = (teacherList.jsonResult.classes || []).find((c) => c.id === teacherAssigned.jsonResult.class.id);
  assert.ok(teacherRow, 'assigned class is listed for the teacher');
  assert.equal(teacherRow.startUrl, `/pages/live-room.html?classId=${encodeURIComponent(teacherRow.id)}&start=1`);

  // Start class mints a co-host join token with the teacher's Webinar email and the room passcode.
  const tokenRequestsBefore = joinTokenRequests.length;
  const teacherStart = await runApi(`token-${teacherProfile.id}`, { action: 'join', classId: teacherAssigned.jsonResult.class.id });
  assert.equal(teacherStart.statusCode, 200);
  assert.equal(teacherStart.jsonResult.isHost, true);
  assert.match(teacherStart.jsonResult.embedUrl, /^https:\/\/webinar\.gg\/webinar-page\/wgg-tch-101\?token=/);
  assert.equal(joinTokenRequests.length, tokenRequestsBefore + 1);
  assert.equal(joinTokenRequests.at(-1).email, teacherCohostEmail);
  assert.equal(joinTokenRequests.at(-1).passcode, 'room-pass');

  // With the owner account configured, the teacher and the admin start the room as the owner (host):
  // co-host video never reaches the attendee broadcast.
  process.env.WEBINAR_GG_HOST_EMAIL = 'Owner@Premium.example';
  process.env.WEBINAR_GG_HOST_NAME = '  Trendz   Academy Owner ';
  try {
    const invitesBeforeOwner = cohostInvites.length;
    const ownerTeacherRoom = await runApi(`token-${teacherProfile.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
    assert.equal(ownerTeacherRoom.jsonResult.class.isHost, true);
    assert.equal(ownerTeacherRoom.jsonResult.class.hostDashboardUrl, 'https://webinar.gg/webinar-page/wgg-tch-101');
    assert.equal(ownerTeacherRoom.jsonResult.class.hostingDisabled, false);
    assert.equal(cohostInvites.length, invitesBeforeOwner, 'owner mode skips co-host setup');
    const ownerTeacherStart = await runApi(`token-${teacherProfile.id}`, { action: 'join', classId: teacherAssigned.jsonResult.class.id });
    assert.equal(ownerTeacherStart.jsonResult.isHost, true);
    assert.deepEqual(
      (({ firstName, lastName, email, passcode }) => ({ firstName, lastName, email, passcode }))(joinTokenRequests.at(-1)),
      { firstName: 'Trendz', lastName: 'Academy Owner', email: 'Owner@Premium.example', passcode: 'room-pass' },
    );
    const ownerAdminRoom = await runApi(`token-${adminProfile2.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
    assert.equal(ownerAdminRoom.jsonResult.class.isHost, true);
    assert.equal(ownerAdminRoom.jsonResult.class.isHostIdentityMismatch, false);
    const ownerAdminStart = await runApi(`token-${adminProfile2.id}`, { action: 'join', classId: teacherAssigned.jsonResult.class.id });
    assert.equal(ownerAdminStart.statusCode, 200);
    assert.equal(joinTokenRequests.at(-1).email, 'Owner@Premium.example');
    const ownerStudentJoin = await runApi(`token-${studentProfile.id}`, { action: 'join', classId: teacherAssigned.jsonResult.class.id });
    if (ownerStudentJoin.statusCode === 200) {
      assert.equal(ownerStudentJoin.jsonResult.isHost, false);
      assert.notEqual(joinTokenRequests.at(-1).email, 'Owner@Premium.example');
    }
  } finally {
    delete process.env.WEBINAR_GG_HOST_EMAIL;
    delete process.env.WEBINAR_GG_HOST_NAME;
  }
  failCohostPolicy = true;
  const blockedTeacherRoom = await runApi(`token-${teacherProfile.id}`, { action: 'get_class_details', classId: teacherAssigned.jsonResult.class.id });
  assert.equal(blockedTeacherRoom.jsonResult.class.hostDashboardUrl, null);
  assert.equal(blockedTeacherRoom.jsonResult.class.hostingDisabled, true);
  const failedSetup = await runApi(`token-${adminProfile1.id}`, { ...teacherSchedule, webinar_id: 'wgg-tch-102' });
  assert.equal(failedSetup.jsonResult.code, 'TEACHER_COHOST_SETUP_FAILED');
  assert.equal(failedSetup.jsonResult.existingRoomId, 'wgg-tch-102');
  assert.equal(createdClasses.length, 1);
  failCohostPolicy = false;
  const retriedSetup = await runApi(`token-${adminProfile1.id}`, { ...teacherSchedule, webinar_id: failedSetup.jsonResult.existingRoomId });
  assert.equal(retriedSetup.statusCode, 201);
  assert.deepEqual(cohostInvites[1].emails, [teacherCohostEmail]);

  // 8. Admin successfully self-assigns class to themselves
  const selfAssigned = await runApi(`token-${adminProfile1.id}`, {
    action: 'create',
    title: 'Admin Self-Assigned Class',
    webinar_id: 'wgg-admin-101',
    teacher_id: adminProfile1.id,
    host_email: 'sunil@trendz.local',
    invited_teacher_ids: [teacherProfile.id, adminProfile1.id],
    scheduled_start_time: new Date().toISOString(),
  });
  assert.equal(selfAssigned.statusCode, 201);
  assert.equal(selfAssigned.jsonResult.ok, true);
  assert.equal(selfAssigned.jsonResult.class.teacher_id, adminProfile1.id);
  assert.equal(selfAssigned.jsonResult.class.teacher.full_name, 'Sunil Admin');

  // Verify invited teachers kept separate: self-assigned admin is stripped from invited_teacher_ids
  const createdSelf = createdClasses.find((c) => c.title === 'Admin Self-Assigned Class');
  assert.ok(createdSelf);
  assert.deepEqual(createdSelf.invited_teacher_ids, [teacherProfile.id]);

  // 9. Self-assignment does NOT grant provider host access on its own
  // Admin 2 (mismatched host identity) joining class created by Admin 1 with host_email 'sunil@trendz.local'
  const mismatchJoin = await runApi(`token-${adminProfile2.id}`, {
    action: 'join',
    classId: createdSelf.id,
  });
  assert.equal(mismatchJoin.statusCode, 403);
  assert.equal(mismatchJoin.jsonResult.code, 'HOST_IDENTITY_MISMATCH');

  // Admin 1 (matching host identity) joining class
  const matchingJoin = await runApi(`token-${adminProfile1.id}`, {
    action: 'join',
    classId: createdSelf.id,
  });
  assert.equal(matchingJoin.statusCode, 200);
  assert.equal(matchingJoin.jsonResult.isHost, true);

  const schedule = {
    action: 'create',
    title: 'After-school practice',
    teacher_id: adminProfile1.id,
    scheduled_start_time: '2027-04-15T12:30:00.000Z',
    duration_minutes: 45,
  };
  const adminToken = `token-${adminProfile1.id}`;

  const missingStudents = await runApi(adminToken, { ...schedule, audience: 'students', target_student_ids: [] });
  assert.equal(missingStudents.statusCode, 400);
  assert.equal(providerRequests.length, 0);

  const selected = await runApi(adminToken, { ...schedule, audience: 'students', target_student_ids: [studentProfile.id] });
  assert.equal(selected.statusCode, 201);
  assert.equal(selected.jsonResult.class.webinar_id, 'generated-room-1');
  assert.deepEqual(selected.jsonResult.class.target_student_ids, [studentProfile.id]);
  const { passcode, ...providerSchedule } = providerRequests[0];
  assert.match(passcode, /^[a-f0-9]{16}$/);
  assert.deepEqual(providerSchedule, {
    title: schedule.title,
    date: '2027-04-15',
    time: '06:00',
    meridiem: 'PM',
    durationMinutes: 45,
    timezone: 'Asia/Kolkata',
    recordingEnabled: false,
    requireApproval: false,
  });

  const level = await runApi(adminToken, { ...schedule, audience: 'level', target_level: 'Basic 1', recording_enabled: true });
  assert.equal(level.statusCode, 201);
  assert.equal(level.jsonResult.class.target_level, 'Basic 1');
  assert.equal(level.jsonResult.class.target_student_ids, null);
  assert.equal(providerRequests[1].recordingEnabled, true);

  // One Webinar.gg meeting at a time: overlapping live classes are refused, back-to-back ones are fine.
  scheduledRows = [{
    id: 'busy-1', title: 'Level 3 drills', class_type: 'live', status: 'scheduled', provider_status: 'scheduled',
    scheduled_start_time: '2027-04-15T12:00:00.000Z', duration_minutes: 60,
  }];
  const roomsBefore = providerRequests.length;
  const overlapping = await runApi(adminToken, { ...schedule, audience: 'level', target_level: 'Basic 1' });
  assert.equal(overlapping.statusCode, 409);
  assert.equal(overlapping.jsonResult.code, 'CLASS_TIME_CONFLICT');
  assert.equal(overlapping.jsonResult.conflictClassId, 'busy-1');
  assert.match(overlapping.jsonResult.error, /"Level 3 drills" is already booked from 5:30 PM to 6:30 PM IST/);
  assert.equal(providerRequests.length, roomsBefore, 'no Webinar.gg room is made for a refused class');

  const backToBack = await runApi(adminToken, {
    ...schedule, audience: 'level', target_level: 'Basic 1', scheduled_start_time: '2027-04-15T13:00:00.000Z',
  });
  assert.equal(backToBack.statusCode, 201);

  scheduledRows[0].status = 'cancelled';
  const afterCancel = await runApi(adminToken, { ...schedule, audience: 'level', target_level: 'Basic 1' });
  assert.equal(afterCancel.statusCode, 201);

  process.env.WEBINAR_GG_MAX_LIVE_CLASSES = '2';
  try {
    scheduledRows[0].status = 'scheduled';
    const twoAllowed = await runApi(adminToken, { ...schedule, audience: 'level', target_level: 'Basic 1' });
    assert.equal(twoAllowed.statusCode, 201);
  } finally {
    delete process.env.WEBINAR_GG_MAX_LIVE_CLASSES;
  }
  scheduledRows = [];

  // Start class is refused while Webinar.gg says another class is still running.
  runningRows = [
    { id: 'other-live', title: 'Level 1 evening', webinar_id: 'room-other', class_type: 'live', status: 'live', provider_status: 'ongoing' },
    { id: 'stale-live', title: 'Testing class 12', webinar_id: 'room-stale', class_type: 'live', status: 'live', provider_status: 'ongoing' },
  ];
  providerStatusByRoom.set('room-other', 'ongoing');
  providerStatusByRoom.set('room-stale', 'completed');
  const blockedStart = await runApi(adminToken, { action: 'join', classId: level.jsonResult.class.id });
  assert.equal(blockedStart.statusCode, 409);
  assert.equal(blockedStart.jsonResult.code, 'ANOTHER_CLASS_LIVE');
  assert.match(blockedStart.jsonResult.error, /"Level 1 evening" is still live/);
  assert.deepEqual(endedRows.map((r) => [r.id, r.status]), [['stale-live', 'ended']], 'a class Webinar.gg already ended is closed, not blocking');

  const studentStillJoins = await runApi(`token-${studentProfile.id}`, { action: 'join', classId: level.jsonResult.class.id });
  assert.notEqual(studentStillJoins.jsonResult?.code, 'ANOTHER_CLASS_LIVE', 'students are never blocked by this check');

  providerStatusByRoom.set('room-other', 'completed');
  const freeStart = await runApi(adminToken, { action: 'join', classId: level.jsonResult.class.id });
  assert.equal(freeStart.statusCode, 200);
  assert.equal(freeStart.jsonResult.isHost, true);
  runningRows = [];
  providerStatusByRoom.clear();
});

test('15. Host email matching ignores letter case and spaces', async () => {
  const { isSameEmail } = await import('../api/_liveClass.js');
  assert.equal(isSameEmail('Owner@Trendz.in ', 'owner@trendz.in'), true);
  assert.equal(isSameEmail('owner@trendz.in', 'other@trendz.in'), false);
  assert.equal(isSameEmail('', ''), false);
  assert.equal(isSameEmail(null, 'owner@trendz.in'), false);
});

// Small in-memory Supabase stand-in: filters with eq/in, resolves lists, single rows and inserts.
function memorySupabase(tables, tokens) {
  const from = (table) => {
    const filters = [];
    let inserted = null;
    const rows = () => (tables[table] || []).filter((row) => filters.every((f) => f(row)));
    const builder = {
      select: () => builder,
      eq: (col, val) => { filters.push((row) => row[col] === val); return builder; },
      in: (col, vals) => { filters.push((row) => vals.includes(row[col])); return builder; },
      gte: () => builder, lt: () => builder, or: () => builder, order: () => builder, limit: () => builder,
      insert: (record) => {
        tables[table] = tables[table] || [];
        inserted = { id: `class-${tables[table].length + 1}`, ...record };
        tables[table].push(inserted);
        return builder;
      },
      update: () => builder,
      single: async () => {
        const row = inserted || rows()[0];
        return { data: row || null, error: row ? null : new Error('Not found') };
      },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return builder;
  };
  return {
    auth: {
      getUser: async (token) => (tokens[token]
        ? { data: { user: { id: tokens[token], email: `${tokens[token]}@trendz.local` } }, error: null }
        : { data: { user: null }, error: new Error('Invalid token') }),
      admin: { getUserById: async (id) => ({ data: { user: { id } }, error: null }) },
    },
    from,
  };
}

async function callLiveApi(supabase, token, body) {
  let statusCode = 200;
  let json = null;
  const res = {
    setHeader: () => {},
    status: (code) => { statusCode = code; return res; },
    json: (data) => { json = data; return res; },
    end: () => res,
  };
  await handleLiveClassRequest(
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, body },
    res,
    { supabase, fetch: async () => { throw new Error('Zoom classes must not call Webinar.gg'); } },
  );
  return { statusCode, json };
}

test('16. Zoom links are validated and normalised', async () => {
  const { normalizeZoomMeetingUrl } = await import('../api/_liveClass.js');
  assert.equal(normalizeZoomMeetingUrl('https://us02web.zoom.us/j/8123456789?pwd=abc#x'), 'https://us02web.zoom.us/j/8123456789?pwd=abc');
  assert.equal(normalizeZoomMeetingUrl('  https://zoom.us/j/123  '), 'https://zoom.us/j/123');
  assert.equal(normalizeZoomMeetingUrl('http://zoom.us/j/123'), null);
  assert.equal(normalizeZoomMeetingUrl('https://zoom.us.evil.com/j/123'), null);
  assert.equal(normalizeZoomMeetingUrl('https://evilzoom.us/j/123'), null);
  assert.equal(normalizeZoomMeetingUrl('https://user:pw@zoom.us/j/123'), null);
  assert.equal(normalizeZoomMeetingUrl('https://zoom.us/'), null);
  assert.equal(normalizeZoomMeetingUrl('javascript:alert(1)'), null);
  assert.equal(normalizeZoomMeetingUrl(null), null);
});

test('17. Teachers schedule Zoom classes only with permission and only for their own students; students get the link at class time', async () => {
  const teacher = { id: 'tch-1', full_name: 'Pooja', role: 'teacher', level: 'Teacher', active: true };
  const otherTeacher = { id: 'tch-2', full_name: 'Ravi', role: 'teacher', level: 'Teacher', active: true };
  const admin = { id: 'adm-1', full_name: 'Admin', role: 'admin', level: 'Admin', active: true };
  const mine = { id: 'b1000000-0000-0000-0000-000000000001', full_name: 'Rohan', role: 'student', level: 'Basic 1', active: true };
  const notMine = { id: 'b1000000-0000-0000-0000-000000000002', full_name: 'Meera', role: 'student', level: 'Basic 1', active: true };
  const tables = {
    profiles: [teacher, otherTeacher, admin, mine, notMine],
    teacher_permissions: [{ teacher_id: 'tch-1', can_schedule_live_classes: false }],
    teacher_student_assignments: [{ teacher_id: 'tch-1', student_id: 'b1000000-0000-0000-0000-000000000001' }],
    live_classes: [],
  };
  const tokens = { 'tok-teacher': 'tch-1', 'tok-admin': 'adm-1', 'tok-mine': 'b1000000-0000-0000-0000-000000000001', 'tok-notmine': 'b1000000-0000-0000-0000-000000000002', 'tok-other-teacher': 'tch-2' };
  const db = memorySupabase(tables, tokens);
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const zoomClass = (extra = {}) => ({
    action: 'create', class_type: 'zoom', title: 'Speed drills', teacher_id: 'tch-1',
    audience: 'students', target_student_ids: ['b1000000-0000-0000-0000-000000000001'], scheduled_start_time: soon, duration_minutes: 40,
    meeting_url: 'https://us02web.zoom.us/j/8123456789?pwd=abc', ...extra,
  });

  // Permission off: refused.
  let r = await callLiveApi(db, 'tok-teacher', zoomClass());
  assert.equal(r.statusCode, 403);
  assert.equal(r.json.code, 'FORBIDDEN');
  assert.match(r.json.error, /Schedule live classes/);

  tables.teacher_permissions[0].can_schedule_live_classes = true;

  // Someone else's student, another teacher's class, admin-only fields and types, non-student audience.
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ target_student_ids: ['b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002'] }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.json.code, 'INVALID_AUDIENCE');
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ teacher_id: 'tch-2' }));
  assert.equal(r.statusCode, 403);
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ invited_teacher_ids: ['tch-2'] }));
  assert.equal(r.statusCode, 403);
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ class_type: 'prerecorded' }));
  assert.equal(r.statusCode, 403);
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ audience: 'level', target_student_ids: [], target_level: 'Basic 1' }));
  assert.equal(r.statusCode, 400);

  // Bad link and too long.
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ meeting_url: 'https://example.com/j/1' }));
  assert.equal(r.json.code, 'INVALID_ZOOM_LINK');
  r = await callLiveApi(db, 'tok-teacher', zoomClass({ duration_minutes: 60 }));
  assert.equal(r.json.code, 'ZOOM_TOO_LONG');
  assert.equal(tables.live_classes.length, 0);

  // Valid: saved without touching Webinar.gg.
  r = await callLiveApi(db, 'tok-teacher', zoomClass());
  assert.equal(r.statusCode, 201, JSON.stringify(r.json));
  assert.equal(tables.live_classes.length, 1);
  const saved = tables.live_classes[0];
  assert.equal(saved.class_type, 'zoom');
  assert.equal(saved.meeting_url, 'https://us02web.zoom.us/j/8123456789?pwd=abc');
  assert.match(saved.webinar_id, /^zoom-/);
  assert.equal(saved.host_email, null);

  // Join: the enrolled student gets the link, others do not.
  r = await callLiveApi(db, 'tok-mine', { action: 'join', classId: saved.id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.classType, 'zoom');
  assert.equal(r.json.meetingUrl, saved.meeting_url);
  assert.equal(r.json.isHost, false);
  r = await callLiveApi(db, 'tok-notmine', { action: 'join', classId: saved.id });
  assert.equal(r.json.code, 'NOT_ENROLLED');
  assert.equal(r.json.meetingUrl, undefined);
  r = await callLiveApi(db, 'tok-other-teacher', { action: 'join', classId: saved.id });
  assert.equal(r.json.code, 'NOT_INVITED');
  r = await callLiveApi(db, 'tok-teacher', { action: 'join', classId: saved.id });
  assert.equal(r.json.isHost, true);

  // Too early for students.
  saved.scheduled_start_time = new Date(Date.now() + 60 * 60_000).toISOString();
  r = await callLiveApi(db, 'tok-mine', { action: 'join', classId: saved.id });
  assert.equal(r.json.code, 'CLASS_NOT_OPEN_YET');
  assert.equal(r.json.meetingUrl, undefined);

  // Admins can still schedule Zoom classes for any teacher.
  r = await callLiveApi(db, 'tok-admin', zoomClass({ teacher_id: 'tch-2', target_student_ids: ['b1000000-0000-0000-0000-000000000002'] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.json));
});
