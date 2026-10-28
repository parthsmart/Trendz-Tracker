/**
 * Trendz Tracker - Pure India Standard Time (IST) Reporting Period Helpers
 *
 * Intent:
 * Every student and teacher statistic must clearly state its exact reporting
 * period in India time (UTC+05:30), never mixing "Last 7 days" (rolling 7-day
 * window ending today) with "Monday to Sunday" (calendar week).
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

/**
 * Normalizes a Date, timestamp, ISO string, or 'YYYY-MM-DD' string into
 * an IST YYYY-MM-DD string.
 * @param {Date|string|number} [input]
 * @returns {string} 'YYYY-MM-DD' in India Standard Time
 */
export function getISTDateYMD(input = new Date()) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date(Date.now() + IST_OFFSET_MS);
    return fallback.toISOString().slice(0, 10);
  }
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parses a 'YYYY-MM-DD' string into a UTC Date at 00:00:00Z for calendar arithmetic.
 * @param {string} ymd
 * @returns {Date}
 */
function parseYmdToUtcDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

/**
 * Formats a UTC Date object (representing a calendar date) back to 'YYYY-MM-DD'.
 * @param {Date} utcDate
 * @returns {string}
 */
function formatUtcDateToYmd(utcDate) {
  const y = utcDate.getUTCFullYear();
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Adds `days` to a 'YYYY-MM-DD' date string.
 * @param {string} ymd
 * @param {number} days
 * @returns {string} 'YYYY-MM-DD'
 */
export function addDaysYMD(ymd, days) {
  const dt = parseYmdToUtcDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatUtcDateToYmd(dt);
}

/**
 * Formats today's date in India time for the Student Home "Today" header,
 * e.g. "Wednesday, 28 Oct 2026".
 * @param {Date|string|number} [input]
 * @returns {string}
 */
export function formatTodayHeadingIST(input = new Date()) {
  const ymd = getISTDateYMD(input);
  const dt = parseYmdToUtcDate(ymd);
  const dayName = LONG_DAYS[dt.getUTCDay()];
  const dayNum = dt.getUTCDate();
  const monthName = SHORT_MONTHS[dt.getUTCMonth()];
  const year = dt.getUTCFullYear();
  return `${dayName}, ${dayNum} ${monthName} ${year}`;
}

/**
 * Formats two 'YYYY-MM-DD' dates as a compact date range:
 * - Same month & year: "22 to 28 Oct"
 * - Different month, same year: "28 Sep to 4 Oct"
 * - Different year: "28 Dec 2026 to 3 Jan 2027"
 * @param {string} startYmd
 * @param {string} endYmd
 * @returns {string}
 */
export function formatShortRangeIST(startYmd, endYmd) {
  const s = parseYmdToUtcDate(startYmd);
  const e = parseYmdToUtcDate(endYmd);
  const sDay = s.getUTCDate();
  const eDay = e.getUTCDate();
  const sMonth = SHORT_MONTHS[s.getUTCMonth()];
  const eMonth = SHORT_MONTHS[e.getUTCMonth()];
  const sYear = s.getUTCFullYear();
  const eYear = e.getUTCFullYear();

  if (sYear !== eYear) {
    return `${sDay} ${sMonth} ${sYear} to ${eDay} ${eMonth} ${eYear}`;
  }
  if (s.getUTCMonth() === e.getUTCMonth()) {
    return `${sDay} to ${eDay} ${eMonth}`;
  }
  return `${sDay} ${sMonth} to ${eDay} ${eMonth}`;
}

/**
 * Returns the Monday-to-Sunday calendar week bounds and formatted labels in India time.
 * E.g. for Wednesday 2026-10-28:
 * - startYmd: '2026-10-26'
 * - endYmd: '2026-11-01'
 * - rangeText: 'Mon 26 Oct to Sun 1 Nov'
 * - label: 'This week: Mon 26 Oct to Sun 1 Nov'
 * @param {Date|string|number} [input]
 * @returns {{ startYmd: string, endYmd: string, rangeText: string, label: string }}
 */
export function getWeekBoundsIST(input = new Date()) {
  const todayYmd = getISTDateYMD(input);
  const dt = parseYmdToUtcDate(todayYmd);
  const dow = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;

  const startYmd = addDaysYMD(todayYmd, offsetToMonday);
  const endYmd = addDaysYMD(startYmd, 6);

  const s = parseYmdToUtcDate(startYmd);
  const e = parseYmdToUtcDate(endYmd);

  const sDayName = SHORT_DAYS[s.getUTCDay()];
  const eDayName = SHORT_DAYS[e.getUTCDay()];
  const sDay = s.getUTCDate();
  const eDay = e.getUTCDate();
  const sMonth = SHORT_MONTHS[s.getUTCMonth()];
  const eMonth = SHORT_MONTHS[e.getUTCMonth()];
  const sYear = s.getUTCFullYear();
  const eYear = e.getUTCFullYear();

  const rangeText =
    sYear !== eYear
      ? `${sDayName} ${sDay} ${sMonth} ${sYear} to ${eDayName} ${eDay} ${eMonth} ${eYear}`
      : `${sDayName} ${sDay} ${sMonth} to ${eDayName} ${eDay} ${eMonth}`;

  return {
    startYmd,
    endYmd,
    rangeText,
    label: `This week: ${rangeText}`,
  };
}

/**
 * Returns the formatted Monday-to-Sunday week range in India time,
 * e.g. "Mon 26 Oct to Sun 1 Nov".
 * @param {Date|string|number} [input]
 * @returns {string}
 */
export function formatWeekPeriodIST(input = new Date()) {
  return getWeekBoundsIST(input).rangeText;
}

/**
 * Returns the inclusive rolling 7-day window ending today in India time (`today - 6` to `today`).
 * E.g. for 2026-10-28:
 * - startYmd: '2026-10-22'
 * - endYmd: '2026-10-28'
 * - shortRange: '22 to 28 Oct'
 * - label: 'Last 7 days: 22 to 28 Oct'
 * @param {Date|string|number} [input]
 * @returns {{ startYmd: string, endYmd: string, shortRange: string, label: string }}
 */
export function getLast7DaysBoundsIST(input = new Date()) {
  const endYmd = getISTDateYMD(input);
  const startYmd = addDaysYMD(endYmd, -6);
  const shortRange = formatShortRangeIST(startYmd, endYmd);
  return {
    startYmd,
    endYmd,
    shortRange,
    label: `Last 7 days: ${shortRange}`,
  };
}

/**
 * Returns the formatted rolling 7-day period label in India time,
 * e.g. "Last 7 days: 22 to 28 Oct".
 * @param {Date|string|number} [input]
 * @returns {string}
 */
export function formatLast7DaysPeriodIST(input = new Date()) {
  return getLast7DaysBoundsIST(input).label;
}
