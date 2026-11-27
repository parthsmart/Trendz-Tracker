/**
 * Trendz Tracker — centre scope checks for service-role API routes (api/_centreScope.js)
 * Internal server-only module (prefixed with _ so Vercel does not count it as a function).
 *
 * The service-role client skips row level security, so every route that uses it
 * re-checks here who the caller may act on:
 *   - owners, directors and the legacy admin: any centre;
 *   - centre heads and vice heads: only students and teachers of their own,
 *     active centre. A centre_id sent by them is never trusted.
 * The rules match the database (can_manage_profile, centre_panel_person).
 */

import { isNetworkRole, roleRank } from '../js/roles.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles a centre head or vice head may create, edit or reset. */
export const CENTRE_MANAGED_ROLES = Object.freeze(['student', 'teacher']);

export function scopeError(message, statusCode = 403) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** The caller's real role (verifyStaffCaller / verifyAdminCaller output). */
export function callerRole(caller) {
  return caller?.network_role || caller?.role || null;
}

export function isNetworkCaller(caller) {
  return isNetworkRole(callerRole(caller));
}

/**
 * Decides which centre a new student or teacher goes into.
 * Returns the centre id, or null for "the default centre" (network callers
 * who did not choose one). Throws an error with statusCode on refusal.
 *
 * @param {object} caller verified caller
 * @param {string|null|undefined} requested centre_id from the request body
 * @param {object} admin service-role Supabase client
 */
export async function resolveCreateCentre(caller, requested, admin) {
  const wanted = requested === undefined || requested === null || requested === '' ? null : String(requested);
  if (wanted !== null && !UUID_RE.test(wanted)) {
    throw scopeError('Choose a valid centre.', 400);
  }

  let centreId;
  if (isNetworkCaller(caller)) {
    if (wanted === null) return null;
    centreId = wanted;
  } else {
    if (!caller?.centre_id) throw scopeError('Forbidden: You are not linked to a centre.');
    if (wanted !== null && wanted !== caller.centre_id) {
      throw scopeError('Forbidden: You can only add people to your own centre.');
    }
    centreId = caller.centre_id;
  }

  const { data: centre, error } = await admin
    .from('centres')
    .select('id, status')
    .eq('id', centreId)
    .maybeSingle();
  if (error) throw scopeError('Could not check the centre. Try again.', 500);
  if (!centre || centre.status !== 'active') {
    throw scopeError(isNetworkCaller(caller) ? 'That centre is not active.' : 'Forbidden: Your centre is not active.',
      isNetworkCaller(caller) ? 400 : 403);
  }
  return centre.id;
}

/**
 * Can this caller manage (edit, reset the password of) this person?
 * Mirrors public.can_manage_profile() plus the centre panel's role limit.
 *
 * @param {object} caller verified caller with network_role / centre_id
 * @param {{ id: string, role: string, centre_id?: string|null }} target
 */
export function canManageTarget(caller, target) {
  if (!caller || !target || !target.role) return false;
  if (caller.id && caller.id === target.id) return false;
  const role = callerRole(caller);
  const isOwner = role === 'owner' || role === 'admin';
  const outranks = roleRank(target.role) < roleRank(role) || (isOwner && (target.role === 'owner' || target.role === 'admin'));
  if (!outranks) return false;
  if (isNetworkCaller(caller)) return true;
  return CENTRE_MANAGED_ROLES.includes(target.role)
    && Boolean(caller.centre_id)
    && target.centre_id === caller.centre_id;
}

/**
 * Checks that every student id belongs to an active, not deleted student of
 * the given centre. Returns the de-duplicated ids.
 */
export async function assertStudentsInCentre(admin, studentIds, centreId) {
  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : [])
    .filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
  if (!ids.length) return ids;
  const { data, error } = await admin
    .from('profiles')
    .select('id, role, centre_id, active, deleted_at')
    .in('id', ids);
  if (error) throw scopeError('Could not check the students. Try again.', 500);
  const ok = new Set((data || [])
    .filter((p) => p.role === 'student' && p.active && !p.deleted_at && p.centre_id === centreId)
    .map((p) => p.id));
  if (ids.some((v) => !ok.has(v))) {
    throw scopeError('Only active students of this centre can be assigned.', 400);
  }
  return ids;
}
