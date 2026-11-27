/**
 * Trendz Tracker — centre head panel (js/centre.js, pages/centre.html)
 *
 * For centre heads and vice heads (and owners / directors looking at one
 * centre). Everything is read and changed through the centre_* database
 * functions from migration 35, which check the caller's centre and rank.
 * Accounts are created and passwords reset through the API routes, which
 * re-check the centre (api/_centreScope.js). Vice heads are appointed with
 * set_person_role().
 */

import { requireAuth } from './guard.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { openModal, closeModal, setupModalListeners } from './modal.js';
import { showToast } from './toast.js';
import { createStudent, createTeacher, resetStudentPassword } from './api.js';
import { isNetworkRole } from './roles.js';
import { buildXlsx } from './xlsx.js';
import { describeAudit, readActiveCentre, roleName } from './networkModel.js';
import {
  PERMISSION_FIELDS,
  SETTINGS_FIELDS,
  STUDENT_LEVELS,
  assignmentMap,
  backupFileName,
  backupSheets,
  canOpenCentrePanel,
  centreCounts,
  filterStudents,
  panelCapabilities,
  splitPeople,
  teacherPermissions,
  validateNewPerson,
  validatePassword,
  validatePersonEdit,
  validateSettings,
  viceCandidates,
} from './centreModel.js';

const state = {
  actor: null,
  demo: false,
  network: false,
  centreId: null,
  centre: null,
  myRole: null,
  caps: panelCapabilities(null, false),
  people: [],
  permissions: [],
  assignments: [],
  audit: [],
  tab: 'students',
  query: '',
  status: 'all',
};

const $ = (id) => document.getElementById(id);

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

function personById(id) {
  return state.people.find((p) => p.id === id) || null;
}

async function rpc(fn, args) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message || 'That did not work. Try again.');
  return data;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function demoPanel() {
  const me = state.actor;
  const centre = {
    id: 'demo-centre-brn', name: 'Baran Centre', code: 'BRN', kind: 'centre', status: 'active',
    is_default: true, city: 'Baran', settings: { phone: '', address: '', email: '', notes: '' },
  };
  const students = (DemoDB.getStudents?.() || [])
    .filter((s) => s.role === 'student')
    .map((s) => ({
      id: s.id, student_code: s.student_code, full_name: s.full_name, role: 'student',
      level: s.level || null, active: s.active !== false, deleted_at: s.deleted_at || null,
    }));
  const myRole = me.network_role || me.role;
  const people = [
    ...(myRole === 'centre_head' ? [] : [{ id: 'demo-head-brn', student_code: 'BRNHEAD', full_name: 'Meena Joshi', role: 'centre_head', active: true }]),
    ...(['centre_head', 'vice_centre_head'].includes(myRole)
      ? [{ id: me.id, student_code: me.student_code || 'ME', full_name: me.full_name || 'Me', role: myRole, active: true }]
      : []),
    { id: 'demo-teacher-1', student_code: 'TCH01', full_name: 'Anita Sharma', role: 'teacher', level: 'Teacher', active: true },
    { id: 'demo-teacher-2', student_code: 'TCH02', full_name: 'Vikas Rao', role: 'teacher', level: 'Teacher', active: true },
    ...students,
  ];
  const firstStudents = students.slice(0, 3).map((s) => ({ teacher_id: 'demo-teacher-1', student_id: s.id }));
  return {
    centre,
    my_role: myRole,
    can_head: myRole !== 'vice_centre_head',
    people,
    permissions: [],
    assignments: firstStudents,
  };
}

async function resolveCentreId() {
  const param = new URLSearchParams(window.location.search).get('centre');
  if (!state.network) return null; // heads always use their own centre
  if (param) return param;
  if (state.demo) return 'demo-centre-brn';
  const supabase = await getSupabase();
  const { data: centres } = await supabase.from('centres').select('id, is_default, status').order('name');
  const saved = readActiveCentre(window.localStorage, centres || []);
  if (saved && saved !== 'network') return saved;
  return (centres || []).find((c) => c.is_default)?.id || null;
}

