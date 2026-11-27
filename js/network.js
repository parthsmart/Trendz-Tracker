/**
 * Trendz Tracker — owner and director panel (js/network.js, pages/network.html)
 *
 * Only owners and directors (and the legacy admin) see this page. It reads
 * every centre and person through RLS, edits centres and duel openings
 * directly (RLS + the centres guard decide), changes roles and centres only
 * through set_person_role(), and creates staff accounts through
 * /api/manage-teacher (action create_staff).
 */

import { requireAuth } from './guard.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { openModal, closeModal, setupModalListeners } from './modal.js';
import { showToast } from './toast.js';
import { createStaff } from './api.js';
import { isNetworkRole } from './roles.js';
import {
  assignableRoles,
  canManagePerson,
  centreActions,
  centreStats,
  creatableStaffRoles,
  describeAudit,
  describeGrant,
  filterPeople,
  grantRow,
  needsCentre,
  networkTotals,
  readActiveCentre,
  realRole,
  roleName,
  validateCentreInput,
  validateGrant,
  writeActiveCentre,
} from './networkModel.js';

const PEOPLE_LIMIT = 200;

const state = {
  actor: null,
  demo: false,
  centres: [],
  people: [],
  posts: [],
  grants: [],
  audit: [],
  activeCentre: '',
  roleFilter: '',
  query: '',
};

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const $ = (id) => document.getElementById(id);

function showFormError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

function centreById() {
  return new Map(state.centres.map((c) => [c.id, c]));
}

