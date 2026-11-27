/**
 * Trendz Tracker - Student Home layout (js/studentHome.js)
 *
 * Presentation only for /pages/student.html (H1 layout):
 * - "My Day" split view: today's to-do tasks + active homework, with a detail pane
 * - "Practice & More" tiles
 * - "Coming up" panel: upcoming weekly tests, homework due dates, reminders
 *
 * It reads data that js/student.js already loads; it never writes data itself.
 * Links reuse the existing helpers (taskLink, getPracticeLinkForActivity), so
 * to-do and homework tracking parameters stay exactly as before.
 */

import { getRoleNavItems } from './navConfig.js';
import { escapeHtml } from './dashboardComponents.js';
import { taskLink, isTaskActivityAvailable, flashSummary } from './todoForm.js';
import { progressText } from './todoProgress.js';
import { isBasicsOnlineAvailable } from './practiceStats.js';
import { getPracticeLinkForActivity } from './studentHomeworkView.js';
import { formatHomeworkTypeLabel } from './homeworkData.js';
import { stageLabel, formatEventDateChipIST, sanitizeNotificationLink } from './notificationsView.js';

const SECTION_LABELS = {
  round: 'Main Round',
  basics: 'Basics drill',
  elements: 'Elements',
  memoriad: 'Memoriad',
  flash: 'Flash Anzan',
};

const SECTION_HINTS = {
  round: 'Log your Main Round scores for today.',
  basics: 'Timed speed drill. Practise online, or log a result from paper.',
  elements: 'Timed Elements worksheet with fresh questions each time.',
  memoriad: 'Memoriad competition practice.',
  flash: 'Flash Anzan practice with the settings your teacher chose.',
};

const SECTION_ORDER = ['round', 'basics', 'elements', 'memoriad', 'flash'];

export function todayISTYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function formatYmdShort(ymd) {
  if (!ymd || typeof ymd !== 'string') return '';
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function daysUntil(ymd, today = todayISTYmd()) {
  const a = Date.parse(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/** "KA-1" → "KA1", "Level 3" → "L3", "Graduate" → "GR", "Master" → "M", "Grandmaster" → "GM". */
export function levelShort(level) {
  const text = String(level || '').trim();
  if (!text) return '—';
  const ka = text.match(/^ka\s*[-_ ]?\s*(\d+)$/i);
  if (ka) return `KA${ka[1]}`;
  if (/^grand\s*master$/i.test(text)) return 'GM';
  if (/^graduate$/i.test(text)) return 'GR';
  const m = text.match(/^([A-Za-z])[A-Za-z]*\s*[-_ ]?\s*(\d+)/);
  if (m) return `${m[1].toUpperCase()}${m[2]}`;
  if (/^\d+$/.test(text)) return text;
  return text.charAt(0).toUpperCase();
}

/* --------------------------------------------------------------------------
 * Hero extras
 * ------------------------------------------------------------------------ */
export function renderHeroIdentity(profile) {
  const first = String(profile?.full_name || 'there').trim().split(/\s+/)[0] || 'there';
  const firstEl = document.getElementById('student-first-name');
  if (firstEl) firstEl.textContent = first;
  const shortEl = document.getElementById('student-level-short');
  if (shortEl) shortEl.textContent = levelShort(profile?.level);
}

function allowedNavItems(profile) {
  const access = profile?.practice_access || profile?.access || null;
  return getRoleNavItems('student', null, access);
}

/* --------------------------------------------------------------------------
 * Practice & More tiles
 * ------------------------------------------------------------------------ */
const TILES = [
  { id: 'student-basics', label: 'Basics', icon: '➕' },
  { id: 'student-flash', label: 'Flash Anzan', icon: '⚡' },
  { id: 'student-elements', label: 'Elements', icon: '🧩' },
  { id: 'student-memoriad', label: 'Memoriad', icon: '🧠' },
  { id: 'student-oral-rounds', label: 'Oral Rounds', icon: '🗣️' },
  { id: 'student-simple', label: 'Simple', icon: '🔢' },
  { id: 'student-round-scores', label: 'Main Round', icon: '🎯' },
  { id: 'student-weekly-test', label: 'Weekly Test', icon: '📝' },
  { id: 'student-leaderboard', label: 'Leaderboard', icon: '🏆' },
  { id: 'student-monthly-report', label: 'Report', icon: '📊' },
  { id: 'resources', label: 'Resources', icon: '📚', href: '/pages/resources.html' },
];

export function renderPracticeTiles(profile, containerId = 'sh-tiles') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const byId = new Map(allowedNavItems(profile).map((i) => [i.id, i]));
  container.innerHTML = TILES.filter((t) => t.href || byId.has(t.id))
    .map((t) => {
      const href = t.href || byId.get(t.id).href;
      return `<a class="sh-tile" href="${href}"><span class="art" aria-hidden="true">${t.icon}</span><span class="nm">${escapeHtml(t.label)}</span></a>`;
    })
    .join('');
}

/* --------------------------------------------------------------------------
 * My Day
 * ------------------------------------------------------------------------ */
export function activeHomework(items = [], today = todayISTYmd()) {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => i && (!i.isCompleted || i.assigned_date === today));
}

function todoEntries(todos = [], categories = []) {
  const list = Array.isArray(todos) ? [...todos] : [];
  list.sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.task_section || 'round') - SECTION_ORDER.indexOf(b.task_section || 'round')
  );
  return list.map((t) => {
    const sec = String(t.task_section || 'round').toLowerCase();
    return {
      kind: 'todo',
      key: `todo-${t.id || t.task_id || t.task_title}`,
      done: t.done === true,
      label: SECTION_LABELS[sec] || 'Task',
      title: t.task_title || SECTION_LABELS[sec] || 'Task',
      sec,
      task: t,
      categories,
    };
  });
}

