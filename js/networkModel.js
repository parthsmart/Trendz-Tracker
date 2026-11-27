/**
 * Trendz Tracker — owner and director panel logic (js/networkModel.js)
 *
 * Pure functions used by js/network.js and the tests. The database is the real
 * gate (RLS, set_person_role, the profiles and centres guards); these only
 * decide what the page shows and offers.
 */

import { roleRank, isNetworkRole } from './roles.js';

export const ASSIGNABLE_ROLES = Object.freeze([
  'owner', 'director', 'centre_head', 'vice_centre_head', 'teacher', 'student',
]);
export const STAFF_CREATE_ROLES = Object.freeze(['owner', 'director', 'centre_head', 'vice_centre_head']);
export const CENTRE_ROLES = Object.freeze(['centre_head', 'vice_centre_head', 'teacher', 'student']);

export const ROLE_NAMES = Object.freeze({
  owner: 'Owner',
  admin: 'Owner',
  director: 'Director',
  centre_head: 'Centre head',
  vice_centre_head: 'Vice centre head',
  teacher: 'Teacher',
  student: 'Student',
});

export const ACTIVE_CENTRE_KEY = 'trendz.network.activeCentre';

/** The real role of a profile row (rows from the database carry the real role). */
export function realRole(person) {
  return person?.network_role || person?.role || '';
}

export function roleName(role) {
  return ROLE_NAMES[role] || 'Unknown';
}

/** Roles `actorRole` may give someone: strictly below, owners may also give owner. */
export function assignableRoles(actorRole) {
  const rank = roleRank(actorRole);
  return ASSIGNABLE_ROLES.filter((r) => roleRank(r) < rank || (rank >= roleRank('owner') && r === 'owner'));
}

/** Roles `actorRole` may create accounts for on this panel. */
export function creatableStaffRoles(actorRole) {
  if (roleRank(actorRole) < roleRank('director')) return [];
  return assignableRoles(actorRole).filter((r) => STAFF_CREATE_ROLES.includes(r));
}

/** Whether `actor` may change `person` (role, centre, active). Mirrors set_person_role. */
export function canManagePerson(actor, person) {
  if (!actor || !person || actor.id === person.id) return false;
  const actorRole = realRole(actor);
  if (!isNetworkRole(actorRole)) return false;
  const actorRank = roleRank(actorRole);
  const targetRank = roleRank(realRole(person));
  if (actorRank >= roleRank('owner')) return true;
  return targetRank < actorRank;
}

export function needsCentre(role) {
  return CENTRE_ROLES.includes(role);
}

/**
 * Buttons a centre row offers. The default centre stays active; archiving
 * needs the centre to be empty (the database checks this too).
 */
export function centreActions(centre, stats = {}) {
  if (!centre) return [];
  if (centre.is_default) return ['edit'];
  const actions = ['edit'];
  if (centre.status === 'active') actions.push('suspend');
  if (centre.status === 'suspended') actions.push('activate');
  if (centre.status !== 'archived' && !(stats.people > 0) && !(stats.posts > 0)) actions.push('archive');
  if (centre.status === 'archived') actions.push('restore');
  return actions;
}

/** Validates the new-centre form. Returns an error string or null. */
export function validateCentreInput({ name, code, kind } = {}) {
  const n = String(name || '').trim();
  const c = String(code || '').trim().toUpperCase();
  if (n.length < 2 || n.length > 80) return 'Centre name must be 2–80 characters.';
  if (!/^[A-Z0-9]{2,8}$/.test(c)) return 'Centre code must be 2–8 capital letters or numbers.';
  if (kind && !['centre', 'school'].includes(kind)) return 'Choose centre or school.';
  return null;
}

/**
 * Per-centre counts for the dashboard.
 * @param {Array} centres
 * @param {Array} people  profiles (real roles)
 * @param {Array} posts   open centre_staff rows
 */
export function centreStats(centres = [], people = [], posts = []) {
  const byId = new Map();
  for (const c of centres) {
    byId.set(c.id, { centre: c, students: 0, activeStudents: 0, teachers: 0, people: 0, posts: 0, head: null, vices: [] });
  }
  const peopleById = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    if (p.deleted_at) continue;
    const s = byId.get(p.centre_id);
    if (!s) continue;
    s.people += 1;
    const role = realRole(p);
    if (role === 'student') {
      s.students += 1;
      if (p.active !== false) s.activeStudents += 1;
    } else if (role === 'teacher') {
      s.teachers += 1;
    }
  }
  for (const post of posts) {
    if (post.ended_at) continue;
    const s = byId.get(post.centre_id);
    if (!s) continue;
    s.posts += 1;
    const who = peopleById.get(post.profile_id) || { id: post.profile_id, full_name: 'Unknown' };
    if (post.role === 'centre_head') s.head = who;
    else s.vices.push(who);
  }
  return [...byId.values()];
}

/** Network totals across every centre. */
export function networkTotals(people = []) {
  const live = people.filter((p) => !p.deleted_at);
  const count = (role) => live.filter((p) => realRole(p) === role).length;
  return {
    students: count('student'),
    activeStudents: live.filter((p) => realRole(p) === 'student' && p.active !== false).length,
    teachers: count('teacher'),
    heads: count('centre_head') + count('vice_centre_head'),
    network: live.filter((p) => isNetworkRole(realRole(p))).length,
  };
}

