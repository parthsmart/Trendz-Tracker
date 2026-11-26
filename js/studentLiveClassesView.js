/**
 * Trendz Tracker - Student Live Classes view helpers (js/studentLiveClassesView.js)
 *
 * Pure functions (no DOM, no network) for the student Live Classes page:
 * classify each class against the clock, group them into Live now / Upcoming (by IST day) / Past,
 * build countdown text and an .ics calendar file.
 * Tested with `node --test tests/studentLiveClassesView.test.js`.
 */

const MINUTE = 60 * 1000;
const IST_OFFSET_MS = 330 * MINUTE;
/** Students can open the room this long before the start time. */
export const JOIN_OPENS_BEFORE_MIN = 15;
const PAST_LIMIT = 20;

function startMs(cls) {
  const raw = cls?.scheduled_start_time;
  if (raw === null || raw === undefined || raw === '') return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

function durationMs(cls) {
  const minutes = Number(cls?.duration_minutes);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * MINUTE;
}

/**
 * State of one class at `now`:
 * - 'live': the teacher has started the room.
 * - 'starting': start time has passed, the class window is open, teacher not live yet.
 * - 'soon': starts within JOIN_OPENS_BEFORE_MIN minutes (the room can be opened).
 * - 'upcoming': later than that.
 * - 'past': ended, or its time window passed without going live.
 */
export function classifyClass(cls, now = Date.now()) {
  const status = cls?.status;
  if (status === 'ended' || status === 'cancelled' || ['ended', 'completed'].includes(cls?.provider_status)) {
    return 'past';
  }
  if (status === 'live') return 'live';
  const start = startMs(cls);
  if (start === null) return 'upcoming';
  if (now >= start + durationMs(cls)) return 'past';
  if (now >= start || status === 'waiting') return 'starting';
  if (start - now <= JOIN_OPENS_BEFORE_MIN * MINUTE) return 'soon';
  return 'upcoming';
}

/** True when the Join button should be shown for this state. */
export function canJoin(state) {
  return state === 'live' || state === 'starting' || state === 'soon';
}

/** IST calendar day key, e.g. "2026-11-26". */
export function istDayKey(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Tomorrow" or "Thu, 27 Nov" for an IST day. */
export function dayLabel(ms, now = Date.now()) {
  const key = istDayKey(ms);
  if (key === istDayKey(now)) return 'Today';
  if (key === istDayKey(now + 24 * 60 * MINUTE)) return 'Tomorrow';
  const d = new Date(ms + IST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "5:30 PM" in IST. */
export function timeLabel(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "in 45 min", "in 2 h 5 min", "in 3 days" (empty when the start has passed). */
export function countdownLabel(startAt, now = Date.now()) {
  const diff = startAt - now;
  if (!(diff > 0)) return '';
  const totalMin = Math.ceil(diff / MINUTE);
  if (totalMin < 60) return `in ${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const min = totalMin % 60;
    return min ? `in ${hours} h ${min} min` : `in ${hours} h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Splits classes into:
 * - live: live and starting classes (live first)
 * - upcoming: [{ key, label, classes }] by IST day, soonest first
 * - past: most recent first, at most PAST_LIMIT
 * - next: the first class that has not started yet (or null)
 * Each class comes back as { ...cls, state, startAt }.
 */
export function groupClasses(classes, now = Date.now()) {
  const live = [];
  const future = [];
  const past = [];
  for (const cls of Array.isArray(classes) ? classes : []) {
    if (!cls || cls.status === 'cancelled') continue;
    const item = { ...cls, state: classifyClass(cls, now), startAt: startMs(cls) };
    if (item.state === 'live' || item.state === 'starting') live.push(item);
    else if (item.state === 'past') past.push(item);
    else future.push(item);
  }
  const byStart = (a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity);
  live.sort((a, b) => (a.state === b.state ? byStart(a, b) : a.state === 'live' ? -1 : 1));
  future.sort(byStart);
  past.sort((a, b) => (b.startAt ?? 0) - (a.startAt ?? 0));

  const upcoming = [];
  for (const item of future) {
    const key = item.startAt === null ? 'unscheduled' : istDayKey(item.startAt);
    let day = upcoming[upcoming.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: item.startAt === null ? 'Time to be announced' : dayLabel(item.startAt, now), classes: [] };
      upcoming.push(day);
    }
    day.classes.push(item);
  }
  return { live, upcoming, past: past.slice(0, PAST_LIMIT), next: future[0] || null };
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(value) {
  return String(value ?? '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
}

/** A single-event iCalendar file for one class. `joinUrl` is the Trendz room link. */
export function buildIcs(cls, joinUrl, now = Date.now()) {
  const start = startMs(cls);
  if (start === null) return '';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Trendz Tracker//Live Classes//EN',
    'BEGIN:VEVENT',
    `UID:${icsText(cls.id)}@trendz-tracker`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(start + durationMs(cls))}`,
    `SUMMARY:${icsText(cls.title || 'Live class')}`,
    `DESCRIPTION:${icsText(`Teacher: ${cls.teacher_name || 'Trendz teacher'}\nJoin: ${joinUrl}`)}`,
    `URL:${icsText(joinUrl)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Live class starts in 10 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
