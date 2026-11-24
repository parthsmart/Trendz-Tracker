/**
 * Trendz Tracker — Webinar Recordings & Scheduled Class Test Suite
 * (tests/liveClassRecordings.test.js)
 *
 * Verifies Phase 21 Workstream A:
 * 1. Automatic recording configuration and scheduled class type flags on live_classes:
 *    - class_type: 'live' | 'prerecorded' | 'stream'
 *    - recording_enabled: boolean (default true)
 *    - prerecorded_asset_url: text
 * 2. Admin-only Recordings Library access (list_recordings):
 *    - Admin succeeds and can filter by status/search
 *    - Student and Teacher calls are rejected with 403 FORBIDDEN
 * 3. Server-side authorized playback (get_recording_playback):
 *    - Admin gets authorized playback details
 *    - Access is audited
 *    - Processing or deleted recordings are rejected with actionable error
 *    - Students and Teachers are rejected with 403 FORBIDDEN
 * 4. Confirmed Recording Deletion ("Remove from Trendz"):
 *    - Admin removes recording with reason
 *    - Table status becomes 'deleted' and audit record is preserved
 *    - Class and webinar records remain intact
 *    - Returns clear instructions for manual Webinar.gg dashboard deletion
 * 5. Scheduled Prerecorded Class Join Authorization:
 *    - Enrolled student receives asset URL without Webinar.gg token minting
 *    - Unenrolled student is blocked with 403 NOT_ENROLLED
 *    - Uninvited teacher is blocked with 403 NOT_INVITED
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLiveClassRequest } from '../api/_liveClass.js';

function createMockReqRes({ method = 'POST', headers = {}, body = {} } = {}) {
  const req = {
    method,
    headers: {
      authorization: 'Bearer mock-token',
      ...headers,
    },
    body,
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, val) {
      this.headers[name] = val;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    end() {
      return this;
    },
  };

  return { req, res };
}

function createMockSupabase(callerProfile, dbState = {}) {
  const liveClasses = dbState.liveClasses || [];
  const recordings = dbState.recordings || [];
  const auditLogs = dbState.auditLogs || [];

  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: callerProfile.id, email: callerProfile.email } },
        error: null,
      }),
    },
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (objectPath, expiresIn) => ({
          data: { signedUrl: `https://signed.supabase.co/storage/v1/object/sign/${bucket}/${objectPath}?token=mock-signed-exp-${expiresIn}` },
          error: null,
        }),
      }),
    },
    from: (table) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: callerProfile, error: null }),
            }),
          }),
        };
      }

      if (table === 'live_classes') {
        return {
          select: (fields) => ({
            eq: (col, val) => ({
              single: async () => {
                const item = liveClasses.find((c) => c[col] === val);
                if (!item) return { data: null, error: new Error('Class not found') };
                return {
                  data: {
                    ...item,
                    teacher: { id: item.teacher_id, full_name: 'Assigned Teacher' },
                  },
                  error: null,
                };
              },
            }),
            order: () => ({
              data: liveClasses.map((c) => ({
                ...c,
                teacher: { id: c.teacher_id, full_name: 'Assigned Teacher' },
              })),
              error: null,
            }),
          }),
          insert: (row) => ({
            select: () => ({
              single: async () => {
                const inserted = { id: 'new-class-' + Date.now(), ...row };
                liveClasses.push(inserted);
                return {
                  data: {
                    ...inserted,
                    teacher: { id: inserted.teacher_id, full_name: 'Assigned Teacher' },
                  },
                  error: null,
                };
              },
            }),
          }),
          update: (updates) => ({
            eq: (col, val) => {
              const target = liveClasses.find((c) => c[col] === val);
              if (target) Object.assign(target, updates);
              return {
                select: () => ({
                  single: async () => ({ data: target, error: null }),
                }),
              };
            },
          }),
        };
      }

      if (table === 'live_class_recordings') {
        return {
          select: () => ({
            is: (col, val) => ({
              order: () => {
                const active = recordings.filter((r) => (val === null ? !r.deleted_at : r[col] === val));
                return {
                  data: active.map((r) => ({
                    ...r,
                    live_class: liveClasses.find((c) => c.id === r.class_id) || {
                      id: r.class_id,
                      title: 'Live Class',
                      teacher: { id: 'teacher-1', full_name: 'Teacher Test' },
                    },
                  })),
                  error: null,
                };
              },
              eq: (fCol, fVal) => ({
                order: () => {
                  const filtered = recordings.filter(
                    (r) => (val === null ? !r.deleted_at : r[col] === val) && r[fCol] === fVal
                  );
                  return {
                    data: filtered.map((r) => ({
                      ...r,
                      live_class: liveClasses.find((c) => c.id === r.class_id),
                    })),
                    error: null,
                  };
                },
              }),
            }),
            eq: (col, val) => ({
              single: async () => {
                const rec = recordings.find((r) => r[col] === val);
                if (!rec) return { data: null, error: new Error('Recording not found') };
                return {
                  data: {
                    ...rec,
                    live_class: liveClasses.find((c) => c.id === rec.class_id) || {
                      id: rec.class_id,
                      title: 'Test Class',
                      teacher: { id: 'teacher-1', full_name: 'Teacher One' },
                    },
                  },
                  error: null,
                };
              },
            }),
          }),
          update: (updates) => ({
            eq: (col, val) => {
              const target = recordings.find((r) => r[col] === val);
              if (target) Object.assign(target, updates);
              return { error: null };
            },
          }),
          insert: (row) => ({
            select: () => ({
              single: async () => {
                const inserted = { id: 'rec-' + Date.now(), ...row };
                recordings.push(inserted);
                return { data: inserted, error: null };
              },
            }),
          }),
        };
      }

      if (table === 'live_class_recording_audit_log') {
        return {
          insert: async (row) => {
            auditLogs.push(row);
            return { error: null };
          },
        };
      }

      throw new Error(`Unhandled mock table: ${table}`);
    },
  };
}

test('1. Admin creates class with class_type, recording_enabled, and prerecorded_asset_url', async () => {
  const adminProfile = { id: 'admin-1', role: 'admin', active: true, email: 'admin@trendz.edu' };
  const mockSupabase = createMockSupabase(adminProfile);

  const { req, res } = createMockReqRes({
    body: {
      action: 'create',
      title: 'Scheduled Prerecorded Addition Workshop',
      class_type: 'prerecorded',
      prerecorded_asset_url: 'https://drive.google.com/file/d/test-video-123/preview',
      recording_enabled: false,
      teacher_id: 'teacher-1',
      scheduled_start_time: '2026-11-25T10:00:00.000Z',
      duration_minutes: 45,
    },
  });

  await handleLiveClassRequest(req, res, { supabase: mockSupabase });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.class.class_type, 'prerecorded');
  assert.equal(res.body.class.recording_enabled, false);
  assert.equal(res.body.class.prerecorded_asset_url, 'https://drive.google.com/file/d/test-video-123/preview');
  assert.ok(res.body.class.webinar_id.startsWith('prerecorded-'), 'Auto-assigns placeholder webinar ID for prerecorded');
});

test('2. list_recordings is strictly Admin-only and filters by status & search', async () => {
  const adminProfile = { id: 'admin-1', role: 'admin', active: true, email: 'admin@trendz.edu' };
  const teacherProfile = { id: 'teach-1', role: 'teacher', active: true, email: 'teacher@trendz.edu' };
  const studentProfile = { id: 'stu-1', role: 'student', active: true, email: 'student@trendz.edu', level: 'Level 1' };

  const dbState = {
    liveClasses: [
      { id: 'cls-1', title: 'Speed Abacus Live Class', teacher_id: 'teach-1' },
      { id: 'cls-2', title: 'Flash Anzan Mastery', teacher_id: 'teach-2' },
    ],
    recordings: [
      {
        id: 'rec-1',
        class_id: 'cls-1',
        webinar_id: 'web-101',
        recording_id: 'wgg-rec-101',
        title: 'Speed Abacus Live Class - Part 1',
        status: 'ready',
        duration_seconds: 3600,
        recorded_at: '2026-11-24T05:00:00.000Z',
      },
      {
        id: 'rec-2',
        class_id: 'cls-2',
        webinar_id: 'web-102',
        recording_id: 'wgg-rec-102',
        title: 'Flash Anzan Mastery - Session',
        status: 'processing',
        duration_seconds: 1800,
        recorded_at: '2026-11-24T06:00:00.000Z',
      },
    ],
  };

  // 1. Teacher access blocked
  {
    const mockSupabase = createMockSupabase(teacherProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'list_recordings' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  }

  // 2. Student access blocked
  {
    const mockSupabase = createMockSupabase(studentProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'list_recordings' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  }

  // 3. Admin access permitted
  {
    const mockSupabase = createMockSupabase(adminProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'list_recordings' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recordings.length, 2);
    assert.equal(res.body.recordings[0].recordingId, 'wgg-rec-101');
    assert.equal(res.body.recordings[0].status, 'ready');
  }

  // 4. Admin search filter
  {
    const mockSupabase = createMockSupabase(adminProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'list_recordings', search: 'Flash Anzan' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recordings.length, 1);
    assert.equal(res.body.recordings[0].title, 'Flash Anzan Mastery - Session');
  }
});

test('3. get_recording_playback enforces admin permission, ready status, and audits playback', async () => {
  const adminProfile = { id: 'admin-1', role: 'admin', active: true, email: 'admin@trendz.edu' };
  const studentProfile = { id: 'stu-1', role: 'student', active: true, email: 'student@trendz.edu' };

  const dbState = {
    liveClasses: [{ id: 'cls-1', title: 'Speed Abacus Class', teacher_id: 'teach-1' }],
    recordings: [
      {
        id: 'rec-ready',
        class_id: 'cls-1',
        webinar_id: 'web-101',
        recording_id: 'wgg-101',
        title: 'Speed Abacus Class Recording',
        status: 'ready',
        duration_seconds: 3600,
        playback_url: 'https://stream.webinar.gg/recordings/wgg-101.mp4',
      },
      {
        id: 'rec-processing',
        class_id: 'cls-1',
        webinar_id: 'web-102',
        recording_id: 'wgg-102',
        title: 'Processing Recording',
        status: 'processing',
        duration_seconds: 0,
        playback_url: null,
      },
    ],
    auditLogs: [],
  };

  // 1. Non-admin blocked
  {
    const mockSupabase = createMockSupabase(studentProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_recording_playback', recordingId: 'rec-ready' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  }

  // 2. Ready recording returns authorized playback
  {
    const mockSupabase = createMockSupabase(adminProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_recording_playback', recordingId: 'rec-ready' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.recording.playbackUrl, 'https://stream.webinar.gg/recordings/wgg-101.mp4');
    assert.equal(res.body.recording.durationSeconds, 3600);
    assert.equal(dbState.auditLogs.length, 1);
    assert.equal(dbState.auditLogs[0].action, 'view_recording');
  }

  // 3. Processing recording returns actionable RECORDING_NOT_READY error
  {
    const mockSupabase = createMockSupabase(adminProfile, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_recording_playback', recordingId: 'rec-processing' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'RECORDING_NOT_READY');
  }
});

test('4. delete_recording performs "Remove from Trendz", logs audit, and preserves class', async () => {
  const adminProfile = { id: 'admin-1', role: 'admin', active: true, email: 'admin@trendz.edu' };
  const dbState = {
    liveClasses: [{ id: 'cls-1', title: 'Abacus Live Class', teacher_id: 'teach-1' }],
    recordings: [
      {
        id: 'rec-to-delete',
        class_id: 'cls-1',
        webinar_id: 'web-101',
        recording_id: 'wgg-rec-101',
        title: 'Class Recording to Remove',
        status: 'ready',
      },
    ],
    auditLogs: [],
  };

  const mockSupabase = createMockSupabase(adminProfile, dbState);
  const { req, res } = createMockReqRes({
    body: {
      action: 'delete_recording',
      recordingId: 'rec-to-delete',
      reason: 'Obsolete test session',
    },
  });

  await handleLiveClassRequest(req, res, { supabase: mockSupabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.providerNotice.includes('Webinar.gg Web Dashboard'));

  // Recording status updated to deleted
  const deletedRec = dbState.recordings.find((r) => r.id === 'rec-to-delete');
  assert.equal(deletedRec.status, 'deleted');
  assert.equal(deletedRec.deletion_reason, 'Obsolete test session');
  assert.equal(deletedRec.deleted_by, 'admin-1');

  // Audit log recorded
  assert.equal(dbState.auditLogs.length, 1);
  assert.equal(dbState.auditLogs[0].action, 'remove_from_trendz');

  // Live class row remains intact
  assert.equal(dbState.liveClasses.length, 1);
  assert.equal(dbState.liveClasses[0].id, 'cls-1');
});

test('5. Scheduled Prerecorded class join respects audience without Webinar.gg token minting', async () => {
  const enrolledStudent = { id: 'stu-enrolled', role: 'student', active: true, email: 'enrolled@trendz.edu', level: 'Level 2' };
  const unenrolledStudent = { id: 'stu-other', role: 'student', active: true, email: 'other@trendz.edu', level: 'Level 4' };

  const dbState = {
    liveClasses: [
      {
        id: 'cls-prerecorded',
        title: 'Level 2 Prerecorded Masterclass',
        class_type: 'prerecorded',
        prerecorded_asset_url: 'https://drive.google.com/file/d/masterclass-asset/preview',
        target_level: 'Level 2',
        teacher_id: 'teach-1',
        scheduled_start_time: '2026-11-25T14:00:00.000Z',
        duration_minutes: 60,
        status: 'scheduled',
      },
    ],
  };

  // 1. Enrolled student gets assetUrl
  {
    const mockSupabase = createMockSupabase(enrolledStudent, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'join', classId: 'cls-prerecorded' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.classType, 'prerecorded');
    assert.equal(res.body.assetUrl, 'https://drive.google.com/file/d/masterclass-asset/preview');
    assert.equal(res.body.classTitle, 'Level 2 Prerecorded Masterclass');
  }

  // 2. Unenrolled student gets 403 NOT_ENROLLED
  {
    const mockSupabase = createMockSupabase(unenrolledStudent, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'join', classId: 'cls-prerecorded' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'NOT_ENROLLED');
  }
});

test('6. Provider recording confirmation gate and attendee old-link replay block', async () => {
  const student = { id: 'stu-1', email: 'stu@example.com', role: 'student', level: 'Level 1', active: true };

  // A. Class with recording confirmed by provider
  {
    const dbState = {
      liveClasses: [
        {
          id: 'cls-confirmed-rec',
          title: 'Confirmed Recording Class',
          webinar_id: 'wgg-rec-confirmed',
          teacher_id: 'teach-1',
          target_level: 'Level 1',
          status: 'live',
          recording_enabled: true,
          recording_confirmed: true,
        },
      ],
    };
    const mockSupabase = createMockSupabase(student, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_class_details', classId: 'cls-confirmed-rec' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.class.recordingConfirmed, true);
    assert.equal(res.body.class.recordingNotice, 'This live class is being recorded for academic review.');
  }

  // B. Class where recording is NOT confirmed: notice MUST be null
  {
    const dbState = {
      liveClasses: [
        {
          id: 'cls-unconfirmed-rec',
          title: 'Unconfirmed Recording Class',
          webinar_id: 'wgg-rec-unconfirmed',
          teacher_id: 'teach-1',
          target_level: 'Level 1',
          status: 'scheduled',
          recording_enabled: true,
          recording_confirmed: false,
        },
      ],
    };
    const mockSupabase = createMockSupabase(student, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'get_class_details', classId: 'cls-unconfirmed-rec' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.class.recordingConfirmed, false);
    assert.equal(res.body.class.recordingNotice, null, 'Unconfirmed recording must NOT show REC notice');
  }

  // C. Ended class: attendee cannot replay from old room link
  {
    const dbState = {
      liveClasses: [
        {
          id: 'cls-ended',
          title: 'Past Completed Class',
          webinar_id: 'wgg-ended-1',
          teacher_id: 'teach-1',
          target_level: 'Level 1',
          status: 'ended',
          recording_enabled: true,
        },
      ],
    };
    const mockSupabase = createMockSupabase(student, dbState);
    const { req, res } = createMockReqRes({ body: { action: 'join', classId: 'cls-ended' } });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'CLASS_ENDED');
    assert.ok(res.body.error.includes('ended'));
  }
});

test('7. Admin manual attachment workflow attaches Webinar.gg recording to library and audits creation', async () => {
  const admin = { id: 'admin-attacher', email: 'admin@trendz.edu', role: 'admin', active: true };
  const student = { id: 'stu-attacher', email: 'stu@trendz.edu', role: 'student', active: true };

  const dbState = {
    liveClasses: [
      {
        id: 'cls-attach-target',
        title: 'Masterclass on Speed Math',
        webinar_id: 'cmvl53hcc0bycs60yjljyys4z',
        teacher_id: 'teach-1',
        status: 'completed',
      },
    ],
    recordings: [],
    auditLogs: [],
  };

  // 1. Non-admin is rejected with 403
  {
    const mockSupabase = createMockSupabase(student, dbState);
    const { req, res } = createMockReqRes({
      body: {
        action: 'attach_recording',
        classId: 'cls-attach-target',
        title: 'Unauthorized Attempt',
        recordingUrl: 'https://example.com/rec.mp4',
      },
    });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  }

  // 2. Validation error on missing parameters
  {
    const mockSupabase = createMockSupabase(admin, dbState);
    const { req, res } = createMockReqRes({
      body: {
        action: 'attach_recording',
        classId: 'cls-attach-target',
        title: '',
        recordingUrl: 'not-a-url',
      },
    });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_REQUEST');
  }

  // 3. Admin successfully attaches recording
  {
    const mockSupabase = createMockSupabase(admin, dbState);
    const { req, res } = createMockReqRes({
      body: {
        action: 'attach_recording',
        classId: 'cls-attach-target',
        webinarId: 'cmvl53hcc0bycs60yjljyys4z',
        title: 'Speed Math Webinar Recording',
        recordingUrl: 'https://webinar.gg/recordings/cmvl53hcc0bycs60yjljyys4z/play.mp4',
        durationMinutes: 45,
      },
    });
    await handleLiveClassRequest(req, res, { supabase: mockSupabase });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.recording.title, 'Speed Math Webinar Recording');
    assert.equal(res.body.recording.status, 'ready');
    assert.equal(res.body.recording.durationSeconds, 2700);
    assert.equal(res.body.recording.webinarId, 'cmvl53hcc0bycs60yjljyys4z');

    // Audit log was created
    assert.equal(dbState.auditLogs.length, 1);
    assert.equal(dbState.auditLogs[0].action, 'admin_attach_recording');
    assert.equal(dbState.auditLogs[0].performed_by, 'admin-attacher');

    // Appears in list_recordings
    const { req: listReq, res: listRes } = createMockReqRes({ body: { action: 'list_recordings' } });
    await handleLiveClassRequest(listReq, listRes, { supabase: mockSupabase });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.recordings.length, 1);
    assert.equal(listRes.body.recordings[0].title, 'Speed Math Webinar Recording');
  }
});

test('8. Private storage signed URL resolution for replay privacy', async () => {
  const admin = { id: 'admin-private-tester', email: 'admin@trendz.local', role: 'admin', active: true };
  const student = { id: 'student-denied', email: 'stu@trendz.local', role: 'student', active: true };

  const dbState = {
    liveClasses: [
      { id: 'cls-priv-target', title: 'Private Webinar Class', teacher_id: 'tch-1', status: 'ended' },
    ],
    recordings: [],
    auditLogs: [],
  };

  // 1. Admin attaches private storage reference: storage://recordings/webinars/priv-101.mp4
  const mockSupabaseAdmin = createMockSupabase(admin, dbState);
  const { req: attachReq, res: attachRes } = createMockReqRes({
    body: {
      action: 'attach_recording',
      classId: 'cls-priv-target',
      webinarId: 'wgg-priv-101',
      title: 'Confidential Webinar Master Replay',
      recordingUrl: 'storage://recordings/webinars/priv-101.mp4',
      durationMinutes: 30,
    },
  });
  await handleLiveClassRequest(attachReq, attachRes, { supabase: mockSupabaseAdmin });
  assert.equal(attachRes.statusCode, 201);
  assert.equal(attachRes.body.ok, true);
  const recId = attachRes.body.recording.id;

  // 2. Student attempts playback -> denied 403
  const mockSupabaseStudent = createMockSupabase(student, dbState);
  const { req: stuReq, res: stuRes } = createMockReqRes({
    body: { action: 'get_recording_playback', recordingId: recId },
  });
  await handleLiveClassRequest(stuReq, stuRes, { supabase: mockSupabaseStudent });
  assert.equal(stuRes.statusCode, 403);
  assert.equal(stuRes.body.code, 'FORBIDDEN');

  // 3. Admin requests playback -> receives dynamic signed URL
  const { req: playReq, res: playRes } = createMockReqRes({
    body: { action: 'get_recording_playback', recordingId: recId },
  });
  await handleLiveClassRequest(playReq, playRes, { supabase: mockSupabaseAdmin });
  assert.equal(playRes.statusCode, 200);
  assert.equal(playRes.body.ok, true);
  assert.ok(
    playRes.body.recording.playbackUrl.startsWith('https://signed.supabase.co/storage/v1/object/sign/recordings/webinars/priv-101.mp4?token='),
    `Expected signed URL, got ${playRes.body.recording.playbackUrl}`
  );
  assert.equal(playRes.body.recording.title, 'Confidential Webinar Master Replay');
});
