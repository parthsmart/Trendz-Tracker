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

import { randomBytes } from 'node:crypto';
import { getAdminClient, getCallerClient } from './_supabaseAdmin.js';
import { hasSupabaseAdminConfig } from './_configHelper.js';

const WEBINAR_API_BASE = 'https://webinar-api.webinar.gg/api/v1';
const PRIVATE_RECORDINGS_BUCKET = process.env.PRIVATE_RECORDINGS_BUCKET || 'recordings';

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
    cohostEmail: user.app_metadata?.webinar_cohost_email,
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
      cohostsCanStart: json?.data?.cohostPermissions?.startWebinar === true,
      title: json?.data?.title || null,
      passcode: typeof json?.data?.passcode === 'string' ? json.data.passcode : '',
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

function getHostDashboardUrl(caller, liveClass) {
  const { host_email, class_type, status, provider_status, webinar_id } = liveClass;
  if (caller.role !== 'admin' || !host_email || caller.email !== host_email ||
      (class_type || 'live') !== 'live' || ['ended', 'cancelled'].includes(status) ||
      ['ended', 'completed'].includes(provider_status) || !/^[a-zA-Z0-9_-]+$/.test(webinar_id || '')) {
    return null;
  }
  return `https://webinar.gg/webinars/schedule-webinar/details/webinardetails/${webinar_id}`;
}

function normalizeCohostEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('.local') ? email : '';
}

