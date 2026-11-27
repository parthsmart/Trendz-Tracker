/**
 * Trendz Tracker — creating staff accounts for the network (api/_networkStaff.js)
 * Internal server-only module (prefixed with _ so Vercel does not count it as a function).
 *
 * action 'create_staff' on /api/manage-teacher:
 *   - the caller must be an active owner or director (verifyAdminCaller already
 *     checked they are an effective admin; this checks the real role);
 *   - the new role must rank below the caller's, except that owners may create owners;
 *   - the Auth user is created with the service client, then the role is given
 *     with set_person_role() through the CALLER's own session, so the database
 *     enforces the same rank and centre rules a direct call would;
 *   - if giving the role fails, the new Auth user is deleted again.
 *
 * The password is typed by the person creating the account; it is never logged
 * or returned.
 */

import { getAdminClient, getCallerClient } from './_supabaseAdmin.js';
import { roleRank } from '../js/roles.js';

export const STAFF_ROLES = Object.freeze(['owner', 'director', 'centre_head', 'vice_centre_head']);
const CENTRE_ROLES = Object.freeze(['centre_head', 'vice_centre_head']);
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a caller with real role `callerRole` may create an account with `newRole`.
 * Mirrors set_person_role(): strictly below your own rank, owners may create owners.
 */
export function canCreateStaffRole(callerRole, newRole) {
  if (!STAFF_ROLES.includes(newRole)) return false;
  const callerRank = roleRank(callerRole);
  if (callerRank < roleRank('director')) return false;
  if (callerRank >= roleRank('owner') && newRole === 'owner') return true;
  return roleRank(newRole) < callerRank;
}

/** Validates the request body. Returns { error } or the cleaned values. */
export function validateStaffInput(body = {}) {
  const code = String(body.staff_code || '').trim().toUpperCase();
  const name = String(body.full_name || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '').trim();
  const centreId = body.centre_id ? String(body.centre_id).trim() : null;

  if (!CODE_PATTERN.test(code)) {
    return { error: 'Login code must be 2–20 letters or numbers (dashes and underscores allowed).' };
  }
  if (name.length < 2 || name.length > 80) {
    return { error: 'Enter a full name (2–80 characters).' };
  }
  if (password.trim().length < 8) {
    return { error: 'Password must be at least 8 characters long.' };
  }
  if (!STAFF_ROLES.includes(role)) {
    return { error: 'Choose a role: owner, director, centre head or vice centre head.' };
  }
  if (CENTRE_ROLES.includes(role)) {
    if (!centreId || !UUID_PATTERN.test(centreId)) return { error: 'Choose a centre for this person.' };
  } else if (centreId) {
    return { error: 'Owners and directors belong to every centre; leave the centre empty.' };
  }
  return { code, name, password: password.trim(), role, centreId: CENTRE_ROLES.includes(role) ? centreId : null };
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} caller normalized profile from verifyAdminCaller (has network_role, accessToken)
 * @param {object} [deps] injectable clients for tests
 */
export async function createStaff(req, res, caller, deps = {}) {
  const callerRole = caller?.network_role || caller?.role;
  if (!caller?.active || roleRank(callerRole) < roleRank('director')) {
    return res.status(403).json({ error: 'Only owners and directors can create staff accounts.' });
  }

  const input = validateStaffInput(req.body || {});
  if (input.error) return res.status(400).json({ error: input.error });

  if (!canCreateStaffRole(callerRole, input.role)) {
    return res.status(403).json({ error: 'You can only create roles below your own level.' });
  }

  const admin = deps.adminClient || getAdminClient();
  const callerClient = deps.callerClient || getCallerClient(caller.accessToken);

  if (input.centreId) {
    const { data: centre, error: centreError } = await admin
      .from('centres').select('id, status').eq('id', input.centreId).maybeSingle();
    if (centreError || !centre) return res.status(400).json({ error: 'That centre does not exist.' });
    if (centre.status !== 'active') return res.status(400).json({ error: 'That centre is not active.' });
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: `${input.code.toLowerCase()}@trendz.local`,
    password: input.password,
    email_confirm: true,
    user_metadata: { student_code: input.code, full_name: input.name },
  });
  if (createError || !created?.user?.id) {
    const msg = createError?.message || 'Could not create the account.';
    const taken = /already|exists|registered/i.test(msg);
    return res.status(400).json({ error: taken ? 'That login code is already in use.' : msg });
  }
  const userId = created.user.id;

  const cleanup = async (message) => {
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    if (delError) console.error('[create_staff] cleanup failed:', delError.message);
    return res.status(400).json({ error: message });
  };

  // The auth trigger made a student profile; make sure it exists before promoting.
  const { data: profile } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (!profile) return cleanup('The account was created but its profile was not. Nothing was saved.');

  const { error: roleError } = await callerClient.rpc('set_person_role', {
    p_target: userId,
    p_role: input.role,
    p_centre: input.centreId,
  });
  if (roleError) return cleanup(roleError.message || 'Could not give that role.');

  const { data: finalProfile } = await admin
    .from('profiles')
    .select('id, student_code, full_name, role, centre_id, active')
    .eq('id', userId)
    .single();

  return res.status(200).json({ success: true, staff: finalProfile });
}
