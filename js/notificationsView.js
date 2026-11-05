/**
 * Trendz Tracker - Pure Student Notifications View Helpers (js/notificationsView.js)
 *
 * Pure ES module (no DOM, no network, no storage) for student notification badges,
 * stage chips ("In 4 days", "Tomorrow", "Today"), date chips ("Sun 2 Nov"),
 * and grouping into "Weekly tests" and "Announcements".
 * Tested with `node --test tests/notificationsView.test.js`.
 */

const SHORT_WEEKDAYS_3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS_3 = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Returns the text label for a notification's countdown stage chip:
 * - `days_left === 0` (or negative): `"Today"`
 * - `days_left === 1`: `"Tomorrow"`
 * - `days_left >= 2`: `"In <N> days"` (e.g. `"In 4 days"`)
 * - `null`, `undefined`, `""`, or `NaN`: `""`
 *
 * @param {number|string|null|undefined} days_left
 * @returns {string}
 */
export function stageLabel(days_left) {
  if (days_left === null || days_left === undefined || days_left === '') {
    return '';
  }
  const n = Number(days_left);
  if (!Number.isFinite(n)) {
    return '';
  }
  const whole = Math.floor(n);
  if (whole <= 0) {
    return 'Today';
  }
  if (whole === 1) {
    return 'Tomorrow';
  }
  return `In ${whole} days`;
}

/**
 * Groups an array of notification rows from `my_notifications()` into two lists:
 * - `tests` (also aliased as `weeklyTests`): items with `kind === 'test_upcoming'` or `'test_today'`
 * - `announcements`: items with `kind === 'announcement'`
 *
 * Preserves input order within each group.
 *
 * @param {Array<Record<string, any>>} items
 * @returns {{ tests: Array<Record<string, any>>, weeklyTests: Array<Record<string, any>>, announcements: Array<Record<string, any>> }}
 */
export function groupNotifications(items) {
  const tests = [];
  const announcements = [];
  const messages = [];

  if (!Array.isArray(items)) {
    return { tests, weeklyTests: tests, announcements, messages };
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.kind || '').toLowerCase();
    if (kind === 'test_upcoming' || kind === 'test_today') {
      tests.push(item);
    } else if (kind === 'announcement') {
      announcements.push(item);
    } else if (kind === 'private_message' || kind === 'message' || kind === 'trainer_note' || kind === 'student_message') {
      messages.push(item);
    }
  }

  return {
    tests,
    weeklyTests: tests,
    announcements,
    messages,
  };
}

/**
 * Counts the active unread notifications for bell badge and count indicators:
 * - Private messages: counted only if unread (`!item.read_at`).
 * - Weekly test reminders and announcements: all active items count towards the badge.
 *
 * @param {Array<Record<string, any>>} items
 * @returns {number}
 */
export function countActiveUnreadNotifications(items) {
  if (!Array.isArray(items)) return 0;
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const kind = String(item.kind || '').toLowerCase();
    const ref = String(item.ref || '');
    if (
      kind === 'private_message' ||
      kind === 'student_message' ||
      kind === 'trainer_note' ||
      ref.startsWith('msg:')
    ) {
      return !item.read_at;
    }
    return true;
  }).length;
}

/**
 * Computes the navigation bell badge text for a given unread/active notification count:
 * - `<= 0` or non-numeric: `""` (badge should be hidden)
 * - `1..9`: `"1"` through `"9"`
 * - `> 9`: `"9+"`
 *
 * @param {number|string|null|undefined} count
 * @returns {string}
 */
export function badgeText(count) {
  if (count === null || count === undefined || count === '') {
    return '';
  }
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) {
    return '';
  }
  const whole = Math.floor(n);
  if (whole <= 0) {
    return '';
  }
  if (whole > 9) {
    return '9+';
  }
  return String(whole);
}

/**
 * Formats a `YYYY-MM-DD` date or ISO timestamp in India Standard Time as `"Sun 2 Nov"`.
 *
 * @param {string|Date|null|undefined} dateVal
 * @returns {string}
 */
export function formatEventDateChipIST(dateVal) {
  if (!dateVal) return '';
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) {
      const year = Number(match[1]);
      const monthIdx = Number(match[2]) - 1;
      const day = Number(match[3]);
      const utcDate = new Date(Date.UTC(year, monthIdx, day));
      if (!Number.isNaN(utcDate.getTime())) {
        const weekday = SHORT_WEEKDAYS_3[utcDate.getUTCDay()] || '';
        const month = SHORT_MONTHS_3[monthIdx] || '';
        return `${weekday} ${day} ${month}`.trim();
      }
    }
  }

  try {
    const dt = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (Number.isNaN(dt.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).formatToParts(dt);
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const day = parts.find((p) => p.type === 'day')?.value || '';
    const month = parts.find((p) => p.type === 'month')?.value || '';
    return `${weekday} ${day} ${month}`.trim();
  } catch {
    return '';
  }
}

/**
 * Ensures a notification link is a safe internal relative URL.
 *
 * @param {string|null|undefined} link
 * @param {string} [fallback='/pages/student.html']
 * @returns {string}
 */
export function sanitizeNotificationLink(link, fallback = '/pages/student.html') {
  if (typeof link !== 'string') return fallback;
  const trimmed = link.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return fallback;
  }
  return trimmed;
}