function centreLabel(id) {
  if (!id) return 'Network';
  const c = state.centres.find((x) => x.id === id);
  return c ? `${c.name} (${c.code})` : 'Unknown centre';
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function demoData() {
  const centres = [
    { id: 'demo-centre-brn', name: 'Baran Centre', code: 'BRN', kind: 'centre', status: 'active', is_default: true, city: 'Baran' },
    { id: 'demo-centre-kta', name: 'Kota Centre', code: 'KTA', kind: 'centre', status: 'active', is_default: false, city: 'Kota' },
  ];
  const students = (DemoDB.getStudents?.() || [])
    .filter((s) => s.role === 'student')
    .map((s, i) => ({
      id: s.id,
      student_code: s.student_code,
      full_name: s.full_name,
      role: 'student',
      centre_id: i % 4 === 3 ? 'demo-centre-kta' : 'demo-centre-brn',
      active: s.active !== false,
      level: s.level,
      deleted_at: s.deleted_at || null,
    }));
  const me = state.actor;
  const people = [
    { id: me.id, student_code: me.student_code || 'OWNER', full_name: me.full_name || 'Owner', role: realRole(me), centre_id: null, active: true },
    { id: 'demo-teacher-1', student_code: 'TCH01', full_name: 'Anita Sharma', role: 'teacher', centre_id: 'demo-centre-brn', active: true },
    { id: 'demo-head-kta', student_code: 'KTAHEAD', full_name: 'Rohit Meena', role: 'centre_head', centre_id: 'demo-centre-kta', active: true },
    ...students,
  ];
  const posts = [{ id: 1, centre_id: 'demo-centre-kta', profile_id: 'demo-head-kta', role: 'centre_head', ended_at: null }];
  const audit = [
    { id: 1, at: new Date().toISOString(), actor_id: me.id, target_id: 'demo-head-kta', action: 'role_change',
      before: { role: 'teacher' }, after: { role: 'centre_head', centre_id: 'demo-centre-kta' } },
  ];
  return { centres, people, posts, grants: [], audit };
}

async function loadData() {
  if (state.demo) {
    if (!state.centres.length) Object.assign(state, demoData());
    return;
  }
  const supabase = await getSupabase();
  const [centres, people, posts, grants, audit] = await Promise.all([
    supabase.from('centres').select('id, name, code, kind, status, is_default, city, created_at').order('name'),
    supabase.from('profiles').select('id, student_code, full_name, role, centre_id, active, level, deleted_at'),
    supabase.from('centre_staff').select('id, centre_id, profile_id, role, assigned_at, ended_at').is('ended_at', null),
    supabase.from('centre_visibility').select('*').order('created_at', { ascending: false }),
    supabase.from('role_audit').select('id, at, actor_id, actor_role, target_id, centre_id, action, before, after')
      .order('at', { ascending: false }).limit(60),
  ]);
  const failed = [centres, people, posts, grants, audit].find((r) => r.error);
  if (failed) throw new Error(failed.error.message || 'Could not load the network.');
  state.centres = centres.data || [];
  state.people = people.data || [];
  state.posts = posts.data || [];
  state.grants = grants.data || [];
  state.audit = audit.data || [];
}

async function reload() {
  try {
    await loadData();
    showFormError('network-error', '');
  } catch (err) {
    showFormError('network-error', err.message);
  }
  state.activeCentre = readActiveCentre(window.localStorage, state.centres);
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusBadge(status) {
  const cls = status === 'active' ? 'badge-success' : status === 'suspended' ? 'badge-warning' : 'badge-neutral';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function renderSwitcher() {
  const sel = $('network-centre-switch');
  if (!sel) return;
  const opts = ['<option value="">All centres</option>']
    .concat(state.centres.filter((c) => c.status !== 'archived')
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.code)})</option>`))
    .concat('<option value="network">Network staff only</option>');
  sel.innerHTML = opts.join('');
  sel.value = state.activeCentre;
}

function renderDashboard() {
  const scoped = state.activeCentre
    ? state.people.filter((p) => (state.activeCentre === 'network' ? !p.centre_id : p.centre_id === state.activeCentre))
    : state.people;
  const t = networkTotals(scoped);
  const card = (label, value, sub = '') => `
    <div class="stat-card"><span class="stat-label">${esc(label)}</span>
      <span class="stat-value num">${esc(value)}</span>${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
  $('network-totals').innerHTML = [
    card('Students', t.students, `${t.activeStudents} active`),
    card('Teachers', t.teachers),
    card('Heads and vice heads', t.heads),
    card('Centres', state.centres.filter((c) => c.status !== 'archived').length),
  ].join('');

  const stats = centreStats(state.centres, state.people, state.posts)
    .filter((s) => s.centre.status !== 'archived')
    .filter((s) => !state.activeCentre || s.centre.id === state.activeCentre);
  $('network-centre-cards').innerHTML = stats.map((s) => `
    <div class="stat-card">
      <span class="stat-label">${esc(s.centre.name)} <span class="num">· ${esc(s.centre.code)}</span> ${s.centre.status !== 'active' ? statusBadge(s.centre.status) : ''}</span>
      <span class="stat-value num">${s.students}</span>
      <span class="stat-sub">students · ${s.teachers} teachers</span>
      <span class="stat-sub">Head: ${s.head ? esc(s.head.full_name) : '<i>none yet</i>'}${s.vices.length ? ` · ${s.vices.length} vice` : ''}</span>
      ${s.centre.status === 'active' ? `<a class="btn btn-outline btn-sm" style="margin-top: var(--space-2); align-self: flex-start;" href="/pages/centre.html?centre=${encodeURIComponent(s.centre.id)}">Open centre panel</a>` : ''}
    </div>`).join('');
}

function renderCentres() {
  const stats = new Map(centreStats(state.centres, state.people, state.posts).map((s) => [s.centre.id, s]));
  if (!state.centres.length) {
    $('network-centres-table').innerHTML = '<div class="empty-state">No centres yet.</div>';
    return;
  }
  const label = { edit: 'Edit', suspend: 'Suspend', activate: 'Activate', archive: 'Archive', restore: 'Restore' };
  const rows = state.centres.map((c) => {
    const s = stats.get(c.id) || {};
    const buttons = centreActions(c, s).map((a) => `<button type="button" class="btn btn-${a === 'archive' || a === 'suspend' ? 'ghost' : 'outline'} btn-sm" data-centre-action="${a}" data-centre-id="${esc(c.id)}">${label[a]}</button>`).join(' ');
    const open = c.status === 'active' ? `<a class="btn btn-ghost btn-sm" href="/pages/centre.html?centre=${encodeURIComponent(c.id)}">Open</a> ` : '';
    return `<tr>
      <td><b>${esc(c.name)}</b>${c.is_default ? ' <span class="badge badge-neutral">default</span>' : ''}<div class="form-hint">${esc(c.kind)}${c.city ? ` · ${esc(c.city)}` : ''}</div></td>
      <td class="num">${esc(c.code)}</td>
      <td>${statusBadge(c.status)}</td>
      <td class="num">${s.students || 0}</td>
      <td>${s.head ? esc(s.head.full_name) : '—'}</td>
      <td style="text-align: right; white-space: nowrap;">${open}${buttons}</td>
    </tr>`;
  }).join('');
  $('network-centres-table').innerHTML = `<div class="table-container"><table class="data-table">
    <thead><tr><th>Centre</th><th>Code</th><th>Status</th><th>Students</th><th>Head</th><th style="text-align: right;">Actions</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderPeople() {
  const list = filterPeople(state.people, { centreId: state.activeCentre, role: state.roleFilter, query: state.query });
  $('network-people-count').textContent = String(list.length);
  if (!list.length) {
    $('network-people-table').innerHTML = '<div class="empty-state">Nobody matches.</div>';
    return;
  }
  const rows = list.slice(0, PEOPLE_LIMIT).map((p) => {
    const manage = canManagePerson(state.actor, p);
    const role = realRole(p);
    const actions = manage
      ? `<button type="button" class="btn btn-outline btn-sm" data-person-action="role" data-person-id="${esc(p.id)}">Role / centre</button>
         <button type="button" class="btn btn-ghost btn-sm" data-person-action="${p.active === false ? 'activate' : 'deactivate'}" data-person-id="${esc(p.id)}">${p.active === false ? 'Activate' : 'Deactivate'}</button>`
      : '';
    return `<tr>
      <td><b>${esc(p.full_name || '—')}</b><div class="form-hint num">${esc(p.student_code || '')}</div></td>
      <td>${esc(roleName(role))}</td>
      <td>${esc(centreLabel(p.centre_id))}</td>
      <td>${p.active === false ? '<span class="badge badge-neutral">inactive</span>' : '<span class="badge badge-success">active</span>'}</td>
      <td style="text-align: right; white-space: nowrap;">${actions}</td>
    </tr>`;
  }).join('');
  const more = list.length > PEOPLE_LIMIT ? `<p class="form-hint">Showing the first ${PEOPLE_LIMIT}. Search or filter to find others.</p>` : '';
  $('network-people-table').innerHTML = `<div class="table-container"><table class="data-table">
    <thead><tr><th>Name</th><th>Role</th><th>Centre</th><th>Status</th><th style="text-align: right;">Actions</th></tr></thead>
    <tbody>${rows}</tbody></table></div>${more}`;
}

function renderGrants() {
  const byId = centreById();
  if (!state.grants.length) {
    $('network-grants-list').innerHTML = '<div class="empty-state">No students are open to other centres yet.</div>';
    return;
  }
  $('network-grants-list').innerHTML = `<ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2);">
    ${state.grants.map((g) => `<li style="display: flex; justify-content: space-between; gap: var(--space-3); align-items: center;">
      <span>${esc(describeGrant(g, byId))}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-grant-remove="${esc(g.id)}">Remove</button></li>`).join('')}
  </ul>`;
}

function renderAudit() {
  const names = new Map(state.people.map((p) => [p.id, p.full_name || p.student_code]));
  const byId = centreById();
  const rows = state.audit
    .filter((r) => !state.activeCentre || state.activeCentre === 'network' || r.centre_id === state.activeCentre)
    .slice(0, 40);
  if (!rows.length) {
    $('network-audit-list').innerHTML = '<div class="empty-state">No changes yet.</div>';
    return;
  }
  $('network-audit-list').innerHTML = `<ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2);">
    ${rows.map((r) => `<li><span class="form-hint num">${esc(new Date(r.at).toLocaleString('en-IN'))}</span> · ${esc(describeAudit(r, names, byId))}</li>`).join('')}
  </ul>`;
}

function renderAll() {
  const roleEl = $('network-actor-role');
  if (roleEl) roleEl.textContent = roleName(realRole(state.actor));
  renderSwitcher();
  renderDashboard();
  renderCentres();
  renderPeople();
  renderGrants();
  renderAudit();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function centreOptions(selected = '', { includeNone = false } = {}) {
  const active = state.centres.filter((c) => c.status === 'active');
  return (includeNone ? ['<option value="">Every centre</option>'] : [])
    .concat(active.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)} (${esc(c.code)})</option>`))
    .join('');
}

