/**
 * Fair Play Checks page (teachers, centre heads, admins).
 *
 * Lists results the server flagged as unusually fast (fair_play_queue RPC, already limited to
 * students the caller may review), lets the reviewer approve or void them (fair_play_decide),
 * shows the audit trail (fair_play_history), and gives admins a thresholds editor
 * (fair_play_thresholds + fair_play_threshold_save).
 */
import { requireAuth } from './guard.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { setupAdminNav } from './modal.js';
import { REASON_LABELS } from '../shared/fairPlay.js';

let profile = null;
let busy = false;

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line of counts and timings for a review row. */
export function describeDetail(detail) {
  const d = detail || {};
  const parts = [];
  if (d.correct != null) parts.push(`${d.correct} correct${d.attempted != null ? ` of ${d.attempted}` : d.total != null ? ` of ${d.total}` : ''}`);
  const secs = d.used_seconds ?? d.seconds;
  if (secs != null) parts.push(`${Math.round(Number(secs) * 10) / 10} s`);
  if (d.seconds_per_question != null) parts.push(`${d.seconds_per_question} s a question`);
  if (d.server_seconds != null) parts.push(`server clock ${d.server_seconds} s`);
  if (d.official_points != null) parts.push(`${d.official_points} official points`);
  return parts.join(' · ');
}

export function describeReasons(reasons) {
  return (reasons || []).map((r) => REASON_LABELS[r] || r).join('; ');
}

const STATUS_LABEL = { open: 'Waiting', approved: 'Approved', voided: 'Voided' };

export function renderQueueHtml(rows, status) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state" style="padding: var(--space-6); text-align: center;">${
      status === 'open' ? 'Nothing waiting. Every recent result looks normal.' : 'No results here.'
    }</div>`;
  }
  const body = rows
    .map((r) => {
      const when = r.created_at ? new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const actions = [];
      if (r.status !== 'approved') actions.push(`<button type="button" class="btn btn-sm btn-primary" data-fp-decide="approve" data-id="${r.id}">${r.status === 'voided' ? 'Restore' : 'Approve'}</button>`);
      if (r.status !== 'voided') actions.push(`<button type="button" class="btn btn-sm btn-outline" data-fp-decide="void" data-id="${r.id}">Void</button>`);
      actions.push(`<button type="button" class="btn btn-sm btn-ghost" data-fp-history="${r.id}">History</button>`);
      return `<tr>
        <td><strong>${escapeHtml(r.student_name)}</strong><div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(r.student_code || '')}${r.level ? ` · ${escapeHtml(r.level)}` : ''}</div></td>
        <td>${escapeHtml(r.label || r.kind)}<div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(when)}</div></td>
        <td>${escapeHtml(describeDetail(r.detail))}<div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(describeReasons(r.reasons))}</div></td>
        <td>${escapeHtml(String(r.xp ?? 0))}</td>
        <td>${escapeHtml(STATUS_LABEL[r.status] || r.status)}${r.decision_note ? `<div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(r.decision_note)}</div>` : ''}</td>
        <td style="white-space: nowrap; display: flex; gap: var(--space-1); flex-wrap: wrap;">${actions.join('')}</td>
      </tr>`;
    })
    .join('');
  return `<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Student</th><th>Practice</th><th>What looked unusual</th><th>XP</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

