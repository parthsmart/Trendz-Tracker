/**
 * Trendz Tracker — Simple page controller (js/simplePracticePage.js)
 *
 * /pages/simple.html: no-formula sums (1D 4R, 2D 2R, 3D 2R), tables dodging
 * (2 to 9) and advanced mixed tables (2–5, 2–9).
 * - Practice online: one question at a time, Enter checks it, the score is
 *   saved when the student finishes.
 * - Log offline score: correct, questions, optional time and date (last 7 days).
 * The activities shown follow the student's practice access (simple_practice key).
 */

import { requireAuth } from './guard.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { fetchStudentEffectiveAccess } from './studentAccess.js';
import { formatSecondsToMMSS, parseTimeToSeconds } from './timeUtils.js';
import { showToast } from './toast.js';
import {
  SIMPLE_GROUPS,
  SIMPLE_LIMITS,
  SIMPLE_QUESTION_COUNTS,
  SIMPLE_DEFAULT_QUESTIONS,
  allowedSimpleActivities,
  bestSimpleByActivity,
  checkSimpleAnswer,
  formatSimpleQuestion,
  generateSimplePracticeQuestion,
  getSimpleActivity,
  parseSimpleAnswer,
  simpleActivityLabel,
} from './simplePractice.js';
import {
  deleteSimpleResult,
  fetchSimpleToday,
  listSimpleResults,
  saveSimpleResult,
} from './simplePracticeData.js';

const STORAGE_KEY = 'trendz_simple_practice_choice_v1';
const FEEDBACK_MS = 450;

const state = {
  profile: null,
  supabase: null,
  isDemo: false,
  rule: null,
  activities: [],
  activityKey: null,
  count: SIMPLE_DEFAULT_QUESTIONS,
  today: null,
  rows: [],
  run: null,
  tab: 'online',
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clock(seconds) {
  return formatSecondsToMMSS(Math.max(0, Math.round(seconds))) || '0:00';
}

/* ------------------------------------------------------------- choices */

function loadChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && state.activities.some((a) => a.key === saved.activityKey)) state.activityKey = saved.activityKey;
    if (saved && SIMPLE_QUESTION_COUNTS.includes(saved.count)) state.count = saved.count;
  } catch {
    // ignore
  }
  if (!state.activityKey) state.activityKey = state.activities[0]?.key || null;
}

function saveChoice() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activityKey: state.activityKey, count: state.count }));
  } catch {
    // ignore
  }
}

function renderActivityGroups() {
  const html = SIMPLE_GROUPS.map((group) => {
    const items = state.activities.filter((a) => a.group === group.key);
    if (items.length === 0) return '';
    const chips = items
      .map(
        (a) => `
          <label class="simple-chip">
            <input type="radio" name="simple-activity" value="${escapeHtml(a.key)}" ${a.key === state.activityKey ? 'checked' : ''} />
            <span>${escapeHtml(a.group === 'tables' ? String(a.from) : a.label)}</span>
          </label>`
      )
      .join('');
    return `
      <div class="simple-group" role="radiogroup" aria-label="${escapeHtml(group.label)}">
        <span class="simple-label">${escapeHtml(group.label)}</span>
        <p class="simple-group-hint">${escapeHtml(group.hint)}</p>
        <div class="simple-chips">${chips}</div>
      </div>`;
  }).join('');
  $('simple-activity-groups').innerHTML = html;
}

function renderCountChoices() {
  $('simple-count-choices').innerHTML = SIMPLE_QUESTION_COUNTS.map(
    (n) => `
      <label class="simple-chip">
        <input type="radio" name="simple-count" value="${n}" ${n === state.count ? 'checked' : ''} />
        <span>${n}</span>
      </label>`
  ).join('');
}

function setTab(tab) {
  if (state.run && !state.run.done && tab !== 'online') return;
  state.tab = tab;
  $('tab-online').setAttribute('aria-selected', String(tab === 'online'));
  $('tab-offline').setAttribute('aria-selected', String(tab === 'offline'));
  $('panel-online').hidden = tab !== 'online';
  $('panel-offline').hidden = tab !== 'offline';
  $('simple-stage').style.display = tab === 'online' ? '' : 'none';
  if (tab === 'offline') {
    $('offline-date').value = $('offline-date').value || state.today;
    $('offline-correct').focus();
  }
}