async function loadData() {
  if (state.demo) {
    if (!state.centre) {
      const d = demoPanel();
      applyPanel(d);
    }
    return;
  }
  const data = await rpc('centre_panel', { p_centre: state.centreId });
  applyPanel(data || {});
  state.audit = [];
  if (state.caps.audit && state.centre?.id) {
    const supabase = await getSupabase();
    const { data: audit } = await supabase
      .from('role_audit')
      .select('id, at, actor_id, actor_role, target_id, centre_id, action, before, after')
      .eq('centre_id', state.centre.id)
      .order('at', { ascending: false })
      .limit(50);
    state.audit = audit || [];
  }
}

function applyPanel(d) {
  state.centre = d.centre || null;
  state.centreId = state.centre?.id || state.centreId;
  state.myRole = d.my_role || state.actor?.network_role || state.actor?.role;
  state.caps = panelCapabilities(state.myRole, d.can_head);
  state.people = d.people || [];
  state.permissions = d.permissions || [];
  state.assignments = d.assignments || [];
}

async function reload() {
  showError('centre-error', '');
  try {
    await loadData();
  } catch (err) {
    showError('centre-error', err.message || 'Could not load the centre.');
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusBadge(p) {
  if (p.deleted_at) return '<span class="badge badge-neutral">Deleted</span>';
  return p.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-warning">Inactive</span>';
}

function renderHeader() {
  const c = state.centre;
  $('centre-title').textContent = c ? `${c.name}` : 'Centre';
  $('centre-actor-role').textContent = roleName(state.myRole) || 'Staff';
  $('centre-subtitle').textContent = c ? `Code ${c.code}${c.city ? ` · ${c.city}` : ''}` : '';
  const banner = $('centre-viewing-banner');
  if (state.network && c) {
    banner.textContent = `Viewing ${c.name} as ${roleName(state.myRole)}. Changes are recorded under your name.`;
    banner.style.display = 'block';
    $('centre-back-network').style.display = '';
  } else {
    banner.style.display = 'none';
  }
  if (c && c.status !== 'active') {
    showError('centre-error', `This centre is ${c.status}. Ask the owner or a director to reactivate it.`);
  }
}

function renderStats() {
  const n = centreCounts(state.people);
  const head = splitPeople(state.people).head;
  const card = (label, value) => `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value num">${esc(value)}</div></div>`;
  $('centre-stats').innerHTML = [
    card('Students', n.students),
    card('Active students', n.activeStudents),
    card('Teachers', n.teachers),
    card('Head', head ? head.full_name : 'None'),
  ].join('');
}

function renderTabs() {
  document.querySelectorAll('[data-head-only]').forEach((el) => {
    el.hidden = !state.caps.deleteRestore;
  });
  if (!state.caps.settings && (state.tab === 'settings' || state.tab === 'backup')) state.tab = 'students';
  document.querySelectorAll('#centre-tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-ghost', !on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-panel]').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab;
  });
}

function personActions(p) {
  const caps = state.caps;
  const b = (action, label, cls = 'btn-ghost') =>
    `<button type="button" class="btn ${cls} btn-sm" data-action="${action}" data-id="${esc(p.id)}">${label}</button>`;
  if (p.deleted_at) return caps.deleteRestore ? b('restore', 'Restore', 'btn-outline') : '';
  const out = [b('edit', 'Edit'), b('password', 'Password')];
  if (p.role === 'teacher') out.unshift(b('teacher', 'Students and permissions', 'btn-outline'));
  out.push(p.active ? b('deactivate', 'Deactivate') : b('activate', 'Activate'));
  if (caps.deleteRestore) out.push(b('delete', 'Delete'));
  return out.join(' ');
}

function renderStudents() {
  const { students, deleted } = splitPeople(state.people);
  const list = filterStudents(students, { query: state.query, status: state.status });
  $('centre-students-count').textContent = String(students.length);
  const deletedStudents = deleted.filter((p) => p.role === 'student');
  if (!list.length && !deletedStudents.length) {
    $('centre-students-table').innerHTML = '<div class="empty-state">No students here yet.</div>';
    return;
  }
  const row = (p) => `<tr>
      <td class="num">${esc(p.student_code)}</td>
      <td>${esc(p.full_name)}</td>
      <td>${esc(p.level || '—')}</td>
      <td>${statusBadge(p)}</td>
      <td style="text-align: right; white-space: nowrap;">${personActions(p)}</td>
    </tr>`;
  const deletedRows = state.caps.deleteRestore && deletedStudents.length
    ? `<tr><td colspan="5" class="form-hint" style="padding-top: var(--space-4);">Deleted students</td></tr>${deletedStudents.map(row).join('')}`
    : '';
  $('centre-students-table').innerHTML = `<div class="table-responsive"><table class="data-table">
    <thead><tr><th>Code</th><th>Name</th><th>Level</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(row).join('') || '<tr><td colspan="5" class="empty-state">No students match.</td></tr>'}${deletedRows}</tbody>
  </table></div>`;
}

