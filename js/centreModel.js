/**
 * Trendz Tracker — centre head panel logic (js/centreModel.js)
 *
 * Pure functions used by js/centre.js and the tests. No DOM, no network.
 * They only decide what the page shows: the database functions from
 * migration 36 make the real decisions.
 */

import { isNetworkRole } from './roles.js';
import { isStudentLevel as isStandardStudentLevel, STUDENT_LEVELS as STANDARD_STUDENT_LEVELS } from '../shared/levels.js';

export const CENTRE_PANEL_ROLES = Object.freeze(['centre_head', 'vice_centre_head']);

export const PERMISSION_FIELDS = Object.freeze([
  ['can_view_students', 'See student details'],
  ['can_mark_attendance', 'Mark attendance'],
  ['can_correct_attendance', 'Correct attendance'],
  ['can_generate_reports', 'Make reports'],
  ['can_manage_tasks', 'Set tasks'],
  ['can_manage_tests', 'Set weekly tests'],
  ['can_publish_announcements', 'Post announcements'],
  ['can_manage_resources', 'Share resources'],
  ['can_review_scores', 'Review scores'],
  ['can_request_corrections', 'Ask for score corrections'],
  ['can_schedule_live_classes', 'Schedule live classes'],
]);

export const SETTINGS_FIELDS = Object.freeze([
  ['address', 'Address', 200],
  ['phone', 'Phone', 30],
  ['email', 'Email', 120],
  ['notes', 'Notes', 500],
]);

/** Who may open the centre panel (heads, vice heads, owners and directors). */
export function canOpenCentrePanel(profile) {
  const role = profile?.network_role || profile?.role;
  return CENTRE_PANEL_ROLES.includes(role) || isNetworkRole(role);
}

/**
 * What the signed-in person may do on the panel, from the database's answer
 * (my_role, can_head). Mirrors the §4 head / vice head split.
 */
export function panelCapabilities(myRole, canHead) {
  const network = isNetworkRole(myRole);
  const head = Boolean(canHead) || network;
  const staff = head || myRole === 'vice_centre_head';
  return Object.freeze({
    view: staff,
    editPeople: staff,
    createPeople: staff,
    setActive: staff,
    resetPasswords: staff,
    teachers: staff,
    deleteRestore: head,
    viceHeads: head,
    settings: head,
    backup: head,
    audit: head,
  });
}

/** Splits panel people into the lists the page shows. */
export function splitPeople(people = []) {
  const list = Array.isArray(people) ? people : [];
  const live = list.filter((p) => !p.deleted_at);
  return {
    head: live.find((p) => p.role === 'centre_head') || null,
    vices: live.filter((p) => p.role === 'vice_centre_head'),
    teachers: live.filter((p) => p.role === 'teacher'),
    students: live.filter((p) => p.role === 'student'),
    deleted: list.filter((p) => p.deleted_at && (p.role === 'student' || p.role === 'teacher')),
  };
}

/** Student list filter: status 'all' | 'active' | 'inactive', and name / code search. */
export function filterStudents(students = [], { query = '', status = 'all' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return students.filter((s) => {
    if (status === 'active' && !s.active) return false;
    if (status === 'inactive' && s.active) return false;
    if (!q) return true;
    return String(s.full_name || '').toLowerCase().includes(q)
      || String(s.student_code || '').toLowerCase().includes(q);
  });
}

export function centreCounts(people = []) {
  const { students, teachers, vices, head } = splitPeople(people);
  return {
    students: students.length,
    activeStudents: students.filter((s) => s.active).length,
    teachers: teachers.length,
    vices: vices.length,
    hasHead: Boolean(head),
  };
}

/** Validates the add-person form. Returns { value } or { error }. */
export function validateNewPerson({ code, name, password, level, role = 'student' } = {}) {
  const c = String(code || '').trim().toUpperCase();
  const n = String(name || '').trim();
  const p = String(password || '');
  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(c)) {
    return { error: 'Login code: 2–20 letters, numbers, - or _.' };
  }
  if (n.length < 2 || n.length > 80) return { error: 'Enter a name of 2 to 80 characters.' };
  if (p.trim().length < 6) return { error: 'The password needs at least 6 characters.' };
  if (role === 'student') {
    const l = String(level || '').trim();
    if (l && !isStandardStudentLevel(l)) return { error: 'Choose a valid level.' };
    return { value: { code: c, name: n, password: p.trim(), level: l || null } };
  }
  return { value: { code: c, name: n, password: p.trim() } };
}

