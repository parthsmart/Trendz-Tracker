/**
 * Trendz Tracker - student Friends page (js/friends.js)
 *
 * Friends (both students say yes, then a teacher approves), challenges through the
 * existing duel routes, the positive class feed with preset reactions, my own
 * moments (hide / stop sharing), block and report. No free text anywhere.
 * Every rule is enforced by the database (social migration); this page only asks.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { avatarHtml, ensureAvatarStyles } from './avatars.js';
import { avatarMap, drillApi, socialRpc } from './socialApi.js';
import {
  REPORT_REASONS,
  ensureSocialStyles,
  esc,
  feedItemHtml,
  feedItemText,
  filterClassmates,
  requestLabel,
  socialMessage,
  splitRequests,
  timeAgo,
} from './socialView.js';

const $ = (id) => document.getElementById(id);
const state = { home: null, scope: 'level', urls: new Map(), report: null, query: '' };

function fail(res) {
  if (res.error) { showToast('error', res.error); return true; }
  if (res.data && res.data.ok === false) { showToast('error', socialMessage(res.data.code)); return true; }
  return false;
}

function person(p, sub = '') {
  const url = p.avatar_path ? state.urls.get(p.avatar_path) : null;
  return `${avatarHtml(url || null, p.name, 32)}<span class="sc-name">${esc(p.name)}${sub ? `<span class="sc-sub">${esc(sub)}</span>` : ''}</span>`;
}

function renderHome() {
  const h = state.home;
  const off = $('sc-off');
  off.hidden = h.enabled.friends;
  off.innerHTML = h.enabled.friends ? '' : '<p class="sc-empty">Friends are switched off at your centre right now.</p>';

  const { incoming, waiting } = splitRequests(h.requests);
  $('sc-requests-card').hidden = !(incoming.length || waiting.length);
  $('sc-requests').innerHTML = [...incoming, ...waiting].map((r) => `<div class="sc-row">${person(r, requestLabel(r))}
    <span class="sc-actions">${r.direction === 'in' && r.status === 'pending_student'
      ? `<button type="button" class="btn btn-primary btn-sm" data-accept="${esc(r.id)}">Accept</button>
         <button type="button" class="btn btn-outline btn-sm" data-decline="${esc(r.id)}">No thanks</button>
         <button type="button" class="sc-link" data-report="${esc(r.other_id)}" data-context="friend_request" data-context-id="${esc(r.id)}">Report</button>`
      : r.direction === 'out' ? `<button type="button" class="btn btn-outline btn-sm" data-cancel="${esc(r.id)}">Cancel</button>` : ''}</span></div>`).join('');

  $('sc-friends').innerHTML = h.friends.length
    ? h.friends.map((f) => `<div class="sc-row">${person(f, f.level || '')}
      <span class="sc-actions">${f.same_level
        ? `<button type="button" class="btn btn-primary btn-sm" data-live="${esc(f.id)}" title="Race now, if they are online">⚡ Live</button>
           <button type="button" class="btn btn-outline btn-sm" data-duel="${esc(f.id)}" title="They play when they are ready">⏳ Duel</button>`
        : '<span class="sc-sub">Different level: no duels</span>'}
        <button type="button" class="sc-link" data-unfriend="${esc(f.id)}">Unfriend</button>
        <button type="button" class="sc-link" data-block="${esc(f.id)}">Block</button></span></div>`).join('')
    : '<p class="sc-empty">No friends yet. Add a classmate below.</p>';

  renderClassmates();

  $('sc-auto-post').checked = h.auto_post !== false;
  $('sc-mine').innerHTML = h.my_events.length
    ? h.my_events.map((e) => {
      const { icon, text } = feedItemText({ ...e, name: 'You' });
      return `<div class="sc-row"><span class="sc-av" aria-hidden="true">${esc(icon)}</span>
        <span class="sc-name">${esc(text)}<span class="sc-sub">${esc(timeAgo(e.created_at))}${e.hidden ? ' · hidden' : ''}</span></span>
        <button type="button" class="btn btn-outline btn-sm" data-hide="${esc(e.id)}" data-hidden="${e.hidden}">${e.hidden ? 'Show' : 'Hide'}</button></div>`;
    }).join('')
    : '<p class="sc-empty">New levels, badges and personal bests show up here.</p>';

  $('sc-blocked-card').hidden = !h.blocked.length;
  $('sc-blocked').innerHTML = h.blocked.map((b) => `<div class="sc-row"><span class="sc-name">${esc(b.name)}</span>
    <button type="button" class="btn btn-outline btn-sm" data-unblock="${esc(b.id)}">Unblock</button></div>`).join('');
}

function renderClassmates() {
  const h = state.home;
  const list = filterClassmates(h.classmates, state.query).slice(0, 30);
  $('sc-classmates').innerHTML = list.length
    ? list.map((c) => `<div class="sc-row">${person(c, c.same_level ? `${c.level} · my level` : c.level || '')}
      <span class="sc-actions"><button type="button" class="btn btn-outline btn-sm" data-add="${esc(c.id)}"${h.enabled.friends ? '' : ' disabled'}>Add friend</button>
      <button type="button" class="sc-link" data-block="${esc(c.id)}">Block</button></span></div>`).join('')
    : `<p class="sc-empty">${state.query ? 'Nobody with that name.' : 'No classmates to add right now.'}</p>`;
}

async function loadHome() {
  const res = await socialRpc('social_home');
  if (res.error || !res.data?.ok) {
    $('sc-friends').innerHTML = `<p class="sc-empty">${esc(res.error || socialMessage(res.data?.code))}</p>`;
    return;
  }
  state.home = res.data;
  const h = state.home;
  state.urls = await avatarMap([...h.friends, ...h.requests, ...h.classmates]);
  renderHome();
}

async function loadFeed() {
  for (const t of document.querySelectorAll('.sc-tab')) t.setAttribute('aria-selected', String(t.dataset.scope === state.scope));
  const res = await socialRpc('social_feed', { p_scope: state.scope, p_before: null, p_limit: 20 });
  const box = $('sc-feed');
  if (res.error || !res.data?.ok) { box.innerHTML = `<li class="sc-empty">${esc(res.error || 'Could not load your class.')}</li>`; return; }
  if (!res.data.enabled) { box.innerHTML = '<li class="sc-empty">The class feed is switched off at your centre.</li>'; return; }
  const items = res.data.items || [];
  const urls = await avatarMap(items);
  box.innerHTML = items.length
    ? items.map((i) => feedItemHtml(i, { reactionsEnabled: res.data.reactions_enabled, avatarUrl: i.avatar_path ? urls.get(i.avatar_path) : null })).join('')
    : `<li class="sc-empty">Nothing yet. When ${state.scope === 'level' ? 'someone at your level' : 'someone at your centre'} levels up or earns a badge, it shows here.</li>`;
}

function openReport(target, context, contextId) {
  state.report = { target, context, contextId };
  $('sc-report-reasons').innerHTML = REPORT_REASONS.map((r) => `<button type="button" class="btn btn-outline btn-sm" data-reason="${r.key}">${esc(r.label)}</button>`).join('');
  $('sc-report-dialog').showModal();
}

async function act(btn, fn, okMessage) {
  btn.disabled = true;
  try {
    const res = await fn();
    if (!fail(res) && okMessage) showToast('success', okMessage);
  } catch (err) {
    showToast('error', err?.message || 'Something went wrong.');
  }
  await Promise.all([loadHome(), loadFeed()]);
}

async function challenge(btn, id, live) {
  btn.disabled = true;
  try {
    if (live) {
      await drillApi({ action: 'live_invite', opponent_id: id });
      showToast('success', 'Challenge sent! They get a pop-up to accept.');
    } else {
      const opts = await socialRpc('duel_options');
      const cat = opts.data?.categories?.[0]?.id;
      if (!cat) throw new Error('No practice types are available for duels yet.');
      await drillApi({ action: 'duel_create', opponent_id: id, category_id: cat });
      showToast('success', 'Duel sent! Play your round on the Duels page.');
    }
  } catch (err) {
    showToast('error', err?.message || 'Something went wrong.');
  }
  btn.disabled = false;
}

function setupActions() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.scope) { state.scope = d.scope; loadFeed(); return; }
    if (d.react) {
      b.disabled = true;
      const res = await socialRpc('social_react', { p_kind: d.kind, p_target: d.target, p_reaction: d.react });
      if (!fail(res)) await loadFeed(); else b.disabled = false;
      return;
    }
    if (d.reason && state.report) {
      const r = state.report; state.report = null;
      $('sc-report-dialog').close();
      const res = await socialRpc('social_report', { p_target: r.target, p_context: r.context, p_context_id: r.contextId, p_reason: d.reason });
      if (!fail(res)) showToast('success', 'Thank you. Your teacher will look at it.');
      return;
    }
    if (d.reportItem) return openReport(d.student, 'feed_item', d.reportItem);
    if (d.report) return openReport(d.report, d.context || 'student', d.contextId || d.report);
    if (d.add) return act(b, () => socialRpc('social_request_friend', { p_to: d.add }), 'Request sent. They say yes, then your teacher approves.');
    if (d.accept) return act(b, () => socialRpc('social_respond_request', { p_id: d.accept, p_accept: true }), 'Great! Now your teacher approves it.');
    if (d.decline) return act(b, () => socialRpc('social_respond_request', { p_id: d.decline, p_accept: false }), 'Request declined.');
    if (d.cancel) return act(b, () => socialRpc('social_cancel_request', { p_id: d.cancel }), 'Request cancelled.');
    if (d.unfriend) {
      if (!window.confirm('Stop being friends? They are not told.')) return;
      return act(b, () => socialRpc('social_unfriend', { p_other: d.unfriend }), 'Done.');
    }
    if (d.block) {
      if (!window.confirm('Block this classmate? They will not see you, challenge you or send you requests. They are not told.')) return;
      return act(b, () => socialRpc('social_block', { p_other: d.block }), 'Blocked.');
    }
    if (d.unblock) return act(b, () => socialRpc('social_unblock', { p_other: d.unblock }), 'Unblocked.');
    if (d.hide) return act(b, () => socialRpc('social_hide_item', { p_id: Number(d.hide), p_hidden: d.hidden !== 'true' }), null);
    if (d.live) return challenge(b, d.live, true);
    if (d.duel) return challenge(b, d.duel, false);
  });
  $('sc-search').addEventListener('input', (e) => { state.query = e.target.value; if (state.home) renderClassmates(); });
  $('sc-auto-post').addEventListener('change', async (e) => {
    const res = await socialRpc('social_set_auto_post', { p_on: e.target.checked });
    if (!fail(res)) showToast('success', e.target.checked ? 'Your moments will be shared with your class.' : 'Your moments stay private.');
  });
}

async function init() {
  const profile = await requireAuth(['student']);
  if (!profile) return;
  ensureAvatarStyles();
  ensureSocialStyles();
  setupActions();
  await Promise.all([loadHome(), loadFeed()]);
}

document.addEventListener('DOMContentLoaded', init);
