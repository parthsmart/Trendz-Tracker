/**
 * Role hierarchy shared by the site and the API.
 *
 * owner > director > centre_head > vice_centre_head > teacher > student.
 *
 * Until the owner and director panels exist, owners and directors use the
 * admin pages: their *effective* role is 'admin', so every existing
 * `role === 'admin'` check keeps working. The real role stays available as
 * `network_role`. The database is the real gate (RLS and set_person_role);
 * this only decides which pages and buttons are shown.
 */

export const ROLE_RANK = Object.freeze({
  owner: 100,
  admin: 100, // legacy name for owner
  director: 80,
  centre_head: 60,
  vice_centre_head: 50,
  teacher: 30,
  student: 10,
});

/** Roles that see every centre. */
export const NETWORK_ROLES = Object.freeze(['owner', 'director', 'admin']);

export function roleRank(role) {
  return ROLE_RANK[role] || 0;
}

export function isNetworkRole(role) {
  return NETWORK_ROLES.includes(role);
}

/** The role the existing pages understand: owners and directors act as admin. */
export function effectiveRole(role) {
  return isNetworkRole(role) ? 'admin' : role;
}

/**
 * Returns a copy of the profile with `role` set to the effective role and the
 * real role in `network_role`. Safe to call more than once.
 */
export function normalizeProfileRole(profile) {
  if (!profile || typeof profile !== 'object' || !profile.role) return profile;
  // network_role only refines an effective 'admin'; it never widens a role.
  const real = profile.role === 'admin' && isNetworkRole(profile.network_role)
    ? profile.network_role
    : profile.role;
  return { ...profile, network_role: real, role: effectiveRole(real) };
}

const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  admin: 'Owner',
  director: 'Director',
  centre_head: 'Centre head',
  vice_centre_head: 'Vice centre head',
  teacher: 'Teacher',
  student: 'Student',
});

/** Human label for a profile's real role. */
export function roleLabel(profile) {
  const role = profile?.network_role || profile?.role;
  return ROLE_LABELS[role] || 'Staff';
}