function openCentreModal(centre = null) {
  showFormError('centre-form-error', '');
  $('centre-modal-title').textContent = centre ? 'Edit centre' : 'Add centre';
  $('centre-id').value = centre?.id || '';
  $('centre-name').value = centre?.name || '';
  $('centre-code').value = centre?.code || '';
  $('centre-kind').value = centre?.kind || 'centre';
  $('centre-city').value = centre?.city || '';
  openModal('centre-modal');
}

async function saveCentre(e) {
  e.preventDefault();
  const input = {
    name: $('centre-name').value.trim(),
    code: $('centre-code').value.trim().toUpperCase(),
    kind: $('centre-kind').value,
    city: $('centre-city').value.trim() || null,
  };
  const problem = validateCentreInput(input);
  if (problem) return showFormError('centre-form-error', problem);
  const id = $('centre-id').value;
  $('centre-submit').disabled = true;
  try {
    if (state.demo) {
      if (id) Object.assign(state.centres.find((c) => c.id === id), input);
      else state.centres.push({ id: `demo-centre-${Date.now()}`, status: 'active', is_default: false, ...input });
    } else {
      const supabase = await getSupabase();
      const { error } = id
        ? await supabase.from('centres').update(input).eq('id', id)
        : await supabase.from('centres').insert(input);
      if (error) throw new Error(/duplicate|unique/i.test(error.message) ? 'A centre with that name or code already exists.' : error.message);
    }
    closeModal('centre-modal');
    showToast('success', id ? 'Centre saved.' : 'Centre added.');
    await reload();
  } catch (err) {
    showFormError('centre-form-error', err.message);
  } finally {
    $('centre-submit').disabled = false;
  }
}

