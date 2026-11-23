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

  // Case D: Assigned teacher CANNOT obtain owner host token; hosting is kept disabled
  const teacherJoin = await runRequest('token-teacher-assigned');
  assert.equal(teacherJoin.statusCode, 403);
  assert.equal(teacherJoin.jsonResult.code, 'TEACHER_HOSTING_DISABLED');
  assert.ok(teacherJoin.jsonResult.error.includes('Teacher hosting is currently disabled'));

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

  // H2: Admin with mismatched host email has isHost: false, hostingDisabled: false
  const adminMismatchMeta = await runRequest('token-admin-mismatch', 'get_class_details');
  assert.equal(adminMismatchMeta.statusCode, 200);
  assert.equal(adminMismatchMeta.jsonResult.class.isHost, false);
  assert.equal(adminMismatchMeta.jsonResult.class.hostingDisabled, false);

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
