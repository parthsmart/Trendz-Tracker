/**
 * Trendz Tracker - Pure Weekly Test Share Message & Reminder Preview Helpers (js/reportMessage.js)
 *
 * Pure ES module (no DOM, no network, no phone numbers) for:
 * 1. Building the WhatsApp / Copy share text for an upcoming weekly test:
 *    `"Weekly test: <title> on <weekday, day month>. <Online on the Trendz Tracker website / With your trainer>. <notes shortened to 120 characters>"`
 * 2. Computing the reminder start date preview on the Admin Weekly Test form:
 *    `"Students will see a reminder from <date> until the test day."`
 *
 * Tested with `node --test tests/reportMessage.test.js`.
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
 * Parses a `YYYY-MM-DD` or ISO date in India Standard Time into `{ year, month, day, weekday }`.
 *
 * @param {string|Date|null|undefined} dateVal
 * @returns {{ year: number, month: number, day: number, weekdayIdx: number } | null}
 */
export function parseIstCalendarDate(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const dt = new Date(Date.UTC(year, month - 1, day));
      if (Number.isNaN(dt.getTime())) return null;
      return {
        year,
        month,
        day,
        weekdayIdx: dt.getUTCDay(),
      };
    }
  }

  try {
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (Number.isNaN(d.getTime())) return null;
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    return parseIstCalendarDate(iso);
  } catch {
    return null;
  }
}

/**
 * Formats a date as `<weekday, day month>` (e.g. `"Sun, 2 Nov"`).
 *
 * @param {string|Date|null|undefined} dateVal
 * @returns {string}
 */
export function formatWeekdayDayMonthIST(dateVal) {
  const parts = parseIstCalendarDate(dateVal);
  if (!parts) return String(dateVal || '').trim() || 'scheduled date';
  const weekday = SHORT_WEEKDAYS_3[parts.weekdayIdx] || '';
  const month = SHORT_MONTHS_3[parts.month - 1] || '';
  return `${weekday}, ${parts.day} ${month}`.trim();
}

/**
 * Shortens notes to at most `maxChars` characters (default 120), collapsing internal newlines/spaces.
 *
 * @param {string|null|undefined} notes
 * @param {number} [maxChars=120]
 * @returns {string}
 */
export function shortenNotes(notes, maxChars = 120) {
  if (notes === null || notes === undefined) return '';
  const normalized = String(notes).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

/**
 * Builds the plain-text share message for an upcoming weekly test:
 * `"Weekly test: <title> on <weekday, day month>. <Online on the Trendz Tracker website / With your trainer>. <notes shortened to 120 characters>"`
 *
 * Never asks for or includes any phone numbers.
 *
 * @param {{ title?: string, test_date?: string, date?: string, test_type?: string, type?: string, notes?: string|null }} test
 * @returns {string}
 */
export function buildWeeklyTestShareMessage(test = {}) {
  const safeTest = test && typeof test === 'object' ? test : {};
  const title = String(safeTest.title || '').replace(/\s+/g, ' ').trim() || 'Weekly Test';
  const rawDate = safeTest.test_date || safeTest.date || '';
  const dateLabel = formatWeekdayDayMonthIST(rawDate);

  const rawType = String(safeTest.test_type || safeTest.type || 'offline')
    .trim()
    .toLowerCase();
  const locationPhrase =
    rawType === 'online' ? 'Online on the Trendz Tracker website' : 'With your trainer';

  const shortNotes = shortenNotes(safeTest.notes, 120);
  if (shortNotes) {
    return `Weekly test: ${title} on ${dateLabel}. ${locationPhrase}. ${shortNotes}`;
  }
  return `Weekly test: ${title} on ${dateLabel}. ${locationPhrase}.`;
}

// Convenient aliases
export const buildTestShareMessage = buildWeeklyTestShareMessage;
export const formatWeeklyTestMessage = buildWeeklyTestShareMessage;

/**
 * Computes the reminder start date (`test_date - remind_days_before`) and returns the
 * helper preview text shown next to "Remind students from N days before" on the Weekly Test form:
 * `"Students will see a reminder from <date> until the test day."`
 *
 * @param {string|null|undefined} testDateStr - `YYYY-MM-DD`
 * @param {number|string|null|undefined} remindDaysBefore - integer 0..30
 * @returns {string}
 */
export function formatReminderStartPreview(testDateStr, remindDaysBefore = 7) {
  const parts = parseIstCalendarDate(testDateStr);
  if (!parts) {
    return 'Select a test date to preview when students will start seeing reminders.';
  }

  const rawDays =
    remindDaysBefore === '' || remindDaysBefore === null || remindDaysBefore === undefined
      ? 7
      : Number(remindDaysBefore);
  const clampedDays = Number.isFinite(rawDays)
    ? Math.max(0, Math.min(30, Math.floor(rawDays)))
    : 7;

  const startUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - clampedDays));
  const startDay = startUtc.getUTCDate();
  const startMonth = SHORT_MONTHS_3[startUtc.getUTCMonth()] || '';
  const startYear = startUtc.getUTCFullYear();
  const formattedStart =
    startYear === parts.year ? `${startDay} ${startMonth}` : `${startDay} ${startMonth} ${startYear}`;

  return `Students will see a reminder from ${formattedStart} until the test day.`;
}