async function setCentreStatus(centre, status) {
  const verbs = { suspended: 'Suspend', active: 'Activate', archived: 'Archive' };
  const note = status === 'suspended'
    ? ' Nobody new can be added to it while suspended.'
    : status === 'archived' ? ' It will be hidden from the site.' : '';
  if (!window.confirm(`${verbs[status]} ${centre.name}?${note}`)) return;
  try {
    if (state.demo) {
      centre.status = status;
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase.from('centres').update({ status }).eq('id', centre.id);
      if (error) throw new Error(error.message);
    }
    showToast('success', `${centre.name} is now ${status}.`);
    await reload();
  } catch (err) {
    showToast('error', err.message);
  }
}

function syncStaffCentre() {
  $('staff-centre-group').style.display = needsCentre($('staff-role').value) ? '' : 'none';
}

function openStaffModal() {
  showFormError('staff-form-error', '');
  const roles = creatableStaffRoles(realRole(state.actor));
  $('staff-role').innerHTML = roles.map((r) => `<option value="${r}">${esc(roleName(r))}</option>`).join('');
  $('staff-centre').innerHTML = centreOptions(state.activeCentre && state.activeCentre !== 'network' ? state.activeCentre : '');
  $('staff-code').value = '';
  $('staff-name').value = '';
  $('staff-password').value = '';
  syncStaffCentre();
  openModal('staff-modal');
}

