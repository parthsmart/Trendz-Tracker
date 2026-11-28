/**
 * Trendz Tracker - staff Community page (js/community.js)
 *
 * Moderation for the child-safe social features: approve or decline friend
 * requests both students already said yes to, handle reports, remove or restore
 * feed items, end friendships, see blocks, and (centre heads) switch friends,
 * feed and reactions on or off for the centre. What each adult sees is decided by
 * social_mod_queue() in the database: teachers their assigned students, heads
 * their centre, owner/director everything.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { socialRpc } from './socialApi.js';
import {
  REPORT_STATUS_LABEL,
  REQUEST_REASON_LABEL,
  ensureSocialStyles,
  esc,
  feedItemText,
  socialMessage,
  timeAgo,
} from './socialView.js';

const $ = (id) => document.getElementById(id);
const CONTEXT_LABEL = { student: 'About a classmate', feed_item: 'Class feed item', reaction: 'A reaction', friend_request: 'Friend request', duel: 'A duel' };
let queue = null;

function rows(list, render, empty) {
  return list.length ? list.map(render).join('') : `<p class="sc-empty">${esc(empty)}</p>`;
}

export function buildCommunityHtml(q, now = Date.now()) {
  const requests = rows(q.requests || [], (r) => `<div class="sc-row"><span class="sc-name">${esc(r.from_name)} &amp; ${esc(r.to_name)}
      <span class="sc-sub">Both said yes · ${esc(timeAgo(r.created_at, now))}</span></span>
      <span class="sc-actions"><button type="button" class="btn btn-primary btn-sm" data-approve="${esc(r.id)}">Approve</button>
      <button type="button" class="btn btn-outline btn-sm" data-reject="${esc(r.id)}">Decline</button></span></div>`,
  'No friend requests waiting.');

  const reports = rows(q.reports || [], (x) => `<div class="sc-row"><span class="sc-name">${esc(x.reporter_name)} reported ${esc(x.target_name)}
      <span class="sc-sub">${esc(REQUEST_REASON_LABEL[x.reason] || x.reason)} · ${esc(CONTEXT_LABEL[x.context] || x.context)} · ${esc(timeAgo(x.created_at, now))} · ${esc(REPORT_STATUS_LABEL[x.status] || x.status)}</span></span>
      <span class="sc-actions">${x.status === 'open'
        ? `<button type="button" class="btn btn-outline btn-sm" data-report-done="${esc(x.id)}" data-action="talked">Talked to them</button>
           <button type="button" class="btn btn-outline btn-sm" data-report-done="${esc(x.id)}" data-action="none">No action needed</button>`
        : `<button type="button" class="sc-link" data-report-open="${esc(x.id)}">Reopen</button>`}</span></div>`,
  'No reports. 🎉');

  const friendships = rows(q.friendships || [], (f) => `<div class="sc-row"><span class="sc-name">${esc(f.a_name)} &amp; ${esc(f.b_name)}
      <span class="sc-sub">Friends since ${esc(timeAgo(f.created_at, now))}${f.approved_by ? ` · approved by ${esc(f.approved_by)}` : ''}</span></span>
      <button type="button" class="btn btn-outline btn-sm" data-end-a="${esc(f.a_id)}" data-end-b="${esc(f.b_id)}">End</button></div>`,
  'No friendships yet.');

  const feed = (q.feed || []).length
    ? q.feed.map((i) => {
      const { icon, text } = feedItemText({ ...i, name: i.student_name });
      const tag = i.removed ? ' · removed' : i.hidden ? ' · hidden by student' : '';
      return `<li class="sc-item"><span class="sc-av" aria-hidden="true">${esc(icon)}</span><div class="sc-body">
        <p class="sc-text"${i.removed ? ' style="text-decoration:line-through"' : ''}>${esc(text)}</p>
        <p class="sc-meta">${esc(timeAgo(i.created_at, now))}${i.level ? ` · ${esc(i.level)}` : ''}${tag}
        <button type="button" class="sc-link" data-remove="${esc(i.id)}" data-removed="${Boolean(i.removed)}">${i.removed ? 'Restore' : 'Remove'}</button></p></div></li>`;
    }).join('')
    : '<li class="sc-empty">Nothing in the feed yet.</li>';

  const blocks = rows(q.blocks || [], (b) => `<div class="sc-row"><span class="sc-name">${esc(b.blocker_name)} blocked ${esc(b.blocked_name)}
      <span class="sc-sub">${esc(timeAgo(b.created_at, now))}</span></span></div>`, 'No blocks.');

  const s = q.settings || {};
  const on = (k) => s[k] !== false;
  const settings = `${[['friends_enabled', 'Friends'], ['feed_enabled', 'Class feed'], ['reactions_enabled', 'Reactions']]
    .map(([k, label]) => `<label class="sc-row"><input type="checkbox" data-setting="${k}"${on(k) ? ' checked' : ''} /> <span class="sc-name">${label}</span></label>`).join('')}
    <p class="sc-safe">Switching one off hides it for every student at this centre. Nothing is deleted.</p>`;

  return { requests, reports, friendships, feed, blocks, settings };
}

async function load() {
  const res = await socialRpc('social_mod_queue', { p_centre: null });
  if (res.error || !res.data) {
    $('cm-requests').innerHTML = `<p class="sc-empty">${esc(res.error || 'Could not load.')}</p>`;
    return;
  }
  queue = res.data;
  const html = buildCommunityHtml(queue);
  $('cm-requests').innerHTML = html.requests;
  $('cm-reports').innerHTML = html.reports;
  $('cm-friendships').innerHTML = html.friendships;
  $('cm-feed').innerHTML = html.feed;
  $('cm-blocks').innerHTML = html.blocks;
  $('cm-settings-card').hidden = !queue.can_settings;
  $('cm-settings').innerHTML = queue.can_settings ? html.settings : '';
}

async function act(btn, call, okMessage) {
  if (btn) btn.disabled = true;
  const res = await call();
  if (res.error) showToast('error', res.error);
  else if (res.data?.ok === false) showToast('error', socialMessage(res.data.code));
  else if (okMessage) showToast('success', okMessage);
  await load();
}

function setupActions() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.approve) return act(b, () => socialRpc('social_decide_request', { p_id: d.approve, p_approve: true }), 'Approved. They are friends now.');
    if (d.reject) return act(b, () => socialRpc('social_decide_request', { p_id: d.reject, p_approve: false }), 'Declined.');
    if (d.reportDone) return act(b, () => socialRpc('social_handle_report', { p_id: Number(d.reportDone), p_status: d.action === 'none' ? 'reviewed' : 'actioned', p_action: d.action }), 'Report closed.');
    if (d.reportOpen) return act(b, () => socialRpc('social_handle_report', { p_id: Number(d.reportOpen), p_status: 'open', p_action: null }), null);
    if (d.remove) return act(b, () => socialRpc('social_remove_item', { p_id: Number(d.remove), p_removed: d.removed !== 'true' }), d.removed === 'true' ? 'Restored.' : 'Removed from the feed.');
    if (d.endA) {
      if (!window.confirm('End this friendship? The students are not told.')) return;
      return act(b, () => socialRpc('social_end_friendship', { p_a: d.endA, p_b: d.endB }), 'Friendship ended.');
    }
  });
  document.addEventListener('change', (e) => {
    const box = e.target.closest('[data-setting]');
    if (!box || !queue?.can_settings) return;
    const get = (k) => document.querySelector(`[data-setting="${k}"]`)?.checked !== false;
    act(null, () => socialRpc('social_update_settings', {
      p_centre: queue.centre_id, p_friends: get('friends_enabled'), p_feed: get('feed_enabled'), p_reactions: get('reactions_enabled'),
    }), 'Saved.');
  });
}

async function init() {
  const profile = await requireAuth(['teacher', 'admin', 'centre_head', 'vice_centre_head']);
  if (!profile) return;
  ensureSocialStyles();
  setupActions();
  await load();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
