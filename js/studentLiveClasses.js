/**
 * Trendz Tracker - Student Live Classes page (js/studentLiveClasses.js)
 *
 * Lists the classes a student may attend (get_eligible_live_classes_for_student):
 * Happening now, Upcoming by day with countdowns and calendar files, and Past classes.
 * Refetches every 30 seconds and when the tab becomes visible again, so a class that
 * goes live shows up without reloading.
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import {
  groupClasses,
  canJoin,
  countdownLabel,
  dayLabel,
  timeLabel,
  buildIcs,
  JOIN_OPENS_BEFORE_MIN,
} from './studentLiveClassesView.js';

const REFRESH_MS = 30 * 1000;
const PAST_PREVIEW = 5;

let studentId = null;
let classes = [];
let showAllPast = false;
let loadedOnce = false;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function roomUrl(cls) {
  return `/pages/live-room.html?classId=${encodeURIComponent(cls.id)}`;
}

const PILL = {
  live: 'Live now',
  starting: 'Starting',
  soon: 'Starting soon',
  upcoming: 'Upcoming',
  past: 'Ended',
};

function pillFor(item) {
  if (item.state === 'past' && item.status !== 'ended' && item.provider_status !== 'completed') {
    return `<span class="slc-pill past">Didn't go live</span>`;
  }
  return `<span class="slc-pill ${item.state}">${PILL[item.state]}</span>`;
}

function actionsFor(item, now) {
  if (canJoin(item.state)) {
    const note = item.state === 'starting'
      ? 'Teacher is getting ready'
      : item.state === 'soon' ? `Starts ${countdownLabel(item.startAt, now)}` : '';
    return `
      <a class="btn ${item.state === 'live' ? 'btn-primary' : 'btn-outline'} btn-sm" href="${roomUrl(item)}">Join class →</a>
      ${note ? `<span class="slc-note">${esc(note)}</span>` : ''}`;
  }
  if (item.state === 'upcoming') {
    const countdown = item.startAt ? countdownLabel(item.startAt, now) : '';
    return `
      ${countdown ? `<span class="slc-note"><b>Starts ${esc(countdown)}</b><br>Join opens ${JOIN_OPENS_BEFORE_MIN} min before</span>` : ''}
      ${item.startAt ? `<button type="button" class="slc-link" data-ics="${esc(item.id)}">+ Add to calendar</button>` : ''}`;
  }
  return '';
}

function cardHtml(item, now, { showDay = false } = {}) {
  const when = item.startAt
    ? `<b>${esc(timeLabel(item.startAt))}</b><span>${esc(showDay ? dayLabel(item.startAt, now) : `${item.duration_minutes || 60} min`)}</span>`
    : '<b>TBA</b><span>&nbsp;</span>';
  return `
    <article class="slc-card is-${item.state}">
      <div class="slc-time">${when}</div>
      <div class="slc-body">
        ${pillFor(item)}
        <h3>${esc(item.title || 'Abacus live class')}</h3>
        <div class="slc-meta">
          <span>Teacher: <strong>${esc(item.teacher_name || 'Your teacher')}</strong></span>
          <span>${esc(item.duration_minutes || 60)} min</span>
          ${item.target_level ? `<span>Level ${esc(item.target_level)}</span>` : ''}
        </div>
      </div>
      <div class="slc-actions">${actionsFor(item, now)}</div>
    </article>`;
}

function render() {
  const now = Date.now();
  const { live, upcoming, past, next } = groupClasses(classes, now);
  const weekEnd = now + 7 * 24 * 60 * 60 * 1000;
  const upcomingCount = upcoming.reduce((n, day) => n + day.classes.length, 0);

  document.getElementById('slc-stat-live').textContent = String(live.length);
  document.getElementById('slc-stat-week').textContent = String(
    upcoming.flatMap((day) => day.classes).filter((c) => c.startAt && c.startAt <= weekEnd).length
  );
  document.getElementById('slc-stat-next').textContent = next?.startAt
    ? `${dayLabel(next.startAt, now)}, ${timeLabel(next.startAt)}`
    : '—';

  document.getElementById('slc-live-count').textContent = String(live.length);
  document.getElementById('slc-live').innerHTML = live.length
    ? live.map((item) => cardHtml(item, now)).join('')
    : `<div class="slc-empty">No class is running right now.${next?.startAt ? ` Your next class starts ${esc(countdownLabel(next.startAt, now))}.` : ''}</div>`;

  document.getElementById('slc-upcoming-count').textContent = String(upcomingCount);
  document.getElementById('slc-upcoming').innerHTML = upcoming.length
    ? upcoming.map((day) => `
        <h3 class="slc-day">${esc(day.label)}</h3>
        <div class="slc-list">${day.classes.map((item) => cardHtml(item, now)).join('')}</div>`).join('')
    : '<div class="slc-empty">No classes scheduled yet. New classes from your teacher will show up here.</div>';

  const shownPast = showAllPast ? past : past.slice(0, PAST_PREVIEW);
  document.getElementById('slc-past-count').textContent = String(past.length);
  document.getElementById('slc-past').innerHTML = past.length
    ? shownPast.map((item) => cardHtml(item, now, { showDay: true })).join('')
    : '<div class="slc-empty">Classes you\'ve had will be listed here.</div>';
  const more = document.getElementById('slc-past-more');
  more.hidden = past.length <= PAST_PREVIEW;
  more.textContent = showAllPast ? 'Show fewer' : `Show all ${past.length} past classes`;
}

async function fetchClasses() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('get_eligible_live_classes_for_student', { p_student_id: studentId });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }
  if (isDemoMode() && DemoDB?.getEligibleLiveClassesForStudent) {
    return DemoDB.getEligibleLiveClassesForStudent(studentId) || [];
  }
  return [];
}

async function load() {
  const errorBox = document.getElementById('slc-error');
  try {
    classes = await fetchClasses();
    errorBox.style.display = 'none';
    loadedOnce = true;
  } catch (err) {
    console.warn('Could not load live classes:', err);
    if (!loadedOnce) {
      errorBox.textContent = 'Could not load your live classes. Check your connection and press Refresh.';
      errorBox.style.display = 'block';
    }
  }
  document.getElementById('slc-loading').hidden = true;
  document.getElementById('slc-loading').style.display = 'none';
  document.getElementById('slc-content').hidden = !loadedOnce;
  if (loadedOnce) render();
}

function downloadIcs(id) {
  const cls = classes.find((c) => String(c.id) === id);
  if (!cls) return;
  const ics = buildIcs(cls, new URL(roomUrl(cls), window.location.origin).href);
  if (!ics) return;
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(cls.title || 'live-class').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  const profile = await requireAuth(['student']);
  if (!profile) return;
  studentId = profile.id;
  const pill = document.getElementById('user-pill-container');
  if (pill) pill.style.display = 'flex';

  document.getElementById('btn-refresh-live').addEventListener('click', load);
  document.getElementById('slc-past-more').addEventListener('click', () => {
    showAllPast = !showAllPast;
    render();
  });
  document.getElementById('slc-content').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ics]');
    if (btn) downloadIcs(btn.dataset.ics);
  });

  await load();
  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
}

init();