/** Validates the edit form for a student or teacher. */
export function validatePersonEdit({ name, level, role } = {}) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 80) return { error: 'Enter a name of 2 to 80 characters.' };
  if (role === 'student') {
    const l = String(level || '').trim();
    if (l && !isStandardStudentLevel(l)) return { error: 'Choose a valid level.' };
    return { value: { name: n, level: l || null } };
  }
  return { value: { name: n, level: null } };
}

export function validatePassword(value) {
  const p = String(value || '').trim();
  if (p.length < 6) return { error: 'The password needs at least 6 characters.' };
  return { value: p };
}

/** Validates the centre settings form. */
export function validateSettings({ name, city, settings = {} } = {}) {
  const n = String(name || '').trim();
  const c = String(city || '').trim();
  if (n.length < 2 || n.length > 80) return { error: 'Enter a centre name of 2 to 80 characters.' };
  if (c.length > 80) return { error: 'The city can be at most 80 characters.' };
  const clean = {};
  for (const [key, label, max] of SETTINGS_FIELDS) {
    const v = String(settings?.[key] ?? '').trim();
    if (v.length > max) return { error: `${label} can be at most ${max} characters.` };
    clean[key] = v;
  }
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    return { error: 'Enter a valid email, or leave it empty.' };
  }
  return { value: { name: n, city: c, settings: clean } };
}

/** Teacher id → Set of assigned student ids. */
export function assignmentMap(assignments = []) {
  const map = new Map();
  for (const a of assignments || []) {
    if (!a?.teacher_id) continue;
    if (!map.has(a.teacher_id)) map.set(a.teacher_id, new Set());
    map.get(a.teacher_id).add(a.student_id);
  }
  return map;
}

/** The permission switches for one teacher (defaults match the database). */
export function teacherPermissions(permissions = [], teacherId) {
  const row = (permissions || []).find((p) => p.teacher_id === teacherId) || {};
  const out = {};
  for (const [key] of PERMISSION_FIELDS) {
    out[key] = typeof row[key] === 'boolean' ? row[key] : key !== 'can_schedule_live_classes';
  }
  return out;
}

/** Teachers the head can make vice head. */
export function viceCandidates(people = []) {
  return splitPeople(people).teachers.filter((t) => t.active);
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * Turns the centre_backup() answer into xlsx sheets: one summary sheet and one
 * sheet per table, with the union of columns as the header.
 */
export function backupSheets(backup) {
  const tables = backup?.tables || {};
  const summary = {
    name: 'Summary',
    header: ['Item', 'Value'],
    rows: [
      ['Centre', `${backup?.centre?.name || ''} (${backup?.centre?.code || ''})`],
      ['Made at', String(backup?.generated_at || '')],
      ['Row limit per table', String(backup?.row_limit ?? '')],
      ...Object.keys(tables).map((t) => [t, String((tables[t] || []).length)]),
    ],
  };
  const sheets = [summary];
  for (const [table, rowsIn] of Object.entries(tables)) {
    const rows = Array.isArray(rowsIn) ? rowsIn : [];
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r || {})) if (!cols.includes(k)) cols.push(k);
    sheets.push({
      name: table.slice(0, 31),
      header: cols.length ? cols : ['(no rows)'],
      rows: rows.map((r) => cols.map((k) => cell(r?.[k]))),
    });
  }
  return sheets;
}

export function backupFileName(centre, now = new Date()) {
  const code = String(centre?.code || 'centre').replace(/[^A-Za-z0-9_-]/g, '');
  const d = now.toISOString().slice(0, 10);
  return `trendz-centre-${code}-${d}.xlsx`;
}

export const STUDENT_LEVELS = STANDARD_STUDENT_LEVELS;