export function renderThresholdsHtml(rows) {
  const sorted = [...(rows || [])].sort((a, b) =>
    `${a.kind}|${a.key}|${String(a.level).padStart(3, '0')}`.localeCompare(`${b.kind}|${b.key}|${String(b.level).padStart(3, '0')}`)
  );
  const num = (v) => (v === null || v === undefined ? '' : escapeHtml(String(v)));
  const body = sorted
    .map(
      (t) => `<tr data-kind="${escapeHtml(t.kind)}" data-key="${escapeHtml(t.key)}" data-level="${escapeHtml(t.level)}">
        <td>${escapeHtml(t.kind)}</td><td>${escapeHtml(t.key)}</td><td>${escapeHtml(t.level)}</td>
        <td><input class="form-input" type="number" step="0.05" min="0" name="reject_spq" value="${num(t.reject_spq)}" aria-label="Reject seconds a question" style="width: 6rem;"></td>
        <td><input class="form-input" type="number" step="0.05" min="0" name="flag_spq" value="${num(t.flag_spq)}" aria-label="Flag seconds a correct answer" style="width: 6rem;"></td>
        <td><input class="form-input" type="number" step="1" min="1" name="max_correct" value="${num(t.max_correct)}" aria-label="Flag above this many correct" style="width: 6rem;"></td>
        <td><input type="checkbox" name="enabled" ${t.enabled !== false ? 'checked' : ''} aria-label="Enabled"></td>
        <td><button type="button" class="btn btn-sm btn-outline" data-fp-save-threshold>Save</button></td>
      </tr>`
    )
    .join('');
  return `<div class="table-wrapper"><table class="data-table">
    <thead><tr><th>Kind</th><th>Key</th><th>Level</th><th>Reject (s/q)</th><th>Flag (s/correct)</th><th>Flag above correct</th><th>On</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function parseNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function loadQueue() {
  const box = document.getElementById('fp-queue');
  const status = document.getElementById('fp-status-filter')?.value || 'open';
  if (!box) return;
  if (isDemoMode() || !isSupabaseConfigured()) {
    box.innerHTML = renderQueueHtml([], status);
    return;
  }
  box.innerHTML = '<div class="loading-state">Loading checks...</div>';
  const { data, error } = await getSupabase().rpc('fair_play_queue', { p_status: status, p_limit: 200 });
  if (error) {
    box.innerHTML = `<div class="error-state">Could not load the checks: ${escapeHtml(error.message)}</div>`;
    return;
  }
  box.innerHTML = renderQueueHtml(data || [], status);
}

async function decide(id, decision) {
  if (busy) return;
  const verb = decision === 'void' ? 'Void' : 'Approve';
  const note = window.prompt(
    decision === 'void'
      ? 'Void this result? It leaves the boards, XP and coins (you can restore it later). Optional note:'
      : `${verb} this result? Optional note:`,
    ''
  );
  if (note === null) return;
  busy = true;
  try {
    const { data, error } = await getSupabase().rpc('fair_play_decide', {
      p_review: Number(id),
      p_decision: decision,
      p_note: note.trim() || null,
    });
    if (error) throw error;
    showToast('success', data?.status === 'voided' ? 'Result voided.' : 'Result approved.');
    await loadQueue();
  } catch (err) {
    showToast('error', err?.message || 'Could not save the decision.');
  } finally {
    busy = false;
  }
}

async function showHistory(id) {
  const overlay = document.getElementById('fp-history-overlay');
  const list = document.getElementById('fp-history-list');
  if (!overlay || !list) return;
  overlay.style.display = 'flex';
  list.innerHTML = '<div class="loading-state">Loading history...</div>';
  const { data, error } = await getSupabase().rpc('fair_play_history', { p_review: Number(id) });
  if (error) {
    list.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  list.innerHTML = (data || [])
    .map(
      (h) => `<div class="audit-item" style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-hairline);">
        <strong>${escapeHtml(h.action)}</strong> ${h.actor_name ? `by ${escapeHtml(h.actor_name)}` : '(automatic)'}
        <div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(new Date(h.at).toLocaleString('en-IN'))}</div>
        ${h.note ? `<div style="font-size: var(--text-sm);">${escapeHtml(h.note)}</div>` : ''}
      </div>`
    )
    .join('') || '<div class="empty-state">No history yet.</div>';
}

async function loadThresholds() {
  const section = document.getElementById('fp-thresholds-section');
  const box = document.getElementById('fp-thresholds');
  if (!section || !box || profile?.role !== 'admin' || isDemoMode() || !isSupabaseConfigured()) return;
  const { data: isAdmin } = await getSupabase().rpc('is_admin');
  if (!isAdmin) return;
  section.style.display = '';
  const { data, error } = await getSupabase()
    .from('fair_play_thresholds')
    .select('kind,key,level,reject_spq,flag_spq,max_correct,enabled');
  box.innerHTML = error ? `<div class="error-state">${escapeHtml(error.message)}</div>` : renderThresholdsHtml(data || []);
}

async function saveThreshold(row) {
  const get = (n) => row.querySelector(`[name="${n}"]`);
  const { error } = await getSupabase().rpc('fair_play_threshold_save', {
    p_kind: row.dataset.kind,
    p_key: row.dataset.key,
    p_level: row.dataset.level,
    p_reject_spq: parseNum(get('reject_spq')?.value),
    p_flag_spq: parseNum(get('flag_spq')?.value),
    p_max_correct: parseNum(get('max_correct')?.value),
    p_enabled: Boolean(get('enabled')?.checked),
    p_note: null,
  });
  showToast(error ? 'error' : 'success', error ? error.message : 'Threshold saved. New results use it within a minute.');
}

async function initFairPlayPage() {
  profile = await requireAuth(['teacher', 'admin', 'centre_head', 'vice_centre_head']);
  if (!profile) return;
  if (profile.role === 'admin') setupAdminNav(profile);

  document.getElementById('fp-status-filter')?.addEventListener('change', loadQueue);
  document.getElementById('fp-refresh')?.addEventListener('click', loadQueue);
  document.getElementById('fp-queue')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.fpDecide) decide(btn.dataset.id, btn.dataset.fpDecide);
    else if (btn.dataset.fpHistory) showHistory(btn.dataset.fpHistory);
  });
  document.getElementById('fp-thresholds')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fp-save-threshold]');
    if (btn) saveThreshold(btn.closest('tr'));
  });
  const overlay = document.getElementById('fp-history-overlay');
  document.getElementById('fp-history-close')?.addEventListener('click', () => {
    if (overlay) overlay.style.display = 'none';
  });
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });

  await Promise.all([loadQueue(), loadThresholds()]);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initFairPlayPage);
}