function homeworkEntries(items = [], today = todayISTYmd()) {
  return activeHomework(items, today).map((h) => {
    let when = 'Homework';
    if (h.due_date) {
      const d = daysUntil(h.due_date, today);
      when = d === 0 ? 'Homework · due today' : d === 1 ? 'Homework · due tomorrow' : `Homework · due ${formatYmdShort(h.due_date)}`;
    }
    return {
      kind: 'homework',
      key: `hw-${h.id}`,
      done: Boolean(h.isCompleted),
      pending: Boolean(h.isPendingReview),
      label: when,
      title: h.title || formatHomeworkTypeLabel(h.activity_type),
      hw: h,
    };
  });
}

function todoActionsHtml(entry) {
  const t = entry.task;
  const sec = entry.sec;
  if (!isTaskActivityAvailable(t, entry.categories)) {
    return `<span class="md-tag wait">Activity no longer available</span>`;
  }
  const link = taskLink(t);
  if (sec === 'basics') {
    const cat = t.task_category_id && Array.isArray(entry.categories)
      ? entry.categories.find((c) => String(c.id) === String(t.task_category_id))
      : null;
    const canOnline = cat ? isBasicsOnlineAvailable(cat) : false;
    const tid = t.id || t.task_id;
    const onlineHref = canOnline
      ? `/pages/basics-practice.html?cat=${encodeURIComponent(t.task_category_id)}${tid ? `&todo_task_id=${encodeURIComponent(tid)}` : ''}`
      : `/pages/basics.html${tid ? `?todo_task_id=${encodeURIComponent(tid)}` : ''}`;
    return `<a href="${onlineHref}" class="btn btn-primary">Start practice &rarr;</a>
            <a href="${link}" class="btn btn-outline">Log a paper result</a>`;
  }
  if (sec === 'round') {
    return `<a href="${link}" class="btn btn-primary">Log result &rarr;</a>`;
  }
  return `<a href="${link}" class="btn btn-primary">Start practice &rarr;</a>`;
}