/* -------------------------------------------------------------- online */

function showStage(name) {
  $('stage-idle').hidden = name !== 'idle';
  $('stage-play').hidden = name !== 'play';
  $('stage-result').hidden = name !== 'result';
}

function setPickerDisabled(disabled) {
  document
    .querySelectorAll('input[name="simple-activity"], input[name="simple-count"], #btn-simple-start, #tab-offline')
    .forEach((el) => {
      el.disabled = disabled;
    });
}

function renderQuestion() {
  const run = state.run;
  const q = run.question;
  const el = $('play-question');
  if (q.kind === 'sum') {
    el.className = 'simple-question num is-sum';
    el.innerHTML = q.numbers
      .map((n) => `<div class="${n < 0 ? 'is-minus' : ''}">${n < 0 ? '−' : ''}${Math.abs(n)}</div>`)
      .join('');
    el.setAttribute('aria-label', formatSimpleQuestion(q));
  } else {
    el.className = 'simple-question num';
    el.textContent = `${q.a} × ${q.b}`;
    el.removeAttribute('aria-label');
  }
  $('play-progress').textContent = `${run.index + 1} / ${run.total}`;
  $('play-answer').value = '';
  $('play-answer').focus();
}

function tickClock() {
  if (!state.run || state.run.done) return;
  $('play-clock').textContent = clock((performance.now() - state.run.startedAt) / 1000);
}

function startRun() {
  const activity = getSimpleActivity(state.activityKey);
  if (!activity) {
    showToast('error', 'Choose a practice first.');
    return;
  }
  saveChoice();
  const first = generateSimplePracticeQuestion(activity);
  state.run = {
    activity,
    total: state.count,
    index: 0,
    correct: 0,
    wrong: [],
    question: first,
    startedAt: performance.now(),
    timer: setInterval(tickClock, 250),
    locked: false,
    done: false,
  };
  $('play-title').textContent = simpleActivityLabel(activity.key);
  $('play-feedback').textContent = '';
  $('play-feedback').className = 'simple-feedback';
  $('play-clock').textContent = '0:00';
  setPickerDisabled(true);
  showStage('play');
  renderQuestion();
}

function answerCurrent(raw, skipped = false) {
  const run = state.run;
  if (!run || run.done || run.locked) return;
  if (!skipped && parseSimpleAnswer(raw) === null) {
    $('play-feedback').className = 'simple-feedback is-wrong';
    $('play-feedback').textContent = 'Type a number.';
    return;
  }
  const right = !skipped && checkSimpleAnswer(run.question, raw);
  if (right) run.correct += 1;
  else run.wrong.push({ question: run.question, given: skipped ? 'skipped' : String(raw).trim() });

  const fb = $('play-feedback');
  fb.className = `simple-feedback ${right ? 'is-right' : 'is-wrong'}`;
  fb.textContent = right ? 'Correct' : `Answer: ${run.question.answer}`;

  run.locked = true;
  setTimeout(() => {
    run.locked = false;
    if (run.done) return;
    run.index += 1;
    if (run.index >= run.total) {
      finishRun();
      return;
    }
    run.question = generateSimplePracticeQuestion(run.activity, { previous: run.question });
    fb.textContent = '';
    renderQuestion();
  }, right ? FEEDBACK_MS : FEEDBACK_MS * 2.5);
}

async function finishRun() {
  const run = state.run;
  if (!run || run.done) return;
  run.done = true;
  clearInterval(run.timer);
  const seconds = Math.round((performance.now() - run.startedAt) / 1000);
  const answered = run.index >= run.total ? run.total : run.index;

  setPickerDisabled(false);
  showStage('result');
  $('result-title').textContent = simpleActivityLabel(run.activity.key);
  $('result-correct').textContent = String(run.correct);
  $('result-total').textContent = String(answered);
  $('result-accuracy').textContent = answered ? `${Math.round((run.correct / answered) * 100)}%` : '–';
  $('result-time').textContent = clock(seconds);

  const wrong = run.wrong.slice(0, 100);
  $('result-review-wrap').hidden = wrong.length === 0;
  $('result-review').innerHTML = wrong
    .map(
      (w) =>
        `<li><span class="num">${escapeHtml(formatSimpleQuestion(w.question))} = ${w.question.answer}</span> <span style="color: var(--text-muted);">(you: ${escapeHtml(w.given)})</span></li>`
    )
    .join('');

  if (answered === 0) {
    $('result-saved').textContent = 'No questions answered, so nothing was saved.';
    return;
  }
  $('result-saved').textContent = 'Saving your score...';
  try {
    await saveSimpleResult(
      state.profile.id,
      {
        activity_key: run.activity.key,
        source: 'online',
        correct: run.correct,
        total: answered,
        time_seconds: seconds,
        practiced_on: state.today,
      },
      { supabase: state.supabase, isDemo: state.isDemo, todayIST: state.today, rule: state.rule }
    );
    $('result-saved').textContent = 'This score was saved to My Simple scores.';
    await refreshHistory();
  } catch (err) {
    $('result-saved').textContent = `Could not save this score: ${err.message}`;
  }
}

