/**
 * Trendz Tracker - student profile page (js/profile.js)
 *
 * Students see their own profile: photo (upload / remove), motto and favourite practice,
 * XP tier, badge wall (locked badges greyed out), titles (Star of the Month, Champion of
 * the Week), personal bests, daily challenge record and a weekly summary they can share
 * with parents (copy, WhatsApp, print).
 * Teachers and admins open `?student=<id>` for a read-only view and may remove a photo.
 * All numbers come from the `my_profile` RPC.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { callXpRpc, ensureXpStyles, formatXp, tierProgress, tierIcon } from './xpRewards.js';
import { getSupabase } from './supabaseClient.js';
import {
  avatarInitial,
  ensureAvatarStyles,
  removeAvatar,
  signAvatarUrl,
  uploadAvatar,
} from './avatars.js';
import {
  FAVOURITE_LABELS,
  MOTTO_MAX,
  badgeCounts,
  buildBadgeWallHtml,
  buildBestsHtml,
  buildChallengeHistoryHtml,
  buildParentSummaryText,
  buildStatsHtml,
  buildTitlesHtml,
  shortDate,
  whatsappShareUrl,
} from './profileView.js';

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? '';
}

let state = { viewer: null, data: null, targetId: null };

function showError(message) {
  $('pf-loading').hidden = true;
  $('pf-content').hidden = true;
  $('pf-error').hidden = false;
  setText('pf-error-text', message);
}

async function renderAvatar(path, name) {
  const el = $('pf-avatar');
  if (!el) return;
  el.textContent = avatarInitial(name);
  el.classList.remove('has-photo');
  const url = path ? await signAvatarUrl(path) : null;
  if (url) {
    el.textContent = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
    el.classList.add('has-photo');
  }
  const removeBtn = $('pf-photo-remove');
  if (removeBtn) removeBtn.hidden = !path;
  setText('pf-upload-text', path ? 'Change photo' : 'Add photo');
}

function render(data) {
  state.data = data;
  const p = data.profile || {};
  const own = Boolean(data.can_edit);
  const name = p.full_name || 'Student';

  setText('pf-eyebrow', own ? 'My profile' : 'Student profile');
  setText('pf-name', name);
  document.title = `${own ? 'My profile' : name} - Trendz Tracker`;
  setText('pf-code', p.student_code || '—');
  setText('pf-level', p.level || '—');

  const motto = $('pf-motto');
  if (motto) {
    motto.hidden = !p.motto;
    motto.textContent = p.motto ? `“${p.motto}”` : '';
  }
  const fav = FAVOURITE_LABELS[p.favourite_practice];
  $('pf-fav-fact').hidden = !fav;
  setText('pf-fav', fav || '');
  const joined = shortDate(p.joined, true);
  $('pf-joined-fact').hidden = !joined;
  setText('pf-joined', joined);

  const tp = tierProgress(data.total_xp, data.tier);
  setText('pf-tier-icon', tp.icon);
  setText('pf-tier', `${tp.name} · ${formatXp(data.total_xp)} XP`);
  setText('pf-tier-next', tp.nextName ? `${formatXp(tp.toNext)} XP to ${tierIcon(tp.nextName)} ${tp.nextName}` : 'Top tier reached');
  const bar = $('pf-tier-bar');
  if (bar) {
    bar.setAttribute('aria-valuenow', String(tp.pct));
    bar.firstElementChild.style.width = `${tp.pct}%`;
  }

  $('pf-titles').innerHTML = buildTitlesHtml(data.awards);
  $('pf-stats').innerHTML = buildStatsHtml(data);
  $('pf-badges').innerHTML = buildBadgeWallHtml(data.badges);
  const bc = badgeCounts(data.badges);
  setText('pf-badges-count', `${bc.earned} of ${bc.total} earned`);
  $('pf-bests').innerHTML = buildBestsHtml(data.bests);
  $('pf-challenge').innerHTML = buildChallengeHistoryHtml(data.challenge);
  setText('pf-challenge-count', `${formatXp(data.challenge?.played)} played`);

  const summary = buildParentSummaryText(data);
  setText('pf-parent-text', summary);
  setText('pf-parent-range', `${shortDate(data.week?.from)} – ${shortDate(data.week?.to, true)}`);
  $('pf-parent-whatsapp').href = whatsappShareUrl(summary);

  $('pf-photo-actions').hidden = !(own || data.can_moderate);
  $('pf-upload-label').hidden = !own;
  $('pf-edit').hidden = !own;
  if (own) {
    $('pf-motto-input').value = p.motto || '';
    $('pf-fav-input').value = p.favourite_practice || '';
    updateMottoCount();
  }

  renderAvatar(p.avatar_path, name);
  $('pf-loading').hidden = true;
  $('pf-error').hidden = true;
  $('pf-content').hidden = false;
}

function updateMottoCount() {
  const len = ($('pf-motto-input')?.value || '').length;
  setText('pf-motto-count', `${len}/${MOTTO_MAX}`);
}

async function load() {
  const data = await callXpRpc('my_profile', { p_student: state.targetId });
  if (!data || !data.profile) {
    showError(
      state.targetId
        ? 'This profile could not be loaded. You may not have access to this student.'
        : 'Your profile could not be loaded right now. Please check your connection and try again.'
    );
    return;
  }
  render(data);
}

function setupActions() {
  $('pf-motto-input')?.addEventListener('input', updateMottoCount);

  $('pf-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('pf-edit-save');
    btn.disabled = true;
    try {
      const supabase = await getSupabase();
      if (!supabase) throw new Error('offline');
      const { error } = await supabase.rpc('set_my_profile', {
        p_motto: $('pf-motto-input').value.trim().slice(0, MOTTO_MAX) || null,
        p_favourite: $('pf-fav-input').value || null,
      });
      if (error) throw error;
      showToast('success', 'Profile saved');
      await load();
    } catch {
      showToast('error', 'Could not save your profile. Please try again.');
    } finally {
      btn.disabled = false;
    }
  });

  $('pf-photo-input')?.addEventListener('change', async (e) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !state.viewer) return;
    const label = $('pf-upload-label');
    label.classList.add('is-busy');
    setText('pf-upload-text', 'Uploading…');
    try {
      const { path } = await uploadAvatar(file, state.viewer.id);
      showToast('success', 'Photo updated');
      state.data.profile.avatar_path = path;
      await renderAvatar(path, state.data.profile.full_name);
    } catch (err) {
      showToast('error', err?.message || 'The photo could not be uploaded.');
      await renderAvatar(state.data?.profile?.avatar_path, state.data?.profile?.full_name);
    } finally {
      label.classList.remove('is-busy');
    }
  });

  $('pf-photo-remove')?.addEventListener('click', async () => {
    const own = Boolean(state.data?.can_edit);
    const ok = window.confirm(own ? 'Remove your profile photo?' : 'Remove this student’s profile photo?');
    if (!ok) return;
    try {
      await removeAvatar(own ? null : state.targetId);
      state.data.profile.avatar_path = null;
      await renderAvatar(null, state.data.profile.full_name);
      showToast('success', 'Photo removed');
    } catch (err) {
      showToast('error', err?.message || 'The photo could not be removed.');
    }
  });

  $('pf-parent-copy')?.addEventListener('click', async () => {
    const text = $('pf-parent-text').textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', 'Summary copied');
    } catch {
      showToast('error', 'Copy is not available here. Select the text and copy it.');
    }
  });

  $('pf-parent-print')?.addEventListener('click', () => {
    document.body.classList.add('pf-printing');
    window.print();
    setTimeout(() => document.body.classList.remove('pf-printing'), 500);
  });
}

async function initProfilePage() {
  const viewer = await requireAuth(['student', 'teacher', 'admin']);
  if (!viewer) return;
  state.viewer = viewer;
  const requested = new URLSearchParams(window.location.search).get('student');
  if (viewer.role === 'student') {
    state.targetId = null;
  } else if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
    state.targetId = requested;
  } else {
    showError('Open a student’s profile from their student page.');
    return;
  }
  ensureXpStyles(document);
  ensureAvatarStyles(document);
  setupActions();
  await load();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initProfilePage);
}