function renderTeachers() {
  const { teachers, deleted } = splitPeople(state.people);
  const counts = assignmentMap(state.assignments);
  $('centre-teachers-count').textContent = String(teachers.length);
  const deletedTeachers = deleted.filter((p) => p.role === 'teacher');
  if (!teachers.length && !deletedTeachers.length) {
    $('centre-teachers-table').innerHTML = '<div class="empty-state">No teachers here yet.</div>';
    return;
  }
  const row = (p) => `<tr>
      <td class="num">${esc(p.student_code)}</td>
      <td>${esc(p.full_name)}</td>
      <td class="num">${counts.get(p.id)?.size || 0}</td>
      <td>${statusBadge(p)}</td>
      <td style="text-align: right; white-space: nowrap;">${personActions(p)}</td>
    </tr>`;
  const deletedRows = state.caps.deleteRestore && deletedTeachers.length
    ? `<tr><td colspan="5" class="form-hint" style="padding-top: var(--space-4);">Deleted teachers</td></tr>${deletedTeachers.map(row).join('')}`
    : '';
  $('centre-teachers-table').innerHTML = `<div class="table-responsive"><table class="data-table">
    <thead><tr><th>Code</th><th>Name</th><th>Students</th><th>Status</th><th></th></tr></thead>
    <tbody>${teachers.map(row).join('')}${deletedRows}</tbody>
  </table></div>`;
}

function renderStaff() {
  const { head, vices } = splitPeople(state.people);
  const candidates = viceCandidates(state.people);
  const select = $('centre-vice-candidate');
  select.innerHTML = candidates.length
    ? candidates.map((t) => `<option value="${esc(t.id)}">${esc(t.full_name)} (${esc(t.student_code)})</option>`).join('')
    : '<option value="">No active teachers</option>';
  $('btn-make-vice').disabled = !candidates.length;
  const item = (p, removable) => `<li style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-color);">
      <span><b>${esc(p.full_name)}</b> <span class="form-hint num">${esc(p.student_code)}</span> · ${esc(roleName(p.role))} ${p.active ? '' : '<span class="badge badge-warning">Inactive</span>'}</span>
      ${removable ? `<button type="button" class="btn btn-ghost btn-sm" data-action="unvice" data-id="${esc(p.id)}">Make teacher again</button>` : ''}
    </li>`;
  $('centre-staff-list').innerHTML = `<ul style="list-style: none; margin: 0; padding: 0;">
      ${head ? item(head, false) : '<li class="form-hint">No centre head yet. The owner or a director appoints one.</li>'}
      ${vices.map((v) => item(v, state.caps.viceHeads && v.id !== state.actor?.id)).join('') || '<li class="form-hint" style="padding-top: var(--space-2);">No vice heads.</li>'}
    </ul>`;
}

function renderSettings() {
  const c = state.centre;
  if (!c) return;
  $('settings-name').value = c.name || '';
  $('settings-city').value = c.city || '';
  for (const [key] of SETTINGS_FIELDS) {
    const el = $(`settings-${key}`);
    if (el) el.value = c.settings?.[key] || '';
  }
}

function renderAudit() {
  const names = new Map(state.people.map((p) => [p.id, p.full_name || p.student_code]));
  if (state.actor) names.set(state.actor.id, state.actor.full_name || 'You');
  const centres = new Map(state.centre ? [[state.centre.id, state.centre]] : []);
  if (!state.audit.length) {
    $('centre-audit-list').innerHTML = '<div class="empty-state">No changes recorded yet.</div>';
    return;
  }
  $('centre-audit-list').innerHTML = `<ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2);">
    ${state.audit.map((r) => `<li><span class="form-hint num">${esc(new Date(r.at).toLocaleString('en-IN'))}</span> · ${esc(describeAudit(r, names, centres))}</li>`).join('')}
  </ul>`;
}