/* ------------------------------------------------------------- offline */

async function saveOffline(event) {
  event.preventDefault();
  const errorEl = $('offline-error');
  errorEl.style.display = 'none';
  const timeRaw = $('offline-time').value.trim();
  let time = null;
  if (timeRaw) {
    time = parseTimeToSeconds(timeRaw);
    if (time === null) {
      errorEl.textContent = 'Write the time as mm:ss, for example 2:30.';
      errorEl.style.display = 'block';
      return;
    }
  }
  const btn = $('btn-offline-save');
  btn.disabled = true;
  try {
    await saveSimpleResult(
      state.profile.id,
      {
        activity_key: state.activityKey,
        source: 'offline',
        correct: $('offline-correct').value === '' ? NaN : Number($('offline-correct').value),
        total: $('offline-total').value === '' ? NaN : Number($('offline-total').value),
        time_seconds: time,
        practiced_on: $('offline-date').value || state.today,
      },
      { supabase: state.supabase, isDemo: state.isDemo, todayIST: state.today, rule: state.rule }
    );
    showToast('success', `${simpleActivityLabel(state.activityKey)} score saved.`);
    $('offline-correct').value = '';
    $('offline-total').value = '';
    $('offline-time').value = '';
    saveChoice();
    await refreshHistory();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------- history */

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function minBackdate() {
  const d = new Date(`${state.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - SIMPLE_LIMITS.backdateDays);
  return d.toISOString().slice(0, 10);
}

function renderHistory() {
  const rows = state.rows;
  const best = bestSimpleByActivity(rows);
  const bestHtml = state.activities
    .filter((a) => best.has(a.key))
    .map((a) => {
      const r = best.get(a.key);
      const pct = Math.round((Number(r.correct) / Number(r.total)) * 100);
      return `<div><strong>${escapeHtml(simpleActivityLabel(a.key))}</strong><span class="num">${r.correct}/${r.total} · ${pct}%${r.time_seconds !== null && r.time_seconds !== undefined ? ` · ${clock(r.time_seconds)}` : ''}</span></div>`;
    })
    .join('');
  $('simple-best').innerHTML = bestHtml
    ? `<div style="grid-column: 1 / -1; border: 0; padding: 0;"><span class="simple-label">Best scores</span></div>${bestHtml}`
    : '';

  if (rows.length === 0) {
    $('simple-history').innerHTML =
      '<p style="color: var(--text-muted); margin: 0;">No Simple scores yet. Practise online or log a paper score to see it here.</p>';
    return;
  }
  const oldest = minBackdate();
  const body = rows
    .slice(0, 50)
    .map((r) => {
      const pct = Math.round((Number(r.correct) / Number(r.total)) * 100);
      const canDelete = r.source === 'offline' && String(r.practiced_on || '') >= oldest;
      return `
        <tr>
          <td>${escapeHtml(formatDate(r.practiced_on || r.created_at))}</td>
          <td>${escapeHtml(simpleActivityLabel(r.activity_key))}</td>
          <td><span class="badge ${r.source === 'online' ? 'badge-role' : 'badge-neutral'}">${r.source === 'online' ? 'Online' : 'Offline'}</span></td>
          <td class="num">${r.correct}/${r.total} · ${pct}%</td>
          <td class="num">${r.time_seconds !== null && r.time_seconds !== undefined ? clock(r.time_seconds) : '–'}</td>
          <td>${canDelete ? `<button type="button" class="btn btn-ghost btn-xs" data-delete-id="${escapeHtml(r.id)}" aria-label="Delete this offline score">Delete</button>` : ''}</td>
        </tr>`;
    })
    .join('');
  $('simple-history').innerHTML = `
    <div style="overflow-x: auto;">
      <table class="simple-history-table">
        <thead><tr><th>Date</th><th>Practice</th><th>Type</th><th>Score</th><th>Time</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

async function refreshHistory() {
  try {
    state.rows = await listSimpleResults(state.profile.id, { supabase: state.supabase, isDemo: state.isDemo });
  } catch (err) {
    $('simple-history').innerHTML = `<p class="banner banner-error" role="alert">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderHistory();
}

/* ---------------------------------------------------------------- init */

function wireEvents() {
  $('simple-activity-groups').addEventListener('change', (e) => {
    if (e.target.name === 'simple-activity') {
      state.activityKey = e.target.value;
      saveChoice();
    }
  });
  $('simple-count-choices').addEventListener('change', (e) => {
    if (e.target.name === 'simple-count') {
      state.count = Number(e.target.value);
      saveChoice();
    }
  });
  $('tab-online').addEventListener('click', () => setTab('online'));
  $('tab-offline').addEventListener('click', () => setTab('offline'));
  $('btn-simple-start').addEventListener('click', startRun);
  $('play-form').addEventListener('submit', (e) => {
    e.preventDefault();
    answerCurrent($('play-answer').value);
  });
  $('btn-play-skip').addEventListener('click', () => answerCurrent('', true));
  $('btn-play-finish').addEventListener('click', () => {
    if (window.confirm('Finish now? Only the questions you answered will count.')) finishRun();
  });
  $('btn-result-again').addEventListener('click', startRun);
  $('btn-result-change').addEventListener('click', () => {
    showStage('idle');
    document.querySelector('input[name="simple-activity"]:checked')?.focus();
  });
  $('panel-offline').addEventListener('submit', saveOffline);
  $('simple-history').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-id]');
    if (!btn) return;
    if (!window.confirm('Delete this offline score?')) return;
    try {
      await deleteSimpleResult(state.profile.id, btn.dataset.deleteId, { supabase: state.supabase, isDemo: state.isDemo });
      await refreshHistory();
    } catch (err) {
      showToast('error', err.message);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.run && !state.run.done) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function renderHeaderUser(profile) {
  const container = $('user-pill-container');
  if (container) container.style.display = 'flex';
  if ($('header-user-name')) $('header-user-name').textContent = profile.full_name || 'Student';
  if ($('header-user-code')) $('header-user-code').textContent = profile.student_code || 'STU';
  $('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

function showUnavailable(text) {
  $('simple-loading').style.display = 'none';
  $('simple-main').style.display = 'none';
  $('simple-unavailable').style.display = 'block';
  if (text) $('simple-unavailable-text').textContent = text;
}

async function loadRule(profile) {
  // Staff can open the page to try every activity.
  if (profile.role !== 'student') return null;
  const res = await fetchStudentEffectiveAccess(profile.id, { supabase: state.supabase, isDemo: state.isDemo, DemoDB });
  if (!res?.ok) throw new Error(res?.error || 'Could not load your practice access.');
  return res.settings?.simple_practice ?? null;
}

async function initSimplePractice() {
  const profile = await requireAuth(['student', 'admin', 'teacher']);
  if (!profile) return;
  state.profile = profile;
  state.isDemo = isDemoMode();
  state.supabase = !state.isDemo && isSupabaseConfigured() ? await getSupabase() : null;
  renderHeaderUser(profile);

  try {
    state.rule = await loadRule(profile);
  } catch (err) {
    showUnavailable(`${err.message} Please refresh the page.`);
    return;
  }
  state.activities = allowedSimpleActivities(state.rule);
  if (state.activities.length === 0) {
    showUnavailable();
    return;
  }

  state.today = await fetchSimpleToday({ supabase: state.supabase, isDemo: state.isDemo });
  $('offline-date').max = state.today;
  $('offline-date').min = minBackdate();
  $('offline-date').value = state.today;

  loadChoice();
  renderActivityGroups();
  renderCountChoices();
  wireEvents();
  showStage('idle');

  $('simple-loading').style.display = 'none';
  $('simple-main').style.display = '';
  await refreshHistory();
}

if (typeof document !== 'undefined' && document.getElementById('simple-main')) {
  initSimplePractice();
}