async function requestCohostSetup(webinarId, resource, fetchImpl, method = 'GET', body) {
  const token = getWebinarGgToken();
  if (!token) throw new Error('Webinar.gg is not configured.');
  const response = await fetchImpl(`${WEBINAR_API_BASE}/webinar/${encodeURIComponent(webinarId)}/${resource}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error('Webinar.gg could not confirm teacher hosting.');
  const result = await response.json();
  if (result.success !== true) throw new Error('Webinar.gg could not confirm teacher hosting.');
  return result.data;
}

async function hasWebinarCohost(webinarId, email, fetchImpl) {
  const data = await requestCohostSetup(webinarId, 'cohosts', fetchImpl);
  const cohosts = Array.isArray(data) ? data : data?.cohosts;
  if (!Array.isArray(cohosts)) throw new Error('Webinar.gg returned an invalid co-host list.');
  return cohosts.some((entry) => [entry.email, entry.user?.email]
    .some((address) => normalizeCohostEmail(address) === email));
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
        const classType = liveClass.class_type || 'live';
        let hostDashboardUrl = getHostDashboardUrl(caller, {
          ...liveClass, status: currentStatus, provider_status: providerStatus,
        });

        if (caller.role === 'teacher') {
          if (!isInvitedParticipant && !isAssignedTeacher) {
            return res.status(403).json({ error: 'You are not invited to participate in this live class.', code: 'NOT_INVITED' });
          }
        }

        if (caller.role === 'student' && !isStudentInAudience(caller, liveClass)) {
          return res.status(403).json({ error: 'You are not enrolled in this live class.', code: 'NOT_ENROLLED' });
        }

        const teacherEmail = normalizeCohostEmail(caller.cohostEmail);
        if (isAssignedTeacher && teacherEmail && classType === 'live' && providerInfo?.cohostsCanStart &&
            !['ended', 'cancelled'].includes(currentStatus) && !['ended', 'completed'].includes(providerStatus) &&
            /^[a-zA-Z0-9_-]+$/.test(liveClass.webinar_id || '')) {
          try {
            if (await hasWebinarCohost(liveClass.webinar_id, teacherEmail, fetchImpl)) {
              hostDashboardUrl = `https://webinar.gg/webinar-page/${liveClass.webinar_id}`;
            }
          } catch {
            return res.status(502).json({ error: 'Could not confirm your Webinar.gg hosting access. Try again.', code: 'COHOST_LOOKUP_FAILED' });
          }
        }
        const isTeacherCohost = isAssignedTeacher && Boolean(hostDashboardUrl);
        const hostingDisabled = caller.role === 'teacher' && !isInvitedParticipant && !isTeacherCohost;

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
            classType,
            recordingEnabled: liveClass.recording_enabled !== false,
            recordingConfirmed: isRecordingConfirmed,
            prerecordedAssetUrl: liveClass.prerecorded_asset_url || null,
            streamUrl: liveClass.stream_url || null,
            recordingNotice: isRecordingConfirmed
              ? 'This live class is being recorded for academic review.'
              : null,
            notes: liveClass.notes,
            isHost: isHost || isTeacherCohost,
            hostDashboardUrl,
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
          passcode: providerInfo?.passcode || '',
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
          recordingNotice: isRecordingConfirmed
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

        const columns = `
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
          `;
        const listClasses = (projection) => {
          const query = supabase.from('live_classes').select(projection)
            .order('scheduled_start_time', { ascending: false });
          return caller.role === 'teacher'
            ? query.or(`teacher_id.eq.${caller.id},invited_teacher_ids.cs.["${caller.id}"]`)
            : query;
        };
        let { data: classes, error } = await listClasses(`${columns}, class_type`);
        if (['42703', 'PGRST204'].includes(error?.code) && error.message?.includes('class_type')) {
          ({ data: classes, error } = await listClasses(columns));
        }
        if (error) {
          return res.status(500).json({ error: error.message, code: 'DATABASE_ERROR' });
        }

        return res.status(200).json({
          ok: true,
          classes: (classes || []).map((liveClass) => ({
            ...liveClass,
            hostDashboardUrl: getHostDashboardUrl(caller, liveClass),
          })),
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
          audience,
          invited_teacher_ids,
          scheduled_start_time,
          duration_minutes = 60,
          host_email = null,
          teacher_email = null,
          notes,
          class_type = 'live',
          recording_enabled = false,
          prerecorded_asset_url = null,
          stream_url = null,
        } = body;

        let effectiveWebinarId = typeof inputWebinarId === 'string' ? inputWebinarId.trim() : '';
        const startsAt = new Date(scheduled_start_time);
        const duration = Number(duration_minutes);
        if (typeof title !== 'string' || !title.trim() || !teacher_id || !scheduled_start_time ||
            !Number.isFinite(startsAt.getTime()) || !Number.isInteger(duration) ||
            duration < 15 || duration > 240 || (class_type === 'stream' && !effectiveWebinarId)) {
          return res.status(400).json({
            error: 'Enter a class title, teacher, valid start time, and duration from 15 to 240 minutes. Streams require an existing room.',
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

        if (audience !== undefined) {
          const hasLevel = typeof target_level === 'string' && Boolean(target_level.trim());
          const hasStudents = Array.isArray(target_student_ids) && target_student_ids.length > 0;
          if (!['all', 'level', 'students'].includes(audience) ||
              hasLevel !== (audience === 'level') || hasStudents !== (audience === 'students')) {
            return res.status(400).json({ error: 'Choose who can attend and complete the audience selection.', code: 'INVALID_AUDIENCE' });
          }
          if (hasLevel || hasStudents) {
            let roster = supabase.from('profiles').select('id').eq('role', 'student').eq('active', true);
            const ids = hasStudents ? [...new Set(target_student_ids)] : [];
            if (ids.some((id) => typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id))) {
              return res.status(400).json({ error: 'Choose active students from the roster.', code: 'INVALID_AUDIENCE' });
            }
            const { data: eligible, error: rosterError } = await (hasLevel
              ? roster.eq('level', target_level).limit(1)
              : roster.in('id', ids));
            if (rosterError) {
              return res.status(500).json({ error: 'Could not verify the student roster.', code: 'ROSTER_ERROR' });
            }
            if (eligible.length !== (hasLevel ? 1 : ids.length)) {
              return res.status(400).json({ error: 'Choose a level with active students or select active students from the roster.', code: 'INVALID_AUDIENCE' });
            }
          }
        }

        let teacherCohostEmail = '';
        if (isActiveTeacher && class_type === 'live') {
          const { data, error } = await supabase.auth.admin.getUserById(teacher_id);
          if (error || !data?.user) {
            return res.status(502).json({ error: 'Could not load the assigned teacher’s email. Try again.', code: 'TEACHER_EMAIL_LOOKUP_FAILED' });
          }
          const savedEmail = normalizeCohostEmail(data.user.app_metadata?.webinar_cohost_email);
          const enteredEmail = normalizeCohostEmail(teacher_email);
          teacherCohostEmail = savedEmail || enteredEmail;
          const ownerEmail = normalizeCohostEmail(process.env.WEBINAR_GG_HOST_EMAIL || host_email || caller.email);
          if (!teacherCohostEmail || teacherCohostEmail === ownerEmail || (teacher_email && savedEmail && enteredEmail !== savedEmail)) {
            return res.status(400).json({
              error: savedEmail ? 'Use the teacher’s saved email or leave the email field blank.' : 'Enter the teacher’s own email for the Webinar.gg invite.',
              code: 'TEACHER_EMAIL_REQUIRED',
            });
          }
          if (!savedEmail) {
            const { error: saveError } = await supabase.auth.admin.updateUserById(teacher_id, {
              app_metadata: { webinar_cohost_email: teacherCohostEmail },
            });
            if (saveError) {
              return res.status(502).json({ error: 'Could not save the teacher’s email. Try again.', code: 'TEACHER_EMAIL_SAVE_FAILED' });
            }
          }
        }

        let effectiveHostEmail = host_email ? host_email.trim() : null;
        let createdProviderRoom = false;
        if (class_type === 'prerecorded' && !effectiveWebinarId) {
          effectiveWebinarId = `prerecorded-${Date.now()}`;
        } else if (class_type === 'live' && !effectiveWebinarId) {
          const providerToken = getWebinarGgToken();
          if (!providerToken) {
            return res.status(503).json({ error: 'Automatic room creation is unavailable. Ask your administrator to check the live class setup.', code: 'PROVIDER_UNAVAILABLE' });
          }
          try {
            const localStart = new Date(startsAt.getTime() + 330 * 60_000);
            const hours = localStart.getUTCHours();
            const time = `${String(hours % 12 || 12).padStart(2, '0')}:${String(localStart.getUTCMinutes()).padStart(2, '0')}`;
            const response = await fetchImpl(`${WEBINAR_API_BASE}/webinar/`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${providerToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: title.trim(),
                date: localStart.toISOString().slice(0, 10),
                time,
                meridiem: hours < 12 ? 'AM' : 'PM',
                durationMinutes: duration,
                timezone: 'Asia/Kolkata',
                recordingEnabled: recording_enabled === true,
                requireApproval: true,
                passcode: randomBytes(8).toString('hex'),
              }),
              signal: AbortSignal.timeout(8000),
            });
            const payload = response.ok ? await response.json() : null;
            const roomId = payload?.data?.id || payload?.id;
            if (typeof roomId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(roomId)) {
              throw new Error('No valid Webinar.gg room ID returned.');
            }
            effectiveWebinarId = roomId;
            effectiveHostEmail = process.env.WEBINAR_GG_HOST_EMAIL?.trim() || caller.email;
            createdProviderRoom = true;
          } catch {
            return res.status(502).json({ error: 'Trendz could not confirm the live room. Check the Webinar.gg schedule before trying again.', code: 'PROVIDER_CREATE_FAILED' });
          }
        }
        if (!effectiveWebinarId) {
          return res.status(400).json({ error: 'Choose a valid class type and room.', code: 'INVALID_REQUEST' });
        }

        if (teacherCohostEmail) {
          try {
            const alreadyInvited = await hasWebinarCohost(effectiveWebinarId, teacherCohostEmail, fetchImpl);
            await requestCohostSetup(effectiveWebinarId, 'cohost-policy', fetchImpl, 'PATCH', {
              cohostStartWithoutHost: true,
              cohostPermissions: { startWebinar: true },
            });
            if (!alreadyInvited) {
              await requestCohostSetup(effectiveWebinarId, 'cohosts', fetchImpl, 'POST', {
                kind: 'email', emails: [teacherCohostEmail],
              });
            }
          } catch {
            return res.status(502).json({
              error: 'The room exists, but teacher hosting could not be set up. Retry to use the same room.',
              code: 'TEACHER_COHOST_SETUP_FAILED',
              existingRoomId: effectiveWebinarId,
              existingHostEmail: effectiveHostEmail,
            });
          }
        }

        const databaseFailure = (error) => res.status(500).json(createdProviderRoom
          ? {
              error: 'The room was created, but the class could not be saved. Retry to use the same room.',
              code: 'DATABASE_ERROR',
              existingRoomId: effectiveWebinarId,
              existingHostEmail: effectiveHostEmail,
            }
          : { error: error.message, code: 'DATABASE_ERROR' });

        // Keep invited teachers separate from the primary assigned teacher
        const cleanedInvitedTeacherIds = Array.isArray(invited_teacher_ids) && invited_teacher_ids.length > 0
          ? invited_teacher_ids.filter((id) => id && id !== teacher_id)
          : null;

        const basePayload = {
          title: title.trim(),
          webinar_id: effectiveWebinarId,
          teacher_id,
          host_email: effectiveHostEmail,
          target_level: target_level || null,
          target_student_ids: Array.isArray(target_student_ids) && target_student_ids.length > 0 ? target_student_ids : null,
          invited_teacher_ids: cleanedInvitedTeacherIds && cleanedInvitedTeacherIds.length > 0 ? cleanedInvitedTeacherIds : null,
          scheduled_start_time,
          duration_minutes: duration,
          status: 'scheduled',
          notes: notes ? notes.trim() : null,
          created_by: caller.id,
        };

        const fullPayload = {
          ...basePayload,
          class_type,
          recording_enabled: recording_enabled === true,
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
            return databaseFailure(fallbackError);
          }
          newClass = {
            ...fallbackClass,
            class_type: 'live',
            recording_enabled: recording_enabled === true,
            prerecorded_asset_url: null,
            stream_url: null,
          };
          error = null;
        }

        if (error) {
          return databaseFailure(error);
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

        if (typeof recording.playback_url !== 'string' ||
            !/^(storage|private):\/\//.test(recording.playback_url)) {
          return res.status(409).json({
            error: 'Attach a copy from the private recordings bucket before using Trendz playback.',
            code: 'PRIVATE_COPY_REQUIRED',
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
          const rawPath = playbackUrl.replace(/^(storage|private):\/\//, '');
          const slashIdx = rawPath.indexOf('/');
          if (slashIdx === -1) {
            return res.status(400).json({
              error: 'Invalid storage reference. Format must be storage://<bucket>/<path>.',
              code: 'INVALID_STORAGE_URI',
            });
          }
          const bucket = rawPath.slice(0, slashIdx);
          const objectPath = rawPath.slice(slashIdx + 1);

          // Restrict strictly to the configured private recordings bucket
          if (bucket !== PRIVATE_RECORDINGS_BUCKET) {
            return res.status(403).json({
              error: `Access denied. Private replay is strictly restricted to the configured "${PRIVATE_RECORDINGS_BUCKET}" bucket.`,
              code: 'BUCKET_RESTRICTED',
            });
          }

          if (!supabase.storage) {
            return res.status(500).json({
              error: 'Storage service is unavailable for generating signed playback URLs.',
              code: 'STORAGE_UNAVAILABLE',
            });
          }

          const { data: signedData, error: signErr } = await supabase.storage
            .from(bucket)
            .createSignedUrl(objectPath, 3600);

          if (signErr || !signedData?.signedUrl) {
            return res.status(502).json({
              error: `Failed to generate signed playback URL for private recording: ${signErr?.message || 'Storage signing returned empty URL.'}`,
              code: 'STORAGE_SIGNING_FAILED',
            });
          }

          playbackUrl = signedData.signedUrl;
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
        const isValidUrl = typeof recordingUrl === 'string' && /^(storage|private):\/\//.test(recordingUrl);
        if (!isValidUrl) {
          return res.status(400).json({
            error: 'Attach a private storage reference from the recordings bucket.',
            code: 'PRIVATE_COPY_REQUIRED',
          });
        }

        if (recordingUrl.startsWith('storage://') || recordingUrl.startsWith('private://')) {
          const rawPath = recordingUrl.replace(/^(storage|private):\/\//, '');
          const slashIdx = rawPath.indexOf('/');
          if (slashIdx === -1 || !rawPath.slice(slashIdx + 1).trim()) {
            return res.status(400).json({
              error: 'Invalid storage reference. Format must be storage://<bucket>/<path>.',
              code: 'INVALID_STORAGE_URI',
            });
          }
          const bucket = rawPath.slice(0, slashIdx);
          if (bucket !== PRIVATE_RECORDINGS_BUCKET) {
            return res.status(400).json({
              error: `Invalid storage reference. Private recordings must be located within the configured "${PRIVATE_RECORDINGS_BUCKET}" bucket.`,
              code: 'INVALID_STORAGE_BUCKET',
            });
          }
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