function renderAll() {
  renderHeader();
  renderStats();
  renderTabs();
  renderStudents();
  renderTeachers();
  renderStaff();
  renderSettings();
  renderAudit();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function levelOptions(selected) {
  return ['<option value="">No level</option>',
    ...STUDENT_LEVELS.map((l) => `<option value="${esc(l)}"${l === selected ? ' selected' : ''}>${esc(l)}</option>`)].join('');
}

function openAddModal(role) {
  $('add-form').reset();
  $('add-role').value = role;
  $('add-modal-title').textContent = role === 'teacher' ? 'Add teacher' : 'Add student';
  $('add-modal-subtitle').textContent = `They will be added to ${state.centre?.name || 'this centre'}.`;
  $('add-level-group').style.display = role === 'student' ? '' : 'none';
  $('add-level').innerHTML = levelOptions('');
  showError('add-form-error', '');
  openModal('add-modal');
}

async function submitAdd(e) {
  e.preventDefault();
  const role = $('add-role').value;
  const check = validateNewPerson({
    code: $('add-code').value, name: $('add-name').value, password: $('add-password').value,
    level: $('add-level').value, role,
  });
  if (check.error) return showError('add-form-error', check.error);
  const v = check.value;
  const btn = $('add-submit');
  btn.disabled = true;
  try {
    if (state.demo) {
      state.people.push({ id: `demo-${role}-${Date.now()}`, student_code: v.code, full_name: v.name, role, level: role === 'teacher' ? 'Teacher' : v.level, active: true });
    } else if (role === 'teacher') {
      await createTeacher({ teacher_code: v.code, full_name: v.name, password: v.password, centre_id: state.centreId });
    } else {
      await createStudent({ student_code: v.code, full_name: v.name, level: v.level, password: v.password, centre_id: state.centreId });
    }
    closeModal('add-modal');
    showToast('success', `${v.name} was added.`);
    await reload();
  } catch (err) {
    showError('add-form-error', err.message || 'Could not add them.');
  } finally {
    btn.disabled = false;
  }
}

function openEditModal(p) {
  $('edit-id').value = p.id;
  $('edit-name').value = p.full_name || '';
  $('edit-modal-title').textContent = p.role === 'teacher' ? 'Edit teacher' : 'Edit student';
  $('edit-modal-subtitle').textContent = p.student_code || '';
  $('edit-level-group').style.display = p.role === 'student' ? '' : 'none';
  $('edit-level').innerHTML = levelOptions(p.level || '');
  showError('edit-form-error', '');
  openModal('edit-modal');
}

async function submitEdit(e) {
  e.preventDefault();
  const p = personById($('edit-id').value);
  if (!p) return;
  const check = validatePersonEdit({ name: $('edit-name').value, level: $('edit-level').value, role: p.role });
  if (check.error) return showError('edit-form-error', check.error);
  try {
    if (state.demo) {
      Object.assign(p, { full_name: check.value.name, level: p.role === 'student' ? check.value.level : p.level });
    } else {
      await rpc('centre_update_person', { p_target: p.id, p_full_name: check.value.name, p_level: check.value.level });
    }
    closeModal('edit-modal');
    showToast('success', 'Saved.');
    await reload();
  } catch (err) {
    showError('edit-form-error', err.message);
  }
}

function openPasswordModal(p) {
  $('password-form').reset();
  $('password-id').value = p.id;
  $('password-modal-subtitle').textContent = `${p.full_name} (${p.student_code})`;
  showError('password-form-error', '');
  openModal('password-modal');
}

async function submitPassword(e) {
  e.preventDefault();
  const p = personById($('password-id').value);
  if (!p) return;
  const check = validatePassword($('password-new').value);
  if (check.error) return showError('password-form-error', check.error);
  try {
    if (!state.demo) await resetStudentPassword(p.id, check.value);
    closeModal('password-modal');
    showToast('success', `Password reset for ${p.full_name}.`);
  } catch (err) {
    showError('password-form-error', err.message);
  }
}

let teacherSelection = new Set();

function renderTeacherStudents() {
  const q = $('teacher-students-search').value.trim().toLowerCase();
  const students = splitPeople(state.people).students.filter((s) => s.active || teacherSelection.has(s.id));
  const shown = students.filter((s) => !q || `${s.full_name} ${s.student_code}`.toLowerCase().includes(q));
  $('teacher-students').innerHTML = shown.length
    ? shown.map((s) => `<label style="display: flex; gap: var(--space-2); align-items: center; padding: 2px 0;">
        <input type="checkbox" data-student="${esc(s.id)}" ${teacherSelection.has(s.id) ? 'checked' : ''} ${s.active ? '' : 'disabled'} />
        <span>${esc(s.full_name)} <span class="form-hint num">${esc(s.student_code)}</span></span></label>`).join('')
    : '<div class="form-hint">No students match.</div>';
}

function openTeacherModal(t) {
  $('teacher-id').value = t.id;
  $('teacher-modal-subtitle').textContent = `${t.full_name} (${t.student_code})`;
  $('teacher-students-search').value = '';
  teacherSelection = new Set(assignmentMap(state.assignments).get(t.id) || []);
  renderTeacherStudents();
  const perms = teacherPermissions(state.permissions, t.id);
  $('teacher-permissions').innerHTML = PERMISSION_FIELDS.map(([key, label]) => `<label style="display: flex; gap: var(--space-2); align-items: center;">
      <input type="checkbox" data-perm="${key}" ${perms[key] ? 'checked' : ''} /> <span>${esc(label)}</span></label>`).join('');
  showError('teacher-form-error', '');
  openModal('teacher-modal');
}

async function submitTeacher(e) {
  e.preventDefault();
  const t = personById($('teacher-id').value);
  if (!t) return;
  const ids = [...teacherSelection];
  const perms = {};
  document.querySelectorAll('#teacher-permissions [data-perm]').forEach((el) => { perms[el.dataset.perm] = el.checked; });
  const btn = $('teacher-submit');
  btn.disabled = true;
  try {
    if (state.demo) {
      state.assignments = state.assignments.filter((a) => a.teacher_id !== t.id).concat(ids.map((s) => ({ teacher_id: t.id, student_id: s })));
      state.permissions = state.permissions.filter((p) => p.teacher_id !== t.id).concat([{ teacher_id: t.id, ...perms }]);
    } else {
      await rpc('centre_set_teacher_assignments', { p_teacher: t.id, p_student_ids: ids });
      await rpc('centre_update_teacher_permissions', { p_teacher: t.id, p_permissions: perms });
    }
    closeModal('teacher-modal');
    showToast('success', `Saved ${t.full_name}: ${ids.length} student(s).`);
    await reload();
  } catch (err) {
    showError('teacher-form-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function runPersonAction(action, p) {
  const labels = {
    activate: [`Activate ${p.full_name}?`, 'centre_set_active', { p_target: p.id, p_active: true }, 'Activated.'],
    deactivate: [`Deactivate ${p.full_name}? They will not be able to sign in.`, 'centre_set_active', { p_target: p.id, p_active: false }, 'Deactivated.'],
    delete: [`Delete ${p.full_name}? Their records are kept and the head can restore them.`, 'centre_soft_delete', { p_target: p.id }, 'Deleted.'],
    restore: [`Restore ${p.full_name}?`, 'centre_restore', { p_target: p.id }, 'Restored.'],
    unvice: [`Make ${p.full_name} a teacher again?`, 'set_person_role', { p_target: p.id, p_role: 'teacher', p_centre: state.centreId }, 'They are a teacher again.'],
  };
  const spec = labels[action];
  if (!spec) return;
  if (!window.confirm(spec[0])) return;
  try {
    if (state.demo) {
      if (action === 'activate' || action === 'deactivate') p.active = action === 'activate';
      if (action === 'delete') Object.assign(p, { deleted_at: new Date().toISOString(), active: false });
      if (action === 'restore') Object.assign(p, { deleted_at: null, active: true });
      if (action === 'unvice') p.role = 'teacher';
    } else {
      await rpc(spec[1], spec[2]);
    }
    showToast('success', spec[3]);
    await reload();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function makeVice() {
  const p = personById($('centre-vice-candidate').value);
  if (!p) return;
  if (!window.confirm(`Make ${p.full_name} a vice head of ${state.centre?.name || 'this centre'}?`)) return;
  try {
    if (state.demo) p.role = 'vice_centre_head';
    else await rpc('set_person_role', { p_target: p.id, p_role: 'vice_centre_head', p_centre: state.centreId });
    showToast('success', `${p.full_name} is now a vice head.`);
    await reload();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function submitSettings(e) {
  e.preventDefault();
  const settings = {};
  for (const [key] of SETTINGS_FIELDS) settings[key] = $(`settings-${key}`).value;
  const check = validateSettings({ name: $('settings-name').value, city: $('settings-city').value, settings });
  if (check.error) return showError('settings-form-error', check.error);
  showError('settings-form-error', '');
  const btn = $('settings-submit');
  btn.disabled = true;
  try {
    if (state.demo) {
      Object.assign(state.centre, { name: check.value.name, city: check.value.city, settings: check.value.settings });
    } else {
      await rpc('centre_update_settings', {
        p_centre: state.centreId, p_name: check.value.name, p_city: check.value.city, p_settings: check.value.settings,
      });
    }
    showToast('success', 'Centre settings saved.');
    await reload();
  } catch (err) {
    showError('settings-form-error', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function downloadBackup() {
  const btn = $('btn-centre-backup');
  const status = $('centre-backup-status');
  btn.disabled = true;
  status.textContent = 'Preparing…';
  try {
    const backup = state.demo
      ? { centre: state.centre, generated_at: new Date().toISOString(), row_limit: 50000, tables: { profiles: state.people } }
      : await rpc('centre_backup', { p_centre: state.centreId });
    const bytes = await buildXlsx(backupSheets(backup));
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName(backup.centre || state.centre);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Downloaded.';
    if (!state.demo) await reload();
  } catch (err) {
    status.textContent = '';
    showToast('error', err.message || 'Could not make the backup.');
  } finally {
    btn.disabled = false;
  }
}

function setupListeners() {
  $('centre-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    renderTabs();
  });
  $('centre-students-search').addEventListener('input', (e) => { state.query = e.target.value; renderStudents(); });
  $('centre-students-status').addEventListener('change', (e) => { state.status = e.target.value; renderStudents(); });
  $('btn-add-student').addEventListener('click', () => openAddModal('student'));
  $('btn-add-teacher').addEventListener('click', () => openAddModal('teacher'));
  $('btn-make-vice').addEventListener('click', makeVice);
  $('btn-centre-backup').addEventListener('click', downloadBackup);
  $('add-form').addEventListener('submit', submitAdd);
  $('edit-form').addEventListener('submit', submitEdit);
  $('password-form').addEventListener('submit', submitPassword);
  $('teacher-form').addEventListener('submit', submitTeacher);
  $('settings-form').addEventListener('submit', submitSettings);
  $('teacher-students-search').addEventListener('input', renderTeacherStudents);
  $('teacher-students').addEventListener('change', (e) => {
    const id = e.target?.dataset?.student;
    if (!id) return;
    if (e.target.checked) teacherSelection.add(id);
    else teacherSelection.delete(id);
  });
  document.querySelector('.main-content').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action][data-id]');
    if (!b) return;
    const p = personById(b.dataset.id);
    if (!p) return;
    const action = b.dataset.action;
    if (action === 'edit') openEditModal(p);
    else if (action === 'password') openPasswordModal(p);
    else if (action === 'teacher') openTeacherModal(p);
    else runPersonAction(action, p);
  });
}

export async function initCentrePage() {
  const profile = await requireAuth(['admin', 'centre_head', 'vice_centre_head']);
  if (!profile) return;
  if (!canOpenCentrePanel(profile)) {
    window.location.replace('/index.html');
    return;
  }
  state.actor = profile;
  state.network = isNetworkRole(profile.network_role || profile.role);
  state.demo = !isSupabaseConfigured();
  setupModalListeners();
  setupListeners();
  try {
    state.centreId = await resolveCentreId();
  } catch {
    state.centreId = null;
  }
  await reload();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initCentrePage();
  });
}