async function submitStaff(e) {
  e.preventDefault();
  const role = $('staff-role').value;
  const payload = {
    role,
    centre_id: needsCentre(role) ? $('staff-centre').value || null : null,
    staff_code: $('staff-code').value.trim().toUpperCase(),
    full_name: $('staff-name').value.trim(),
    password: $('staff-password').value,
  };
  if (payload.password.trim().length < 8) return showFormError('staff-form-error', 'Password must be at least 8 characters long.');
  if (needsCentre(role) && !payload.centre_id) return showFormError('staff-form-error', 'Choose a centre for this person.');
  $('staff-submit').disabled = true;
  try {
    const result = await createStaff(payload);
    $('staff-password').value = '';
    if (state.demo && result?.staff) {
      state.people.push({ ...result.staff, role: payload.role, centre_id: payload.centre_id });
      if (role === 'centre_head' || role === 'vice_centre_head') {
        state.posts.push({ id: Date.now(), centre_id: payload.centre_id, profile_id: result.staff.id, role, ended_at: null });
      }
    }
    closeModal('staff-modal');
    showToast('success', `${payload.full_name} can now sign in as ${roleName(role)} with code ${payload.staff_code}.`);
    await reload();
  } catch (err) {
    showFormError('staff-form-error', err.message);
  } finally {
    $('staff-submit').disabled = false;
  }
}

function syncPersonCentre() {
  $('person-centre-group').style.display = needsCentre($('person-role').value) ? '' : 'none';
}