/** People list filter for the all-people table. */
export function filterPeople(people = [], { centreId = '', role = '', query = '', showInactive = true } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return people
    .filter((p) => !p.deleted_at)
    .filter((p) => !centreId || (centreId === 'network' ? !p.centre_id : p.centre_id === centreId))
    .filter((p) => !role || realRole(p) === role || (role === 'staff' && realRole(p) !== 'student'))
    .filter((p) => showInactive || p.active !== false)
    .filter((p) => !q
      || String(p.full_name || '').toLowerCase().includes(q)
      || String(p.student_code || '').toLowerCase().includes(q))
    .sort((a, b) => roleRank(realRole(b)) - roleRank(realRole(a))
      || String(a.full_name || '').localeCompare(String(b.full_name || '')));
}

const AUDIT_VERBS = Object.freeze({
  create: 'was added',
  role_change: 'changed role',
  transfer: 'moved centre',
  activate: 'was activated',
  deactivate: 'was deactivated',
  delete: 'was deleted',
  restore: 'was restored',
});

/** One readable line for a role_audit row. */
export function describeAudit(row, nameById = new Map(), centreById = new Map()) {
  if (!row) return '';
  const actor = nameById.get(row.actor_id) || (row.actor_id ? 'Someone' : 'System');
  const target = nameById.get(row.target_id) || row.after?.full_name || row.before?.full_name || 'someone';
  const centreName = (cid) => (cid ? centreById.get(cid)?.name || 'another centre' : 'the network');
  const before = row.before || {};
  const after = row.after || {};
  switch (row.action) {
    case 'role_change':
      return `${actor} changed ${target} from ${roleName(before.role)} to ${roleName(after.role)}`;
    case 'transfer':
      return `${actor} moved ${target} from ${centreName(before.centre_id)} to ${centreName(after.centre_id)}`;
    case 'centres_insert':
      return `${actor} added centre ${after.name || ''}`.trim();
    case 'centres_update':
      if (before.status !== after.status) return `${actor} set centre ${after.name || ''} to ${after.status}`;
      return `${actor} edited centre ${after.name || before.name || ''}`.trim();
    case 'centre_staff_insert':
      return `${actor} made ${nameById.get(after.profile_id) || 'someone'} ${roleName(after.role)} of ${centreName(after.centre_id)}`;
    case 'centre_staff_update':
      return `${nameById.get(after.profile_id || before.profile_id) || 'Someone'}'s ${roleName(after.role || before.role)} post at ${centreName(after.centre_id || before.centre_id)} ended`;
    case 'centre_visibility_insert':
      return `${actor} opened ${centreName(after.source_centre_id)} students for duels`;
    case 'centre_visibility_delete':
      return `${actor} closed a duel opening for ${centreName(before.source_centre_id)}`;
    case 'centre_backup':
      return `${actor} downloaded the backup of ${centreName(row.centre_id)}`;
    default: {
      const verb = AUDIT_VERBS[row.action];
      if (verb) return `${target} ${verb}${row.actor_id ? ` by ${actor}` : ''}`;
      return `${actor}: ${String(row.action || 'change').replace(/_/g, ' ')}`;
    }
  }
}

/** Human summary of a centre_visibility grant. */
export function describeGrant(grant, centreById = new Map()) {
  const source = centreById.get(grant.source_centre_id)?.name || 'A centre';
  const viewer = grant.viewer_centre_id ? centreById.get(grant.viewer_centre_id)?.name || 'one centre' : 'every centre';
  let who = 'all students';
  if (grant.mode === 'top_n') who = `top ${grant.top_n} students`;
  if (grant.mode === 'students') who = `${(grant.student_ids || []).length} chosen students`;
  return `${source}: ${who}, open to ${viewer} for duels`;
}

/** Validates a visibility grant before saving. Returns an error string or null. */
export function validateGrant({ source_centre_id, viewer_centre_id, mode, top_n, student_ids } = {}) {
  if (!source_centre_id) return 'Choose the centre whose students can be challenged.';
  if (viewer_centre_id && viewer_centre_id === source_centre_id) return 'Choose a different centre to open it to.';
  if (!['all', 'students', 'top_n'].includes(mode)) return 'Choose who can be challenged.';
  if (mode === 'top_n') {
    const n = Number(top_n);
    if (!Number.isInteger(n) || n < 1 || n > 500) return 'Top N must be a whole number from 1 to 500.';
  }
  if (mode === 'students' && !(Array.isArray(student_ids) && student_ids.length)) return 'Pick at least one student.';
  return null;
}

/** Row to insert for a grant (the columns the database check expects). */
export function grantRow(input) {
  return {
    source_centre_id: input.source_centre_id,
    viewer_centre_id: input.viewer_centre_id || null,
    mode: input.mode,
    top_n: input.mode === 'top_n' ? Number(input.top_n) : null,
    student_ids: input.mode === 'students' ? input.student_ids : null,
    purpose: 'duels',
  };
}

/** Reads the centre switcher choice; '' means all centres. */
export function readActiveCentre(storage, centres = []) {
  try {
    const v = storage?.getItem(ACTIVE_CENTRE_KEY) || '';
    if (v === 'network') return v;
    return centres.some((c) => c.id === v) ? v : '';
  } catch {
    return '';
  }
}

export function writeActiveCentre(storage, value) {
  try {
    if (value) storage?.setItem(ACTIVE_CENTRE_KEY, value);
    else storage?.removeItem(ACTIVE_CENTRE_KEY);
  } catch {
    /* storage unavailable */
  }
}
