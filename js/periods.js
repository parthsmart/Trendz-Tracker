/**
 * Trendz Tracker - Pure India Standard Time (IST) Reporting Period Helpers (js/periods.js)
 *
 * Intent:
 * Every student and teacher statistic and leaderboard must clearly state its exact
 * reporting period in India time (UTC+05:30), never mixing "Last 7 days" (rolling 7-day
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

export const MIN_LEADERBOARD_DATE = '2020-01-01';

export const VALID_SIMPLE_PERIODS = [
  'today',
  'yesterday',
  'week',
  'month',
  'year',
  'all',
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
 * Checks whether a string is a real Gregorian 'YYYY-MM-DD' calendar date.
 * Rejects impossible dates like '2026-02-29' or '2026-04-31', while accepting
 * real leap days like '2028-02-29'.
 * @param {string} dateText
 * @returns {boolean}
 */
export function isValidCalendarYMD(dateText) {
  if (typeof dateText !== 'string') return false;
  const clean = dateText.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Validates a custom leaderboard date input against India time bounds:
 * - Must be a valid 'YYYY-MM-DD' calendar date
 * - Must not be before '2020-01-01'
 * - Must not be in the future relative to `todayIST`
 *
 * @param {string} dateText
 * @param {Date|string|number} [todayIST]
 * @returns {{ valid: boolean, dateText: string|null, error: string|null }}
 */
export function validatePeriodDate(dateText, todayIST = new Date()) {
  if (typeof dateText !== 'string' || !dateText.trim()) {
    return {
      valid: false,
      dateText: null,
      error: 'Please choose a date.',
    };
  }
  const clean = dateText.trim();
  if (!isValidCalendarYMD(clean)) {
    return {
      valid: false,
      dateText: null,
      error: 'Enter a valid calendar date (YYYY-MM-DD).',
    };
  }
  if (clean < MIN_LEADERBOARD_DATE) {
    return {
      valid: false,
      dateText: null,
      error: 'The date cannot be before 2020-01-01.',
    };
  }
  const todayYmd = getISTDateYMD(todayIST);
  if (clean > todayYmd) {
    return {
      valid: false,
      dateText: null,
      error: 'The date cannot be in the future.',
    };
  }
  return {
    valid: true,
    dateText: clean,
    error: null,
  };
}

/**
 * Builds the canonical `p_period` RPC argument from a selector choice and optional date string.
 * - For 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all', returns that choice.
 * - For 'date', validates `dateText` and returns `'date:YYYY-MM-DD'` when valid, or `null` when invalid.
 *
 * @param {string} choice
 * @param {string} [dateText='']
 * @param {Date|string|number} [todayIST]
 * @returns {string|null}
 */
export function periodValue(choice, dateText = '', todayIST = new Date()) {
  if (typeof choice !== 'string') return null;
  const cleanChoice = choice.trim().toLowerCase();

  if (VALID_SIMPLE_PERIODS.includes(cleanChoice)) {
    return cleanChoice;
  }

  if (cleanChoice === 'date') {
    const check = validatePeriodDate(dateText, todayIST);
    return check.valid ? `date:${check.dateText}` : null;
  }

  if (cleanChoice.startsWith('date:')) {
    const rawDate = cleanChoice.slice(5);
    const check = validatePeriodDate(rawDate, todayIST);
    return check.valid ? `date:${check.dateText}` : null;
  }

  return null;
}

/**
 * Parses and validates a period value from URL query parameters, localStorage, or state.
 * Accepts: 'today', 'yesterday', 'week', 'month', 'year', 'all', and 'date:YYYY-MM-DD'.
 * Returns `{ choice, dateText, value }` when valid, or `null` when invalid.
 *
 * @param {string|null|undefined} value
 * @param {Date|string|number} [todayIST]
 * @returns {{ choice: string, dateText: string, value: string } | null}
 */
export function parsePeriod(value, todayIST = new Date()) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!clean) return null;

  const lower = clean.toLowerCase();
  if (VALID_SIMPLE_PERIODS.includes(lower)) {
    return {
      choice: lower,
      dateText: '',
      value: lower,
    };
  }

  if (lower.startsWith('date:')) {
    const datePart = clean.slice(5).trim();
    const check = validatePeriodDate(datePart, todayIST);
    if (!check.valid) return null;
    return {
      choice: 'date',
      dateText: check.dateText,
      value: `date:${check.dateText}`,
    };
  }

  return null;
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
 * Returns the exact human-readable range label for a leaderboard period in India time:
 * - 'today' -> "Today, Sat 31 Oct"
 * - 'yesterday' -> "Yesterday, Fri 30 Oct"
 * - 'week' -> "26 Oct to 1 Nov" (or "19 to 25 Oct" when in same month)
 * - 'month' -> "Oct 2026"
 * - 'year' -> "2026"
 * - 'all' -> "All time"
 * - 'date:YYYY-MM-DD' -> "Thu 29 Oct 2026"
 *
 * @param {string} value
 * @param {Date|string|number} [todayIST]
 * @returns {string}
 */
export function periodLabel(value, todayIST = new Date()) {
  const todayYmd = getISTDateYMD(todayIST);
  const parsed = parsePeriod(value, todayYmd);
  const choice = parsed ? parsed.choice : 'week';

  if (choice === 'today') {
    const dt = parseYmdToUtcDate(todayYmd);
    const dow = SHORT_DAYS[dt.getUTCDay()];
    const day = dt.getUTCDate();
    const mon = SHORT_MONTHS[dt.getUTCMonth()];
    return `Today, ${dow} ${day} ${mon}`;
  }

  if (choice === 'yesterday') {
    const yestYmd = addDaysYMD(todayYmd, -1);
    const dt = parseYmdToUtcDate(yestYmd);
    const dow = SHORT_DAYS[dt.getUTCDay()];
    const day = dt.getUTCDate();
    const mon = SHORT_MONTHS[dt.getUTCMonth()];
    return `Yesterday, ${dow} ${day} ${mon}`;
  }

  if (choice === 'week') {
    const { startYmd, endYmd } = getWeekBoundsIST(todayYmd);
    return formatShortRangeIST(startYmd, endYmd);
  }

  if (choice === 'month') {
    const dt = parseYmdToUtcDate(todayYmd);
    const mon = SHORT_MONTHS[dt.getUTCMonth()];
    const yr = dt.getUTCFullYear();
    return `${mon} ${yr}`;
  }

  if (choice === 'year') {
    const dt = parseYmdToUtcDate(todayYmd);
    return String(dt.getUTCFullYear());
  }

  if (choice === 'all') {
    return 'All time';
  }

  if (choice === 'date' && parsed?.dateText) {
    const dt = parseYmdToUtcDate(parsed.dateText);
    const dow = SHORT_DAYS[dt.getUTCDay()];
    const day = dt.getUTCDate();
    const mon = SHORT_MONTHS[dt.getUTCMonth()];
    const yr = dt.getUTCFullYear();
    return `${dow} ${day} ${mon} ${yr}`;
  }

  const { startYmd, endYmd } = getWeekBoundsIST(todayYmd);
  return formatShortRangeIST(startYmd, endYmd);
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
