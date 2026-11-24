/**
 * Trendz Tracker — Live Classes & Webinar.gg Integration Engine (api/_liveClass.js)
 *
 * Server-authoritative lifecycle for live abacus classes:
 * - Admin setup & class publishing
 * - Teacher workspace host integration
 * - Student Today page card & dedicated embedded live room
 * - Server-only Webinar.gg token minting (POST /api/v1/webinar/join-token)
 * - Strict Supabase JWT verification and role/audience authorization
 * - Strict Cache-Control: no-store on join responses
 *
 * Adheres to Vercel Hobby serverless limits (delegated from api/live-class.js).
 */

import { getAdminClient, getCallerClient } from './_supabaseAdmin.js';
import { hasSupabaseAdminConfig } from './_configHelper.js';

const WEBINAR_API_BASE = 'https://webinar-api.webinar.gg/api/v1';

export function getWebinarGgToken() {
  return (process.env.WEBINAR_GG_TOKEN || '').trim();
}

/**
 * Extracts Bearer token from Authorization header
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/**
 * Authenticates caller via Supabase Auth and loads profile
 */
async function authenticateCaller(supabase, req) {
  const token = extractBearerToken(req);
  if (!token) {
    const err = new Error('Authentication required. Missing Bearer token.');
    err.statusCode = 401;
    err.code = 'UNAUTHENTICATED';
    throw err;
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    const err = new Error('Invalid or expired authentication token.');
    err.statusCode = 401;
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const { data: profile, error: profError } = await supabase
    .from('profiles')
    .select('id, full_name, role, level, active')
    .eq('id', user.id)
    .single();

  if (profError || !profile) {
    const err = new Error('User profile not found.');
    err.statusCode = 403;
    err.code = 'PROFILE_NOT_FOUND';
    throw err;
  }

  if (!profile.active) {
    const err = new Error('Account is inactive. Please contact your administrator.');
    err.statusCode = 403;
    err.code = 'INACTIVE_ACCOUNT';
    throw err;
  }

  return {
    id: profile.id,
    email: user.email || `${profile.id}@trendz.local`,
    fullName: profile.full_name || 'User',
    role: profile.role,
    level: profile.level,
  };
}

/**
 * Checks whether student is in target audience for the class
 */
export function isStudentInAudience(student, liveClass) {
  if (!student || student.role !== 'student') return false;

  // 1. Explicit target student IDs list takes precedence
  if (Array.isArray(liveClass.target_student_ids) && liveClass.target_student_ids.length > 0) {
    return liveClass.target_student_ids.includes(student.id);
  }

  // 2. Level targeting
  if (liveClass.target_level) {
    return student.level === liveClass.target_level;
  }

  // 3. If neither target_student_ids nor target_level is set, open to all active students
  return true;
}

/**
 * Derives synthetic name and phone for Webinar.gg API compliance
 */
export function formatWebinarParticipant(fullName, email, fallbackId) {
  const parts = (fullName || 'Student').trim().split(/\s+/);
  const firstName = parts[0] || 'Student';
  const lastName = parts.slice(1).join(' ') || '.';
  const sanitizedEmail = email || `student_${fallbackId || 'guest'}@trendz.local`;
  // Test placeholder phone to fulfill Webinar.gg 6-field required schema without collecting real child phone numbers
  const phone = '+910000000000';

  return { firstName, lastName, email: sanitizedEmail, phone };
}

/**
 * Mints Webinar.gg join token
 */
async function mintWebinarJoinToken({ webinarId, firstName, lastName, email, phone, passcode = '' }, fetchImpl = fetch) {
  const apiToken = getWebinarGgToken();
  if (!apiToken) {
    const err = new Error('Webinar.gg provider token (WEBINAR_GG_TOKEN) is not configured on the server.');
    err.statusCode = 500;
    err.code = 'PROVIDER_TOKEN_MISSING';
    throw err;
  }

  const payload = {
    webinarId,
    firstName,
    lastName,
    email,
    phone,
    passcode: passcode || '',
  };

  const response = await fetchImpl(`${WEBINAR_API_BASE}/webinar/join-token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const resText = await response.text();
  let resJson = null;
  try {
    resJson = resText && resText.trim() ? JSON.parse(resText) : null;
  } catch (_) {
    resJson = null;
  }

  if (!response.ok || !resJson?.success || !resJson?.data?.token) {
    const errMsg = resJson?.error || `Failed to obtain join token from Webinar.gg (Status ${response.status})`;
    const err = new Error(errMsg);
    err.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    err.code = 'PROVIDER_JOIN_TOKEN_ERROR';
    throw err;
  }

  return {
    token: resJson.data.token,
    expiresAt: resJson.data.expiresAt,
    expiresInSeconds: resJson.data.expiresInSeconds || 600,
  };
}

/**
 * Reads provider webinar status and settings (e.g. recording confirmation)
 */
async function fetchProviderWebinarInfo(webinarId, fetchImpl = fetch) {
  const apiToken = getWebinarGgToken();
  if (!apiToken) return null;

  try {
    const response = await fetchImpl(`${WEBINAR_API_BASE}/webinar/${encodeURIComponent(webinarId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
      },
    });

    if (!response.ok) return null;
    const json = await response.json();
    return {
      status: json?.data?.status || null,
      recordingEnabled: json?.data?.recordingEnabled === true,
      title: json?.data?.title || null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Reads provider webinar status (backward compatibility alias)
 */
async function fetchProviderWebinarStatus(webinarId, fetchImpl = fetch) {
  const info = await fetchProviderWebinarInfo(webinarId, fetchImpl);
  return info?.status || null;
}

/**
 * Main Live Class Request Handler
 */
export async function handleLiveClassRequest(req, res, options = {}) {
  // CORS & Security headers
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const callerToken = extractBearerToken(req);
  const supabase = options.supabase || (hasSupabaseAdminConfig() ? getAdminClient() : getCallerClient(callerToken || ''));
  const fetchImpl = options.fetch || fetch;

  try {
    const caller = await authenticateCaller(supabase, req);
    const body = req.body || {};
    const action = body.action || 'get_class_details';

    switch (action) {
      // 1. Get Class Details (metadata without leaking provider tokens or internal IDs)
      case 'get_class_details': {
        const { classId } = body;
        if (!classId) {
          return res.status(400).json({ error: 'Missing required classId parameter.', code: 'INVALID_REQUEST' });
        }

        let liveClass = null;
        const { data: fullClass, error } = await supabase
          .from('live_classes')
          .select(`
            id,
            title,
            webinar_id,
            teacher_id,
            host_email,
            invited_teacher_ids,
            target_level,
            target_student_ids,
            scheduled_start_time,
            duration_minutes,
            status,
            provider_status,
            notes,
            class_type,
            recording_enabled,
            prerecorded_asset_url,
            stream_url,
            teacher:profiles!teacher_id (id, full_name)
          `)
          .eq('id', classId)
          .single();

        if (error) {
          if (error.code === '42703' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('column')) {
            const { data: baseClass, error: baseError } = await supabase
              .from('live_classes')
              .select(`
                id,
                title,
                webinar_id,
                teacher_id,
                host_email,
                invited_teacher_ids,
                target_level,
                target_student_ids,
                scheduled_start_time,
                duration_minutes,
                status,
                provider_status,
                notes,
                teacher:profiles!teacher_id (id, full_name)
              `)
              .eq('id', classId)
              .single();

            if (baseError || !baseClass) {
              return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
            }
            liveClass = {
              ...baseClass,
              class_type: 'live',
              recording_enabled: true,
              prerecorded_asset_url: null,
              stream_url: null,
            };
          } else {
            return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
          }
        } else {
          liveClass = fullClass;
        }

        if (!liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        // Live provider status check: sync provider status and verify recording configuration
        let currentStatus = liveClass.status;
        let providerStatus = liveClass.provider_status;
        let providerInfo = null;
        if (liveClass.webinar_id && currentStatus !== 'ended' && currentStatus !== 'cancelled') {
          providerInfo = await fetchProviderWebinarInfo(liveClass.webinar_id, fetchImpl);
          const liveProviderStatus = providerInfo?.status;
          if (liveProviderStatus) {
            providerStatus = liveProviderStatus;
            if (liveProviderStatus === 'completed' || liveProviderStatus === 'ended') {
              currentStatus = 'ended';
            } else if (liveProviderStatus === 'ongoing' && currentStatus !== 'ended') {
              currentStatus = 'live';
            }
            if (providerStatus !== liveClass.provider_status || currentStatus !== liveClass.status) {
              await supabase
                .from('live_classes')
                .update({
                  provider_status: providerStatus,
                  status: currentStatus,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', classId);
            }
          }
        }

        const providerRecordingConfirmed = providerInfo ? providerInfo.recordingEnabled === true : false;
        const isRecordingConfirmed = Boolean(
          liveClass.recording_confirmed === true || providerRecordingConfirmed
        );

        const isInvitedParticipant = caller.role === 'teacher' && Boolean(
          Array.isArray(liveClass.invited_teacher_ids) && liveClass.invited_teacher_ids.includes(caller.id)
        );
        const isAssignedTeacher = caller.role === 'teacher' && caller.id === liveClass.teacher_id;
        const isHost = caller.role === 'admin' && Boolean(liveClass.host_email && caller.email === liveClass.host_email);
        const isHostIdentityMismatch = caller.role === 'admin' && Boolean(liveClass.host_email && caller.email !== liveClass.host_email);
        const hostingDisabled = caller.role === 'teacher' && !isInvitedParticipant;

        if (caller.role === 'teacher') {
          if (!isInvitedParticipant && !isAssignedTeacher) {
            return res.status(403).json({ error: 'You are not invited to participate in this live class.', code: 'NOT_INVITED' });
          }
        }

        if (caller.role === 'student' && !isStudentInAudience(caller, liveClass)) {
          return res.status(403).json({ error: 'You are not enrolled in this live class.', code: 'NOT_ENROLLED' });
        }

        return res.status(200).json({
          ok: true,
          class: {
            id: liveClass.id,
            title: liveClass.title,
            teacherName: liveClass.teacher?.full_name || 'Assigned Teacher',
            hostEmail: liveClass.host_email,
            targetLevel: liveClass.target_level,
            scheduledStartTime: liveClass.scheduled_start_time,
            durationMinutes: liveClass.duration_minutes,
            status: currentStatus,
            providerStatus: providerStatus,
            classType: liveClass.class_type || 'live',
            recordingEnabled: liveClass.recording_enabled !== false,
            recordingConfirmed: isRecordingConfirmed,
            prerecordedAssetUrl: liveClass.prerecorded_asset_url || null,
            streamUrl: liveClass.stream_url || null,
            recordingNotice: (liveClass.recording_enabled !== false && isRecordingConfirmed)
              ? 'This live class is being recorded for academic review.'
              : null,
            notes: liveClass.notes,
            isHost,
            hostingDisabled,
            isInvitedParticipant,
            isHostIdentityMismatch,
            requiredHostEmail: liveClass.host_email,
          },
        });
      }

      // 2. Join Live Class (Mints one-time join token server-side and constructs embed URL)
      case 'join': {
        const { classId } = body;
        if (!classId) {
          return res.status(400).json({ error: 'Missing required classId parameter.', code: 'INVALID_REQUEST' });
        }

        let liveClass = null;
        const { data: fullClass, error } = await supabase
          .from('live_classes')
          .select(`
            id,
            title,
            webinar_id,
            teacher_id,
            host_email,
            invited_teacher_ids,
            target_level,
            target_student_ids,
            scheduled_start_time,
            duration_minutes,
            status,
            provider_status,
            class_type,
            recording_enabled,
            prerecorded_asset_url,
            stream_url,
            teacher:profiles!teacher_id (id, full_name)
          `)
          .eq('id', classId)
          .single();

        if (error) {
          if (error.code === '42703' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('column')) {
            const { data: baseClass, error: baseError } = await supabase
              .from('live_classes')
              .select(`
                id,
                title,
                webinar_id,
                teacher_id,
                host_email,
                invited_teacher_ids,
                target_level,
                target_student_ids,
                scheduled_start_time,
                duration_minutes,
                status,
                provider_status,
                teacher:profiles!teacher_id (id, full_name)
              `)
              .eq('id', classId)
              .single();

            if (baseError || !baseClass) {
              return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
            }
            liveClass = {
              ...baseClass,
              class_type: 'live',
              recording_enabled: true,
              prerecorded_asset_url: null,
              stream_url: null,
            };
          } else {
            return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
          }
        } else {
          liveClass = fullClass;
        }

        if (!liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        if (liveClass.status === 'cancelled') {
          return res.status(400).json({ error: 'This live class has been cancelled.', code: 'CLASS_CANCELLED' });
        }

        if (liveClass.status === 'ended') {
          return res.status(400).json({ error: 'This live class has already ended.', code: 'CLASS_ENDED' });
        }

        // Scheduled Prerecorded Class workflow
        if (liveClass.class_type === 'prerecorded') {
          if (caller.role === 'student' && !isStudentInAudience(caller, liveClass)) {
            return res.status(403).json({ error: 'You are not enrolled in this scheduled class.', code: 'NOT_ENROLLED' });
          }
          if (caller.role === 'teacher') {
            const isInvitedParticipant = Boolean(
              Array.isArray(liveClass.invited_teacher_ids) && liveClass.invited_teacher_ids.includes(caller.id)
            );
            if (!isInvitedParticipant && caller.id !== liveClass.teacher_id) {
              return res.status(403).json({ error: 'You are not invited to participate in this class.', code: 'NOT_INVITED' });
            }
          }

          return res.status(200).json({
            ok: true,
            classType: 'prerecorded',
            classTitle: liveClass.title,
            assetUrl: liveClass.prerecorded_asset_url,
            scheduledStartTime: liveClass.scheduled_start_time,
            durationMinutes: liveClass.duration_minutes,
            teacherName: liveClass.teacher?.full_name || 'Assigned Teacher',
            status: liveClass.status,
          });
        }

        // Provider status & recording info check before minting join token
        const providerInfo = await fetchProviderWebinarInfo(liveClass.webinar_id, fetchImpl);
        const providerStatus = providerInfo?.status || liveClass.provider_status;
        const providerRecordingConfirmed = providerInfo ? providerInfo.recordingEnabled === true : false;
        const isRecordingConfirmed = Boolean(
          liveClass.recording_confirmed === true || providerRecordingConfirmed
        );

        if (providerStatus === 'completed' || providerStatus === 'ended' || liveClass.status === 'ended') {
          await supabase
            .from('live_classes')
            .update({
              provider_status: providerStatus || 'completed',
              status: 'ended',
              updated_at: new Date().toISOString(),
            })
            .eq('id', classId);
          return res.status(400).json({
            error: 'This live class has already ended. Live room access is closed and recordings cannot be replayed from the room link.',
            code: 'CLASS_ENDED',
          });
        }

        let isHost = false;
        let participant = null;

        if (caller.role === 'teacher') {
          const isInvitedParticipant = Boolean(
            Array.isArray(liveClass.invited_teacher_ids) && liveClass.invited_teacher_ids.includes(caller.id)
          );
          if (!isInvitedParticipant) {
            if (caller.id === liveClass.teacher_id) {
              return res.status(403).json({
                error: 'Teacher hosting is currently disabled. Hosting requires an individual Webinar.gg host account or configured co-host delegation without impersonation.',
                code: 'TEACHER_HOSTING_DISABLED',
              });
            }
            return res.status(403).json({
              error: 'You are not invited as a participant to this live class.',
              code: 'NOT_INVITED',
            });
          }

          // Invited teacher joins strictly as a participant under their own identity (NEVER owner's host email)
          isHost = false;
          participant = formatWebinarParticipant(caller.fullName, caller.email, caller.id);
        } else if (caller.role === 'student') {
          if (!isStudentInAudience(caller, liveClass)) {
            return res.status(403).json({ error: 'You are not enrolled in this live class.', code: 'NOT_ENROLLED' });
          }
          participant = formatWebinarParticipant(caller.fullName, caller.email, caller.id);
        } else if (caller.role === 'admin') {
          // Admin can only host if their own account email matches the configured host_email
          if (liveClass.host_email && caller.email === liveClass.host_email) {
            isHost = true;
            participant = {
              firstName: caller.fullName.split(/\s+/)[0] || 'Admin',
              lastName: caller.fullName.split(/\s+/).slice(1).join(' ') || 'Host',
              email: liveClass.host_email,
              phone: '+919999999999',
            };
          } else {
            return res.status(403).json({
              error: `Admin hosting requires caller account email to match the configured Webinar.gg host account (${liveClass.host_email || 'none'}).`,
              code: 'HOST_IDENTITY_MISMATCH',
              requiredHostEmail: liveClass.host_email,
            });
          }
        } else {
          return res.status(403).json({ error: 'Unauthorized role for live class access.', code: 'UNAUTHORIZED_ROLE' });
        }

        // Mint short-lived join token server-to-server
        const tokenData = await mintWebinarJoinToken({
          webinarId: liveClass.webinar_id,
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          phone: participant.phone,
          passcode: '',
        }, fetchImpl);

        const embedUrl = `https://webinar.gg/webinar-page/${liveClass.webinar_id}?token=${tokenData.token}`;

        return res.status(200).json({
          ok: true,
          isHost,
          token: tokenData.token,
          webinarId: liveClass.webinar_id,
          embedUrl,
          classTitle: liveClass.title,
          teacherName: liveClass.teacher?.full_name || 'Assigned Teacher',
          scheduledStartTime: liveClass.scheduled_start_time,
          status: liveClass.status,
          expiresInSeconds: tokenData.expiresInSeconds,
          classType: liveClass.class_type || 'live',
          recordingEnabled: liveClass.recording_enabled !== false,
          recordingConfirmed: isRecordingConfirmed,
          recordingNotice: (liveClass.recording_enabled !== false && isRecordingConfirmed)
            ? 'This live class is being recorded for academic review.'
            : null,
        });
      }

      // 3. Sync Provider Status (queries Webinar.gg API to check if session is 'ongoing' / live)
      case 'sync_provider_status': {
        const { classId } = body;
        if (!classId) {
          return res.status(400).json({ error: 'Missing required classId parameter.', code: 'INVALID_REQUEST' });
        }

        const { data: liveClass, error } = await supabase
          .from('live_classes')
          .select('id, webinar_id, status, provider_status')
          .eq('id', classId)
          .single();

        if (error || !liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        const providerStatus = await fetchProviderWebinarStatus(liveClass.webinar_id, fetchImpl);
        let nextStatus = liveClass.status;

        if (providerStatus === 'ongoing' && liveClass.status !== 'ended') {
          nextStatus = 'live';
        } else if (providerStatus === 'completed' || providerStatus === 'ended') {
          nextStatus = 'ended';
        }

        if (providerStatus && (providerStatus !== liveClass.provider_status || nextStatus !== liveClass.status)) {
          await supabase
            .from('live_classes')
            .update({
              provider_status: providerStatus,
              status: nextStatus,
              updated_at: new Date().toISOString(),
            })
            .eq('id', classId);
        }

        return res.status(200).json({
          ok: true,
          status: nextStatus,
          providerStatus,
        });
      }

      // 4. List Live Classes (for Admin & Teacher workspaces)
      case 'list': {
        if (caller.role !== 'admin' && caller.role !== 'teacher') {
          return res.status(403).json({ error: 'Only teachers and administrators can list classes.', code: 'FORBIDDEN' });
        }

        let query = supabase
          .from('live_classes')
          .select(`
            id,
            title,
            webinar_id,
            teacher_id,
            host_email,
            invited_teacher_ids,
            target_level,
            target_student_ids,
            scheduled_start_time,
            duration_minutes,
            status,
            provider_status,
            created_at,
            teacher:profiles!teacher_id (id, full_name, student_code)
          `)
          .order('scheduled_start_time', { ascending: false });

        if (caller.role === 'teacher') {
          query = query.or(`teacher_id.eq.${caller.id},invited_teacher_ids.cs.["${caller.id}"]`);
        }

        const { data: classes, error } = await query;
        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        return res.status(200).json({
          ok: true,
          classes: classes || [],
        });
      }

      // 5. Create Live Class (Admin only)
      case 'create': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can create live classes.', code: 'FORBIDDEN' });
        }

        const {
          title,
          webinar_id: inputWebinarId,
          teacher_id,
          target_level,
          target_student_ids,
          invited_teacher_ids,
          scheduled_start_time,
          duration_minutes = 60,
          host_email = null,
          notes,
          class_type = 'live',
          recording_enabled = true,
          prerecorded_asset_url = null,
          stream_url = null,
        } = body;

        const effectiveWebinarId = inputWebinarId
          ? inputWebinarId.trim()
          : (class_type === 'prerecorded' ? `prerecorded-${Date.now()}` : null);

        if (!title || !effectiveWebinarId || !teacher_id || !scheduled_start_time) {
          return res.status(400).json({
            error: 'Missing required fields: title, webinar_id, teacher_id, scheduled_start_time.',
            code: 'INVALID_REQUEST',
          });
        }

        // Validate assignee server-side: allow self-assignment to the signed-in admin OR an active teacher account
        const { data: assigneeProfile, error: assigneeErr } = await supabase
          .from('profiles')
          .select('id, role, active, full_name')
          .eq('id', teacher_id)
          .single();

        if (assigneeErr || !assigneeProfile || !assigneeProfile.active) {
          return res.status(400).json({
            error: 'Assigned staff member not found or inactive.',
            code: 'INVALID_ASSIGNEE',
          });
        }

        const isSelfAdmin = assigneeProfile.id === caller.id && caller.role === 'admin';
        const isActiveTeacher = assigneeProfile.role === 'teacher';

        if (!isSelfAdmin && !isActiveTeacher) {
          return res.status(400).json({
            error: 'Classes can only be assigned to the signed-in admin or an active teacher.',
            code: 'INVALID_ASSIGNEE',
          });
        }

        // Keep invited teachers separate from the primary assigned teacher
        const cleanedInvitedTeacherIds = Array.isArray(invited_teacher_ids) && invited_teacher_ids.length > 0
          ? invited_teacher_ids.filter((id) => id && id !== teacher_id)
          : null;

        const basePayload = {
          title: title.trim(),
          webinar_id: effectiveWebinarId,
          teacher_id,
          host_email: host_email ? host_email.trim() : null,
          target_level: target_level || null,
          target_student_ids: Array.isArray(target_student_ids) && target_student_ids.length > 0 ? target_student_ids : null,
          invited_teacher_ids: cleanedInvitedTeacherIds && cleanedInvitedTeacherIds.length > 0 ? cleanedInvitedTeacherIds : null,
          scheduled_start_time,
          duration_minutes: Number(duration_minutes) || 60,
          status: 'scheduled',
          notes: notes ? notes.trim() : null,
          created_by: caller.id,
        };

        const fullPayload = {
          ...basePayload,
          class_type,
          recording_enabled: recording_enabled !== false,
          prerecorded_asset_url: prerecorded_asset_url ? prerecorded_asset_url.trim() : null,
          stream_url: stream_url ? stream_url.trim() : null,
        };

        let { data: newClass, error } = await supabase
          .from('live_classes')
          .insert(fullPayload)
          .select(`
            id,
            title,
            webinar_id,
            teacher_id,
            scheduled_start_time,
            duration_minutes,
            status,
            class_type,
            recording_enabled,
            prerecorded_asset_url,
            stream_url,
            teacher:profiles!teacher_id (id, full_name)
          `)
          .single();

        if (error && (error.code === '42703' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('column'))) {
          const { data: fallbackClass, error: fallbackError } = await supabase
            .from('live_classes')
            .insert(basePayload)
            .select(`
              id,
              title,
              webinar_id,
              teacher_id,
              scheduled_start_time,
              duration_minutes,
              status,
              teacher:profiles!teacher_id (id, full_name)
            `)
            .single();

          if (fallbackError) {
            return res.status(500).json({ error: fallbackError.message, code: 'DATABASE_ERROR' });
          }
          newClass = {
            ...fallbackClass,
            class_type: 'live',
            recording_enabled: true,
            prerecorded_asset_url: null,
            stream_url: null,
          };
          error = null;
        }

        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        return res.status(201).json({
          ok: true,
          class: newClass,
        });
      }

      // 6. Update Class Status (Admin or Assigned Teacher)
      case 'update_status': {
        const { classId, status } = body;
        const validStatuses = ['scheduled', 'waiting', 'live', 'ended', 'cancelled'];
        if (!classId || !validStatuses.includes(status)) {
          return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`, code: 'INVALID_REQUEST' });
        }

        const { data: liveClass, error: findError } = await supabase
          .from('live_classes')
          .select('id, teacher_id')
          .eq('id', classId)
          .single();

        if (findError || !liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        if (caller.role !== 'admin' && caller.id !== liveClass.teacher_id) {
          return res.status(403).json({ error: 'Only the assigned teacher or an admin can update class status.', code: 'FORBIDDEN' });
        }

        const { data: updatedClass, error: updateError } = await supabase
          .from('live_classes')
          .update({
            status,
            updated_at: new Date().toISOString(),
          })
          .eq('id', classId)
          .select('id, status, updated_at')
          .single();

        if (updateError) {
          return res.status(500).json({ error: updateError.message, code: 'DATABASE_ERROR' });
        }

        return res.status(200).json({
          ok: true,
          class: updatedClass,
        });
      }

      // 7. List Recordings (Admin only)
      case 'list_recordings': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can view the recording library.', code: 'FORBIDDEN' });
        }

        const { teacherId, status, search } = body;
        let query = supabase
          .from('live_class_recordings')
          .select(`
            id,
            class_id,
            webinar_id,
            recording_id,
            title,
            status,
            duration_seconds,
            recorded_at,
            created_at,
            live_class:live_classes!class_id (
              id,
              title,
              scheduled_start_time,
              teacher:profiles!teacher_id (id, full_name, student_code)
            )
          `)
          .is('deleted_at', null)
          .order('recorded_at', { ascending: false });

        if (status) {
          query = query.eq('status', status);
        }

        let { data: recordings, error } = await query;
        if (error && (error.code === '42P01' || error.message?.includes('does not exist') || error.message?.includes('schema cache') || error.message?.includes('table'))) {
          return res.status(200).json({ ok: true, recordings: [] });
        }
        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        let filtered = recordings || [];
        if (teacherId) {
          filtered = filtered.filter((r) => r.live_class?.teacher?.id === teacherId);
        }
        if (search) {
          const s = search.toLowerCase();
          filtered = filtered.filter((r) =>
            (r.title && r.title.toLowerCase().includes(s)) ||
            (r.live_class?.title && r.live_class.title.toLowerCase().includes(s)) ||
            (r.live_class?.teacher?.full_name && r.live_class.teacher.full_name.toLowerCase().includes(s)) ||
            (r.webinar_id && r.webinar_id.toLowerCase().includes(s))
          );
        }

        return res.status(200).json({
          ok: true,
          recordings: filtered.map((r) => ({
            id: r.id,
            classId: r.class_id,
            classTitle: r.live_class?.title || 'Live Class',
            teacherName: r.live_class?.teacher?.full_name || 'Assigned Teacher',
            teacherCode: r.live_class?.teacher?.student_code || '',
            webinarId: r.webinar_id,
            recordingId: r.recording_id,
            title: r.title,
            status: r.status,
            durationSeconds: r.duration_seconds,
            recordedAt: r.recorded_at,
            createdAt: r.created_at,
          })),
        });
      }

      // 8. Get Recording Playback (Admin only)
      case 'get_recording_playback': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators have access to class recording replays.', code: 'FORBIDDEN' });
        }

        const { recordingId } = body;
        if (!recordingId) {
          return res.status(400).json({ error: 'Missing required recordingId parameter.', code: 'INVALID_REQUEST' });
        }

        const { data: recording, error } = await supabase
          .from('live_class_recordings')
          .select(`
            id,
            class_id,
            webinar_id,
            recording_id,
            title,
            status,
            duration_seconds,
            playback_url,
            download_url,
            deleted_at,
            live_class:live_classes!class_id (
              id,
              title,
              teacher:profiles!teacher_id (id, full_name)
            )
          `)
          .eq('id', recordingId)
          .single();

        if (error || !recording || recording.deleted_at) {
          return res.status(404).json({ error: 'Recording not found or has been removed.', code: 'RECORDING_NOT_FOUND' });
        }

        if (recording.status !== 'ready') {
          return res.status(400).json({
            error: `Recording is not ready for playback (Current state: ${recording.status}).`,
            code: 'RECORDING_NOT_READY',
          });
        }

        // Audit playback access
        try {
          await supabase
            .from('live_class_recording_audit_log')
            .insert({
              recording_id: recording.id,
              class_id: recording.class_id,
              webinar_id: recording.webinar_id,
              action: 'view_recording',
              performed_by: caller.id,
              details: { accessed_at: new Date().toISOString() },
            });
        } catch (_) {}

        // Resolve private Supabase Storage signed URLs if stored as a private storage reference
        let playbackUrl = recording.playback_url;
        if (typeof playbackUrl === 'string' && (playbackUrl.startsWith('storage://') || playbackUrl.startsWith('private://'))) {
          try {
            const rawPath = playbackUrl.replace(/^(storage|private):\/\//, '');
            const slashIdx = rawPath.indexOf('/');
            if (slashIdx !== -1 && supabase.storage) {
              const bucket = rawPath.slice(0, slashIdx);
              const objectPath = rawPath.slice(slashIdx + 1);
              const { data: signedData, error: signErr } = await supabase.storage
                .from(bucket)
                .createSignedUrl(objectPath, 3600);
              if (!signErr && signedData?.signedUrl) {
                playbackUrl = signedData.signedUrl;
              }
            }
          } catch (_) {}
        }

        return res.status(200).json({
          ok: true,
          recording: {
            id: recording.id,
            title: recording.title,
            classTitle: recording.live_class?.title || 'Live Class',
            teacherName: recording.live_class?.teacher?.full_name || 'Assigned Teacher',
            durationSeconds: recording.duration_seconds,
            playbackUrl,
          },
        });
      }

      // 9. Delete Recording ("Remove from Trendz" with audit log + dashboard notice)
      case 'delete_recording': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can remove recordings.', code: 'FORBIDDEN' });
        }

        const { recordingId, reason = '' } = body;
        if (!recordingId) {
          return res.status(400).json({ error: 'Missing required recordingId parameter.', code: 'INVALID_REQUEST' });
        }

        const { data: recording, error: findError } = await supabase
          .from('live_class_recordings')
          .select('id, class_id, webinar_id, recording_id, title')
          .eq('id', recordingId)
          .single();

        if (findError || !recording) {
          return res.status(404).json({ error: 'Recording not found.', code: 'RECORDING_NOT_FOUND' });
        }

        // Soft delete from Trendz database
        const { error: updateError } = await supabase
          .from('live_class_recordings')
          .update({
            status: 'deleted',
            deleted_at: new Date().toISOString(),
            deleted_by: caller.id,
            deletion_reason: reason.trim() || 'Admin deleted recording from Trendz Tracker',
            updated_at: new Date().toISOString(),
          })
          .eq('id', recordingId);

        if (updateError) {
          return res.status(500).json({ error: updateError.message, code: 'DATABASE_ERROR' });
        }

        // Audit log
        try {
          await supabase
            .from('live_class_recording_audit_log')
            .insert({
              recording_id: recording.id,
              class_id: recording.class_id,
              webinar_id: recording.webinar_id,
              action: 'remove_from_trendz',
              performed_by: caller.id,
              details: { reason: reason.trim(), title: recording.title },
            });
        } catch (_) {}

        return res.status(200).json({
          ok: true,
          recordingId,
          message: 'Recording removed from Trendz Tracker.',
          providerNotice: 'Recording reference has been removed from Trendz. Because Webinar.gg does not support granular recording file deletion via API, the raw video file must be deleted manually from the Webinar.gg Web Dashboard > Recordings.',
        });
      }

      // 10. Admin Attach Webinar Recording (Manual Dashboard Workflow)
      case 'attach_recording': {
        if (caller.role !== 'admin') {
          return res.status(403).json({ error: 'Only administrators can attach webinar recordings.', code: 'FORBIDDEN' });
        }

        const { classId, webinarId, title, recordingUrl, durationSeconds, durationMinutes } = body;
        if (!classId || typeof classId !== 'string') {
          return res.status(400).json({ error: 'Missing required classId parameter.', code: 'INVALID_REQUEST' });
        }
        if (!title || typeof title !== 'string' || !title.trim()) {
          return res.status(400).json({ error: 'Recording title is required.', code: 'INVALID_REQUEST' });
        }
        const isValidUrl = typeof recordingUrl === 'string' && (
          recordingUrl.startsWith('http://') ||
          recordingUrl.startsWith('https://') ||
          recordingUrl.startsWith('storage://') ||
          recordingUrl.startsWith('private://')
        );
        if (!isValidUrl) {
          return res.status(400).json({ error: 'A valid recording URL (http/https/storage) is required.', code: 'INVALID_REQUEST' });
        }

        const { data: liveClass, error: classError } = await supabase
          .from('live_classes')
          .select('id, title, webinar_id')
          .eq('id', classId)
          .single();

        if (classError || !liveClass) {
          return res.status(404).json({ error: 'Associated live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        const effectiveWebinarId = webinarId?.trim() || liveClass.webinar_id || 'manual-webinar';
        const calcDurationSeconds = durationSeconds ? Number(durationSeconds) : durationMinutes ? Math.round(Number(durationMinutes) * 60) : 0;

        const recordingPayload = {
          class_id: liveClass.id,
          webinar_id: effectiveWebinarId,
          recording_id: `rec-att-${Date.now()}`,
          title: title.trim(),
          duration_seconds: calcDurationSeconds,
          status: 'ready',
          playback_url: recordingUrl.trim(),
          recorded_at: new Date().toISOString(),
        };

        const { data: recording, error: insertError } = await supabase
          .from('live_class_recordings')
          .insert(recordingPayload)
          .select('id, class_id, webinar_id, recording_id, title, status, duration_seconds, playback_url, recorded_at')
          .single();

        if (insertError) {
          return res.status(500).json({
            error: `Failed to attach recording to database: ${insertError.message}`,
            code: 'DATABASE_ERROR',
          });
        }

        try {
          await supabase.from('live_class_recording_audit_log').insert({
            recording_id: recording.id,
            class_id: liveClass.id,
            webinar_id: effectiveWebinarId,
            action: 'admin_attach_recording',
            performed_by: caller.id,
            details: {
              title: recording.title,
              recordingUrl: recording.playback_url,
              durationSeconds: recording.duration_seconds,
              workflow: 'manual_dashboard_attachment',
            },
          });
        } catch (_) {}

        return res.status(201).json({
          ok: true,
          message: 'Webinar recording attached to library.',
          recording: {
            id: recording.id,
            classId: recording.class_id,
            webinarId: recording.webinar_id,
            recordingId: recording.recording_id,
            title: recording.title,
            status: recording.status,
            durationSeconds: recording.duration_seconds,
            playbackUrl: recording.playback_url,
            recordedAt: recording.recorded_at,
          },
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}`, code: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({
      error: err?.message || 'An unexpected error occurred processing live class request.',
      code: err?.code || 'INTERNAL_ERROR',
    });
  }
}