function detailHtml(entry, isNext) {
  if (!entry) {
    return `<span class="kick done">All clear</span>
      <h3>No tasks for today</h3>
      <p>Nothing has been assigned for today. Any practice you do still counts toward your streak.</p>
      <div class="md-acts"><a href="/pages/basics.html" class="btn btn-primary">Practise Basics &rarr;</a></div>`;
  }

  if (entry.kind === 'homework') {
    const h = entry.hw;
    const required = Number(h.required_count) || 1;
    const current = Number(h.progressCount) || (entry.done ? required : 0);
    const mergedSettings = {
      ...h.settings,
      category_id: h.category_id || h.settings?.category_id,
      duration_seconds: h.duration_seconds || h.settings?.duration_seconds,
    };
    const link = getPracticeLinkForActivity(h.activity_type, mergedSettings, h.id);
    let kick = `<span class="kick hw">Homework</span>`;
    let acts = '';
    if (entry.done) {
      kick = `<span class="kick done">Homework done</span>`;
    } else if (entry.pending) {
      kick = `<span class="kick hw">Waiting for teacher review</span>`;
    } else if (link) {
      acts = `<a href="${escapeHtml(link)}" class="btn btn-primary">Practice online &rarr;</a>`;
    } else {
      acts = `<button type="button" class="btn btn-outline" data-open-full-plan="${escapeHtml(h.id)}">Submit for review in full plan</button>`;
    }
    return `${kick}
      <h3>${escapeHtml(entry.title)}</h3>
      <p>${h.instructions ? escapeHtml(h.instructions) : 'Assigned by your teacher. Homework is tracked separately and does not affect your streak.'}</p>
      <div class="md-facts">
        <span>Type <b>${escapeHtml(formatHomeworkTypeLabel(h.activity_type))}</b></span>
        <span>Progress <b class="num">${current} of ${required}</b></span>
        <span>${h.due_date ? `Due <b>${escapeHtml(formatYmdShort(h.due_date))}</b>` : 'No due date'}</span>
        <span>From <b>${escapeHtml(h.assigner?.full_name || 'Teacher')}</b></span>
      </div>
      ${acts ? `<div class="md-acts">${acts}</div>` : ''}`;
  }

  const t = entry.task;
  const flash = entry.sec === 'flash' ? flashSummary(t) : '';
  const kick = entry.done
    ? `<span class="kick done">Done</span>`
    : `<span class="kick">${isNext ? 'Up next' : 'To do'}</span>`;
  return `${kick}
    <h3>${escapeHtml(entry.title)} · ${escapeHtml(entry.label)}</h3>
    <p>${escapeHtml(SECTION_HINTS[entry.sec] || '')}</p>
    <div class="md-facts">
      <span>Progress <b class="num">${escapeHtml(progressText(t.done_count, t.required_count))}</b></span>
      ${flash ? `<span><b>${escapeHtml(flash)}</b></span>` : ''}
      <span>Counts toward <b>streak</b></span>
    </div>
    <div class="md-acts">${todoActionsHtml(entry)}</div>`;
}

/**
 * Renders the My Day split view.
 * @param {{ todos: Array, categories: Array, homework: Array, onOpenFullPlan?: (hwId?: string) => void }} opts
 */
