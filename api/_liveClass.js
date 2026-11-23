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
 * Reads provider webinar status
 */
async function fetchProviderWebinarStatus(webinarId, fetchImpl = fetch) {
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
    return json?.data?.status || null;
  } catch (_) {
    return null;
  }
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

        const { data: liveClass, error } = await supabase
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

        if (error || !liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        // Live provider status check: sync provider status if scheduled or live
        let currentStatus = liveClass.status;
        let providerStatus = liveClass.provider_status;
        if (liveClass.webinar_id && currentStatus !== 'ended' && currentStatus !== 'cancelled') {
          const liveProviderStatus = await fetchProviderWebinarStatus(liveClass.webinar_id, fetchImpl);
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

        const { data: liveClass, error } = await supabase
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

        if (error || !liveClass) {
          return res.status(404).json({ error: 'Live class not found.', code: 'CLASS_NOT_FOUND' });
        }

        if (liveClass.status === 'cancelled') {
          return res.status(400).json({ error: 'This live class has been cancelled.', code: 'CLASS_CANCELLED' });
        }

        if (liveClass.status === 'ended') {
          return res.status(400).json({ error: 'This live class has already ended.', code: 'CLASS_ENDED' });
        }

        // Provider status check before minting join token
        const providerStatus = await fetchProviderWebinarStatus(liveClass.webinar_id, fetchImpl);
        if (providerStatus === 'completed' || providerStatus === 'ended') {
          await supabase
            .from('live_classes')
            .update({
              provider_status: providerStatus,
              status: 'ended',
              updated_at: new Date().toISOString(),
            })
            .eq('id', classId);
          return res.status(400).json({ error: 'This live class has already ended.', code: 'CLASS_ENDED' });
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
          webinar_id,
          teacher_id,
          target_level,
          target_student_ids,
          invited_teacher_ids,
          scheduled_start_time,
          duration_minutes = 60,
          host_email = null,
          notes,
        } = body;

        if (!title || !webinar_id || !teacher_id || !scheduled_start_time) {
          return res.status(400).json({
            error: 'Missing required fields: title, webinar_id, teacher_id, scheduled_start_time.',
            code: 'INVALID_REQUEST',
          });
        }

        const { data: newClass, error } = await supabase
          .from('live_classes')
          .insert({
            title: title.trim(),
            webinar_id: webinar_id.trim(),
            teacher_id,
            host_email: host_email ? host_email.trim() : null,
            target_level: target_level || null,
            target_student_ids: Array.isArray(target_student_ids) && target_student_ids.length > 0 ? target_student_ids : null,
            invited_teacher_ids: Array.isArray(invited_teacher_ids) && invited_teacher_ids.length > 0 ? invited_teacher_ids : null,
            scheduled_start_time,
            duration_minutes: Number(duration_minutes) || 60,
            status: 'scheduled',
            notes: notes ? notes.trim() : null,
            created_by: caller.id,
          })
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
