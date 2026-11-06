/**
 * Phase 18 — HTTP Handler Integration Tests for Teacher Management APIs
 * (tests/phase18_teacher_api_handlers.test.js)
 *
 * Verifies real HTTP request/response flows for:
 * - api/create-teacher.js
 * - api/manage-teacher.js
 *
 * Security & Identity Invariants:
 * 1. Non-POST requests rejected with 405 Method Not Allowed.
 * 2. Missing or malformed Authorization header rejected with 401 Unauthorized.
 * 3. Raw service-role key passed without user subject rejected with 401 Unauthorized.
 * 4. Forged x-actor-id headers are completely ignored; cannot bypass admin verification.
 * 5. Student caller JWTs rejected with 403 Forbidden.
 * 6. Teacher caller JWTs rejected with 403 Forbidden.
 * 7. Inactive administrator JWTs rejected with 403 Forbidden.
 * 8. Active administrator JWT executes successfully with verified identity recorded in RPC caller context.
 * 9. Compensating cleanup deletes Supabase Auth user if database initialization fails.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';

import createTeacherHandler from '../api/create-teacher.js';
import manageTeacherHandler from '../api/manage-teacher.js';
import createStudentHandler from '../api/create-student.js';
import resetPasswordHandler from '../api/reset-password.js';
import backupHandler from '../api/backup.js';

function createMockRes() {
  let statusCode = 200;
  let responseData = null;
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
      return res;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getData: () => responseData,
  };
  return res;
}

describe('Phase 18 — Teacher API HTTP Handlers & Identity Enforcement', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  const adminUserId = '11111111-1111-1111-1111-111111111111';
  const inactiveAdminUserId = '11111111-1111-1111-1111-000000000000';
  const studentUserId = '22222222-2222-2222-2222-222222222222';
  const teacherUserId = '33333333-3333-3333-3333-333333333333';
  const targetTeacherId = '44444444-4444-4444-4444-444444444444';

  const validAdminToken = 'token-admin-active';
  const inactiveAdminToken = 'token-admin-inactive';
  const studentToken = 'token-student';
  const teacherToken = 'token-teacher';
  const rawServiceKeyToken = 'raw-service-key-token-without-user';

  let interceptedRequests = [];
  let simulateRpcFailure = false;
  let deletedAuthUserIds = [];

  before(() => {
    process.env.SUPABASE_URL = 'https://mockproject123.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'mock-anon-key-12345';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-12345';

    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const method = options.method || 'GET';
      const authHeader = typeof options.headers?.get === 'function'
        ? (options.headers.get('authorization') || options.headers.get('Authorization') || '')
        : (options.headers?.Authorization || options.headers?.authorization || '');
      const body = options.body ? JSON.parse(options.body) : null;

      interceptedRequests.push({ url: urlStr, method, authHeader, body, headers: options.headers });

      // 1. Auth: getUser endpoint (GET /auth/v1/user)
      if (urlStr.includes('/auth/v1/user') && method === 'GET') {
        const token = authHeader.replace('Bearer ', '').trim();
        if (token === validAdminToken) {
          return new Response(JSON.stringify({ id: adminUserId, email: 'admin@trendz.local', role: 'authenticated' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (token === inactiveAdminToken) {
          return new Response(JSON.stringify({ id: inactiveAdminUserId, email: 'inactive@trendz.local', role: 'authenticated' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (token === studentToken) {
          return new Response(JSON.stringify({ id: studentUserId, email: 'student@trendz.local', role: 'authenticated' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (token === teacherToken) {
          return new Response(JSON.stringify({ id: teacherUserId, email: 'teacher@trendz.local', role: 'authenticated' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Raw service role key or invalid token passed as Bearer
        return new Response(JSON.stringify({ message: 'Invalid or missing user session token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 2. Auth: admin.createUser (POST /auth/v1/admin/users)
      if (urlStr.includes('/auth/v1/admin/users') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: targetTeacherId,
            email: body?.email || 'newteacher@trendz.local',
            user_metadata: body?.user_metadata || {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 3. Auth: admin.deleteUser (DELETE /auth/v1/admin/users/<id>)
      if (urlStr.includes('/auth/v1/admin/users/') && method === 'DELETE') {
        const userId = urlStr.split('/auth/v1/admin/users/')[1];
        deletedAuthUserIds.push(userId);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 4. REST: profiles query (GET /rest/v1/profiles)
      if (urlStr.includes('/rest/v1/profiles') && method === 'GET') {
        if (urlStr.includes(`id=eq.${adminUserId}`)) {
          return new Response(
            JSON.stringify({ id: adminUserId, student_code: 'ADM01', full_name: 'Admin User', role: 'admin', active: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes(`id=eq.${inactiveAdminUserId}`)) {
          return new Response(
            JSON.stringify({ id: inactiveAdminUserId, student_code: 'ADM02', full_name: 'Inactive Admin', role: 'admin', active: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes(`id=eq.${studentUserId}`)) {
          return new Response(
            JSON.stringify({ id: studentUserId, student_code: 'STU01', full_name: 'Student User', role: 'student', active: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes(`id=eq.${teacherUserId}`)) {
          return new Response(
            JSON.stringify({ id: teacherUserId, student_code: 'TCH01', full_name: 'Teacher User', role: 'teacher', active: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes(`id=eq.${targetTeacherId}`)) {
          return new Response(
            JSON.stringify({ id: targetTeacherId, student_code: 'TCH02', full_name: 'Target Teacher', role: 'teacher', active: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify(null), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      // 5. REST: RPC endpoints (/rest/v1/rpc/...)
      if (urlStr.includes('/rest/v1/rpc/') && method === 'POST') {
        if (simulateRpcFailure) {
          return new Response(JSON.stringify({ message: 'Simulated database transaction failure' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('admin_create_teacher_entry')) {
          return new Response(JSON.stringify({ ok: true, teacher_id: body?.p_teacher_id }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('admin_replace_teacher_assignments')) {
          return new Response(JSON.stringify({ ok: true, assigned_count: body?.p_student_ids?.length || 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('admin_update_teacher_permissions')) {
          return new Response(JSON.stringify({ ok: true, success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('admin_set_teacher_active')) {
          return new Response(JSON.stringify({ ok: true, active: body?.p_active }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });

  after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    interceptedRequests = [];
    simulateRpcFailure = false;
    deletedAuthUserIds = [];
  });

  // ---------------------------------------------------------------------------
  // 1. HTTP Method Validation
  // ---------------------------------------------------------------------------
  it('rejects non-POST methods with 405 Method Not Allowed', async () => {
    const res1 = createMockRes();
    await createTeacherHandler({ method: 'GET', headers: {} }, res1);
    assert.equal(res1.getStatusCode(), 405);

    const res2 = createMockRes();
    await manageTeacherHandler({ method: 'DELETE', headers: {} }, res2);
    assert.equal(res2.getStatusCode(), 405);
  });

  // ---------------------------------------------------------------------------
  // 2. Authentication & Forged Actor Headers
  // ---------------------------------------------------------------------------
  it('rejects missing or non-Bearer authorization with 401', async () => {
    const res1 = createMockRes();
    await createTeacherHandler({ method: 'POST', headers: {} }, res1);
    assert.equal(res1.getStatusCode(), 401);
    assert.match(res1.getData().error, /Missing or invalid Bearer token/i);

    const res2 = createMockRes();
    await manageTeacherHandler({ method: 'POST', headers: { authorization: 'Basic 12345' } }, res2);
    assert.equal(res2.getStatusCode(), 401);
  });

  it('rejects raw service-role token without user session with 401', async () => {
    const res = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${rawServiceKeyToken}` },
        body: { teacher_code: 'TCH09', full_name: 'Name', password: 'password123' },
      },
      res
    );
    assert.equal(res.getStatusCode(), 401);
    assert.match(res.getData().error, /Invalid authentication session/i);
  });

  it('ignores forged x-actor-id headers: cannot spoof admin identity without verified JWT', async () => {
    const res1 = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawServiceKeyToken}`,
          'x-actor-id': adminUserId, // Attempt to spoof admin identity
        },
        body: { teacher_code: 'TCH09', full_name: 'Name', password: 'password123' },
      },
      res1
    );
    assert.equal(res1.getStatusCode(), 401, 'Forged x-actor-id header is ignored and fails 401');

    const res2 = createMockRes();
    await manageTeacherHandler(
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${studentToken}`, // Student token attempting to spoof admin via header
          'x-actor-id': adminUserId,
        },
        body: { action: 'set_active', teacher_id: targetTeacherId, active: false },
      },
      res2
    );
    assert.equal(res2.getStatusCode(), 403, 'Student with forged x-actor-id is strictly rejected with 403');
  });

  // ---------------------------------------------------------------------------
  // 3. Role & Status Boundaries
  // ---------------------------------------------------------------------------
  it('rejects student and teacher tokens with 403 Forbidden', async () => {
    const resStudent = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${studentToken}` },
        body: { teacher_code: 'TCH10', full_name: 'Name', password: 'password123' },
      },
      resStudent
    );
    assert.equal(resStudent.getStatusCode(), 403);
    assert.match(resStudent.getData().error, /Admin access required/i);

    const resTeacher = createMockRes();
    await manageTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${teacherToken}` },
        body: { action: 'set_active', teacher_id: targetTeacherId, active: false },
      },
      resTeacher
    );
    assert.equal(resTeacher.getStatusCode(), 403);
    assert.match(resTeacher.getData().error, /Admin access required/i);
  });

  it('rejects teacher caller token with 403 Forbidden across all administrative APIs (create-student, reset-password, backup)', async () => {
    // 1. /api/create-student
    const resCreateStudent = createMockRes();
    await createStudentHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${teacherToken}` },
        body: { student_code: 'STU99', full_name: 'New Student', password: 'password123' },
      },
      resCreateStudent
    );
    assert.equal(resCreateStudent.getStatusCode(), 403);
    assert.match(resCreateStudent.getData().error, /Admin access required/i);

    // 2. /api/reset-password
    const resResetPwd = createMockRes();
    await resetPasswordHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${teacherToken}` },
        body: { student_id: studentUserId, new_password: 'newpassword123' },
      },
      resResetPwd
    );
    assert.equal(resResetPwd.getStatusCode(), 403);
    assert.match(resResetPwd.getData().error, /Admin access required/i);

    // 3. /api/backup
    const resBackup = createMockRes();
    await backupHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${teacherToken}` },
        body: { action: 'run' },
      },
      resBackup
    );
    assert.equal(resBackup.getStatusCode(), 403);
    assert.match(resBackup.getData().error, /Admin access required/i);
  });

  it('rejects inactive admin token with 403 Forbidden', async () => {
    const res = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${inactiveAdminToken}` },
        body: { teacher_code: 'TCH11', full_name: 'Name', password: 'password123' },
      },
      res
    );
    assert.equal(res.getStatusCode(), 403);
    assert.match(res.getData().error, /Admin access required/i);
  });

  // ---------------------------------------------------------------------------
  // 4. create-teacher Handler: Success & Compensating Cleanup
  // ---------------------------------------------------------------------------
  it('create-teacher: validates inputs, creates Auth user, and passes admin caller context to RPC', async () => {
    // 1. Input validation errors
    const resMissing = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: { teacher_code: 'TCH01' }, // Missing name and password
      },
      resMissing
    );
    assert.equal(resMissing.getStatusCode(), 400);

    const resShortPwd = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: { teacher_code: 'TCH01', full_name: 'Teacher One', password: '123' },
      },
      resShortPwd
    );
    assert.equal(resShortPwd.getStatusCode(), 400);
    assert.match(resShortPwd.getData().error, /at least 6 characters/i);

    // 2. Successful creation
    const resSuccess = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: {
          teacher_code: 'TCH01',
          full_name: 'Teacher One',
          password: 'password123',
          assigned_student_ids: [studentUserId],
        },
      },
      resSuccess
    );
    assert.equal(resSuccess.getStatusCode(), 200);
    assert.equal(resSuccess.getData().success, true);

    // Verify RPC call was made with caller's token and admin actor ID
    const rpcCall = interceptedRequests.find((r) => r.url.includes('admin_create_teacher_entry'));
    assert.ok(rpcCall, 'admin_create_teacher_entry RPC was invoked');
    assert.equal(rpcCall.authHeader, `Bearer ${validAdminToken}`, 'Caller token used for RPC');
    assert.equal(rpcCall.body.p_actor_id, adminUserId, 'Actor ID is the verified administrator');
    assert.notEqual(rpcCall.body.p_actor_id, targetTeacherId, 'Actor ID is NEVER the target teacher');
  });

  it('create-teacher: executes checked compensating cleanup if database RPC fails', async () => {
    simulateRpcFailure = true;

    const res = createMockRes();
    await createTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: {
          teacher_code: 'TCH02',
          full_name: 'Teacher Two',
          password: 'password123',
        },
      },
      res
    );
    assert.equal(res.getStatusCode(), 400);
    assert.match(res.getData().error, /Failed to initialize teacher in database/i);

    // Verify compensating cleanup deleted the orphaned Auth user
    assert.equal(deletedAuthUserIds.length, 1, 'Compensating cleanup invoked deleteUser');
    assert.equal(deletedAuthUserIds[0], targetTeacherId, 'Deleted the created Auth user');
  });

  // ---------------------------------------------------------------------------
  // 5. manage-teacher Handler: Actions & Verified Admin Identity
  // ---------------------------------------------------------------------------
  it('manage-teacher: update_assignments invokes RPC with caller token and admin actor_id', async () => {
    const res = createMockRes();
    await manageTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: {
          action: 'update_assignments',
          teacher_id: targetTeacherId,
          assigned_student_ids: [studentUserId],
        },
      },
      res
    );
    assert.equal(res.getStatusCode(), 200);
    assert.equal(res.getData().success, true);

    const rpcCall = interceptedRequests.find((r) => r.url.includes('admin_replace_teacher_assignments'));
    assert.ok(rpcCall, 'admin_replace_teacher_assignments RPC invoked');
    assert.equal(rpcCall.authHeader, `Bearer ${validAdminToken}`);
    assert.equal(rpcCall.body.p_actor_id, adminUserId, 'Verified admin ID passed as actor_id');
  });

  it('manage-teacher: update_permissions invokes RPC with caller token and admin actor_id', async () => {
    const res = createMockRes();
    await manageTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: {
          action: 'update_permissions',
          teacher_id: targetTeacherId,
          permissions: { can_mark_attendance: false },
        },
      },
      res
    );
    assert.equal(res.getStatusCode(), 200);
    assert.equal(res.getData().success, true);

    const rpcCall = interceptedRequests.find((r) => r.url.includes('admin_update_teacher_permissions'));
    assert.ok(rpcCall, 'admin_update_teacher_permissions RPC invoked');
    assert.equal(rpcCall.authHeader, `Bearer ${validAdminToken}`);
    assert.equal(rpcCall.body.p_actor_id, adminUserId, 'Verified admin ID passed as actor_id');
  });

  it('manage-teacher: set_active invokes RPC with caller token and admin actor_id', async () => {
    const res = createMockRes();
    await manageTeacherHandler(
      {
        method: 'POST',
        headers: { authorization: `Bearer ${validAdminToken}` },
        body: {
          action: 'set_active',
          teacher_id: targetTeacherId,
          active: false,
        },
      },
      res
    );
    assert.equal(res.getStatusCode(), 200);
    assert.equal(res.getData().success, true);

    const rpcCall = interceptedRequests.find((r) => r.url.includes('admin_set_teacher_active'));
    assert.ok(rpcCall, 'admin_set_teacher_active RPC invoked');
    assert.equal(rpcCall.authHeader, `Bearer ${validAdminToken}`);
    assert.equal(rpcCall.body.p_actor_id, adminUserId, 'Verified admin ID passed as actor_id');
  });
});