function openPersonModal(person) {
  showFormError('person-form-error', '');
  const current = realRole(person);
  const roles = assignableRoles(realRole(state.actor));
  if (!roles.includes(current)) roles.unshift(current);
  $('person-id').value = person.id;
  $('person-modal-subtitle').textContent = `${person.full_name || person.student_code} · now ${roleName(current)}, ${centreLabel(person.centre_id)}`;
  $('person-role').innerHTML = roles.map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${esc(roleName(r))}</option>`).join('');
  $('person-centre').innerHTML = centreOptions(person.centre_id || '');
  syncPersonCentre();
  openModal('person-modal');
}

async function submitPerson(e) {
  e.preventDefault();
  const person = state.people.find((p) => p.id === $('person-id').value);
  if (!person) return;
  const role = $('person-role').value;
  const centre = needsCentre(role) ? $('person-centre').value || null : null;
  if (role === realRole(person) && centre === (person.centre_id || null)) {
    closeModal('person-modal');
    return;
  }
  $('person-submit').disabled = true;
  try {
    if (state.demo) {
      Object.assign(person, { role, centre_id: centre });
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase.rpc('set_person_role', { p_target: person.id, p_role: role, p_centre: centre });
      if (error) throw new Error(error.message);
    }
    closeModal('person-modal');
    showToast('success', `${person.full_name || 'Saved'}: ${roleName(role)}, ${centreLabel(centre)}.`);
    await reload();
  } catch (err) {
    showFormError('person-form-error', err.message);
  } finally {
    $('person-submit').disabled = false;
  }
}

async function setPersonActive(person, active) {
  if (!active && !window.confirm(`Deactivate ${person.full_name || person.student_code}? They will not be able to sign in.`)) return;
  try {
    if (state.demo) {
      person.active = active;
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase.from('profiles').update({ active }).eq('id', person.id);
      if (error) throw new Error(error.message);
    }
    showToast('success', `${person.full_name || 'Account'} ${active ? 'activated' : 'deactivated'}.`);
    await reload();
  } catch (err) {
    showToast('error', err.message);
  }
}

function syncGrantMode() {
  const mode = $('grant-mode').value;
  $('grant-topn-group').style.display = mode === 'top_n' ? '' : 'none';
  $('grant-students-group').style.display = mode === 'students' ? '' : 'none';
  if (mode === 'students') {
    const source = $('grant-source').value;
    const students = filterPeople(state.people, { centreId: source, role: 'student', showInactive: false });
    $('grant-students').innerHTML = students.length
      ? students.map((s) => `<label style="display: flex; gap: var(--space-2); align-items: center; padding: 2px 0;"><input type="checkbox" value="${esc(s.id)}" /> ${esc(s.full_name)} <span class="form-hint num">${esc(s.student_code)}</span></label>`).join('')
      : '<div class="form-hint">No active students in this centre.</div>';
  }
}

function openGrantModal() {
  showFormError('grant-form-error', '');
  const def = state.activeCentre && state.activeCentre !== 'network' ? state.activeCentre : '';
  $('grant-source').innerHTML = centreOptions(def);
  $('grant-viewer').innerHTML = centreOptions('', { includeNone: true });
  $('grant-mode').value = 'all';
  syncGrantMode();
  openModal('grant-modal');
}

async function submitGrant(e) {
  e.preventDefault();
  const input = {
    source_centre_id: $('grant-source').value,
    viewer_centre_id: $('grant-viewer').value || null,
    mode: $('grant-mode').value,
    top_n: $('grant-topn').value,
    student_ids: [...$('grant-students').querySelectorAll('input:checked')].map((i) => i.value),
  };
  const problem = validateGrant(input);
  if (problem) return showFormError('grant-form-error', problem);
  $('grant-submit').disabled = true;
  try {
    const row = grantRow(input);
    if (state.demo) {
      state.grants.unshift({ id: Date.now(), ...row });
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase.from('centre_visibility').insert(row);
      if (error) throw new Error(error.message);
    }
    closeModal('grant-modal');
    showToast('success', 'Saved.');
    await reload();
  } catch (err) {
    showFormError('grant-form-error', err.message);
  } finally {
    $('grant-submit').disabled = false;
  }
}

async function removeGrant(id) {
  if (!window.confirm('Remove this duel opening?')) return;
  try {
    if (state.demo) {
      state.grants = state.grants.filter((g) => String(g.id) !== String(id));
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase.from('centre_visibility').delete().eq('id', id);
      if (error) throw new Error(error.message);
    }
    await reload();
  } catch (err) {
    showToast('error', err.message);
  }
}

function setupListeners() {
  $('network-centre-switch').addEventListener('change', (e) => {
    state.activeCentre = e.target.value;
    writeActiveCentre(window.localStorage, state.activeCentre);
    renderAll();
  });
  $('network-people-role').addEventListener('change', (e) => { state.roleFilter = e.target.value; renderPeople(); });
  $('network-people-search').addEventListener('input', (e) => { state.query = e.target.value; renderPeople(); });

  $('btn-open-create-centre').addEventListener('click', () => openCentreModal());
  $('btn-open-create-staff').addEventListener('click', openStaffModal);
  $('btn-open-create-grant').addEventListener('click', openGrantModal);
  $('centre-form').addEventListener('submit', saveCentre);
  $('staff-form').addEventListener('submit', submitStaff);
  $('person-form').addEventListener('submit', submitPerson);
  $('grant-form').addEventListener('submit', submitGrant);
  $('staff-role').addEventListener('change', syncStaffCentre);
  $('person-role').addEventListener('change', syncPersonCentre);
  $('grant-mode').addEventListener('change', syncGrantMode);
  $('grant-source').addEventListener('change', syncGrantMode);

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-centre-action]');
    if (c) {
      const centre = state.centres.find((x) => x.id === c.dataset.centreId);
      if (!centre) return;
      const action = c.dataset.centreAction;
      if (action === 'edit') openCentreModal(centre);
      else setCentreStatus(centre, { suspend: 'suspended', activate: 'active', restore: 'active', archive: 'archived' }[action]);
      return;
    }
    const p = e.target.closest('[data-person-action]');
    if (p) {
      const person = state.people.find((x) => x.id === p.dataset.personId);
      if (!person) return;
      if (p.dataset.personAction === 'role') openPersonModal(person);
      else setPersonActive(person, p.dataset.personAction === 'activate');
      return;
    }
    const g = e.target.closest('[data-grant-remove]');
    if (g) removeGrant(g.dataset.grantRemove);
  });
}

export async function initNetworkPage() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;
  if (!isNetworkRole(profile.network_role || profile.role)) {
    window.location.replace('/pages/admin.html');
    return;
  }
  state.actor = profile;
  state.demo = !isSupabaseConfigured();
  setupModalListeners();
  setupListeners();
  await reload();
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initNetworkPage();
  });
}
