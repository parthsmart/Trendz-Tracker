/**
 * Centre column for owners and directors (multi-centre step 5d).
 *
 * Owners and directors see students of every centre, so the overview and the
 * student roster show which centre each student belongs to. Everyone else sees
 * only their own centre and gets no column.
 */

import { isNetworkRole } from './roles.js';

/** True when this viewer sees every centre and so needs the Centre column. */
export function showsCentreColumn(profile) {
  return isNetworkRole(profile?.network_role || profile?.role);
}

/** Map centre id -> short label ("BRN"); empty when centres cannot be read. */
export async function loadCentreLabels(supabase) {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from('centres').select('id, name, code');
  if (error || !Array.isArray(data)) return new Map();
  return new Map(data.map((c) => [c.id, { code: c.code || c.name || '', name: c.name || c.code || '' }]));
}

/** Map student id -> centre id, for lists (like the overview RPC) that do not carry it. */
export async function loadStudentCentres(supabase) {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from('profiles').select('id, centre_id').eq('role', 'student');
  if (error || !Array.isArray(data)) return new Map();
  return new Map(data.map((p) => [p.id, p.centre_id || null]));
}

/** Plain text for a student's centre: the code, or a dash when unknown. */
export function centreText(labels, centreId) {
  const c = centreId ? labels?.get(centreId) : null;
  return c?.code || '—';
}

/** Table cell HTML for a student's centre (the label is escaped). */
export function centreCellHtml(labels, centreId, escape) {
  const c = centreId ? labels?.get(centreId) : null;
  if (!c) return '<td style="color: var(--text-dim);">—</td>';
  return `<td title="${escape(c.name)}"><span class="badge" style="font-size: 11px;">${escape(c.code)}</span></td>`;
}