export function renderMyDay({ todos = [], categories = [], homework = [], onOpenFullPlan } = {}) {
  const listEl = document.getElementById('myday-list');
  const detailEl = document.getElementById('myday-detail');
  if (!listEl || !detailEl) return;

  const entries = [...todoEntries(todos, categories), ...homeworkEntries(homework)];
  const doneCount = entries.filter((e) => e.done).length;
  const pct = entries.length ? Math.round((doneCount / entries.length) * 100) : 0;
  const nextIdx = entries.findIndex((e) => !e.done && !e.pending);

  const footEl = document.getElementById('myday-foot-left');
  if (footEl) {
    const left = entries.length - doneCount;
    footEl.textContent = entries.length === 0
      ? 'Nothing assigned today.'
      : left === 0
        ? 'Everything is done for today. Well played!'
        : `${left} ${left === 1 ? 'item' : 'items'} left today.`;
  }

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="md-empty">No tasks or homework for today.</div>`;
    detailEl.querySelector('.md-body').innerHTML = detailHtml(null);
    return;
  }

  listEl.innerHTML = `
    <div class="md-progress"><span class="num">${doneCount} of ${entries.length} done</span>${homework.length ? ' <span style="font-weight:500">· tasks + homework</span>' : ''}
      <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="My Day progress"><i style="width:${pct}%"></i></div></div>
    ${entries
      .map((e, i) => {
        let tag = '';
        if (e.done) tag = `<span class="md-tag ok" aria-label="Done">✓</span>`;
        else if (e.pending) tag = `<span class="md-tag wait">Review</span>`;
        else if (i === nextIdx) tag = `<span class="md-tag next">Next</span>`;
        else if (e.kind === 'homework') tag = `<span class="md-tag hw">HW</span>`;
        return `<button type="button" class="md-item${e.done ? ' is-done' : ''}" data-md-index="${i}" aria-pressed="false">
            <span class="when"><span>${escapeHtml(e.label)}</span>${tag}</span>
            <span class="what">${escapeHtml(e.title)}</span>
          </button>`;
      })
      .join('')}`;

  const body = detailEl.querySelector('.md-body');
  const select = (idx) => {
    listEl.querySelectorAll('.md-item').forEach((b) => {
      const on = Number(b.getAttribute('data-md-index')) === idx;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    body.innerHTML = detailHtml(entries[idx], idx === nextIdx);
    body.querySelector('[data-open-full-plan]')?.addEventListener('click', (ev) => {
      if (typeof onOpenFullPlan === 'function') onOpenFullPlan(ev.currentTarget.getAttribute('data-open-full-plan'));
    });
  };

  listEl.querySelectorAll('.md-item').forEach((b) => {
    b.addEventListener('click', () => select(Number(b.getAttribute('data-md-index'))));
  });

  select(nextIdx >= 0 ? nextIdx : 0);
}

/* --------------------------------------------------------------------------
 * Coming up
 * ------------------------------------------------------------------------ */
function pillForDays(d) {
  if (d === 0) return `<span class="cu-pill today">Today</span>`;
  if (d === 1) return `<span class="cu-pill soon">Tomorrow</span>`;
  if (d !== null && d > 1 && d <= 7) return `<span class="cu-pill">In ${d} days</span>`;
  return `<span class="cu-pill">Upcoming</span>`;
}

/**
 * @param {{ upcomingTests?: Array, homework?: Array, reminders?: Array }} data
 */
export function renderComingUp({ activeTest = null, upcomingTests = [], homework = [], reminders = [] } = {}, containerId = 'coming-up-container') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const today = todayISTYmd();
  const rows = [];

  if (activeTest && activeTest.test) {
    const { test, completion = {}, isOnline } = activeTest;
    const total = Number(completion.totalCount ?? 0);
    let pill;
    let sub;
    let action;
    if (completion.state === 'completed') {
      pill = '<span class="cu-pill done">Completed</span>';
      sub = isOnline ? 'All sections submitted' : 'Scores recorded by your trainer';
      action = 'View';
    } else if (completion.state === 'partially_completed') {
      pill = '<span class="cu-pill prog">In progress</span>';
      sub = `${Number(completion.submittedCount ?? 0)} of ${total} done`;
      action = 'Continue';
    } else {
      pill = '<span class="cu-pill now">Today</span>';
      sub = isOnline ? `${total} ${total === 1 ? 'section' : 'sections'} to do` : 'With your trainer';
      action = 'Start';
    }
    rows.push(`<div class="cu-row cu-active"><span class="ic blue" aria-hidden="true">📝</span>
      <span class="t" title="Weekly test"><b>${escapeHtml(test.title || 'Weekly Test')}</b><span class="cu-sub">${pill}<span>${escapeHtml(sub)}</span></span></span>
      <a href="/pages/weekly-test.html" class="btn ${action === 'View' ? 'btn-outline' : 'btn-primary'} btn-sm">${action}</a></div>`);
  }

  upcomingTests.slice(0, 2).forEach((t) => {
    const d = daysUntil(t.test_date, today);
    rows.push(`<div class="cu-row"><span class="ic" aria-hidden="true">📝</span>
      <span class="t"><b>${escapeHtml(t.title || 'Weekly Test')}</b>Weekly test · ${escapeHtml(formatYmdShort(t.test_date))}</span>
      ${pillForDays(d)}</div>`);
  });

  homework
    .filter((h) => h && !h.isCompleted && !h.isPendingReview && h.due_date && daysUntil(h.due_date, today) >= 0)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .slice(0, 3)
    .forEach((h) => {
      const d = daysUntil(h.due_date, today);
      rows.push(`<div class="cu-row"><span class="ic amber" aria-hidden="true">📚</span>
        <span class="t"><b>${escapeHtml(h.title || 'Homework')}</b>Homework · due ${escapeHtml(formatYmdShort(h.due_date))}</span>
        ${d === 0 ? '<span class="cu-pill today">Due today</span>' : pillForDays(d)}</div>`);
    });

  (Array.isArray(reminders) ? reminders : []).slice(0, 3).forEach((item) => {
    const link = sanitizeNotificationLink(
      item.link,
      item.kind === 'announcement' ? '/pages/notifications.html' : '/pages/weekly-test.html'
    );
    const stage = stageLabel(item.days_left);
    const chip = formatEventDateChipIST(item.event_date || item.created_at);
    rows.push(`<div class="cu-row"><span class="ic blue" aria-hidden="true">🔔</span>
      <span class="t"><b>${escapeHtml(item.title || 'Reminder')}</b>${escapeHtml([stage, chip].filter(Boolean).join(' · ') || 'Reminder')}</span>
      <a href="${escapeHtml(link)}" class="btn btn-outline btn-sm">View</a></div>`);
  });

  const MAX_ROWS = 3;
  const extra = Math.max(0, rows.length - MAX_ROWS);
  container.innerHTML = `
    <div class="head"><h2>Coming up</h2><a href="/pages/notifications.html" class="sh-link">${extra > 0 ? `+${extra} more &rarr;` : 'See all &rarr;'}</a></div>
    ${rows.length ? rows.slice(0, MAX_ROWS).join('') : '<div class="cu-empty">Nothing scheduled yet. New tests, homework due dates and reminders will show here.</div>'}`;
}
