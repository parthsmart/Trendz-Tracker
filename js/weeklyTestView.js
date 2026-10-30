/**
 * Trendz Tracker - Pure Weekly Test View Helpers (js/weeklyTestView.js)
 *
 * Pure ES module (no DOM, no network) for Student Weekly Test cards, section statuses,
 * India-time opening/closing windows, and test grouping (`my_weekly_tests()`).
 * Tested with `node --test tests/weeklyTestView.test.js`.
 */

const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Returns the student-facing status chip label for an online weekly test section:
 * - When `section.attempt === 'submitted'` (or `correct` and `total` are present on a submitted attempt):
 *   `"Done: <correct> of <total>"`
 * - When `section.attempt === 'started'` without a submitted score:
 *   `"Missed"`
 * - When `section.attempt === null` (not started):
 *   - If `testState === 'closed'`: `"Missed"`
 *   - Otherwise (`'open'` or `'upcoming'`): `"To do"`
 *
 * @param {{ attempt?: 'started'|'submitted'|null, correct?: number|null, total?: number|null }} section
 * @param {'upcoming'|'open'|'closed'|string} [testState='open']
 * @returns {string}
 */
export function sectionStatusLabel(section, testState = 'open') {
  if (!section || typeof section !== 'object') {
    return testState === 'closed' ? 'Missed' : 'To do';
  }

  const attempt = section.attempt ?? null;
  const state = String(testState || 'open').toLowerCase();

  if (attempt === 'submitted') {
    const correct = Number.isFinite(Number(section.correct)) ? Number(section.correct) : 0;
    const total = Number.isFinite(Number(section.total)) ? Number(section.total) : 0;
    return `Done: ${correct} of ${total}`;
  }

  if (attempt === 'started') {
    // A started section that was abandoned or closed without submitting a score is lost ("Missed")
    if (
      section.correct !== null &&
      section.correct !== undefined &&
      section.total !== null &&
      section.total !== undefined &&
      Number(section.total) > 0
    ) {
      return `Done: ${Number(section.correct)} of ${Number(section.total)}`;
    }
    return 'Missed';
  }

  // attempt is null / undefined (never started)
  if (state === 'closed') {
    return 'Missed';
  }

  return 'To do';
}

/**
 * Returns true if the student can currently click "Start" on this section:
 * only when the test is `'open'` and `section.attempt` is null/empty (`"To do"`).
 *
 * @param {{ attempt?: 'started'|'submitted'|null }} section
 * @param {string} testState
 * @returns {boolean}
 */
export function isSectionStartable(section, testState) {
  if (String(testState || '').toLowerCase() !== 'open') return false;
  if (!section || typeof section !== 'object') return false;
  return section.attempt === null || section.attempt === undefined || section.attempt === '';
}

/**
 * Returns the next section in position order that is still `"To do"` (`attempt == null`),
 * or `null` when all sections have been started or submitted.
 *
 * @param {Array<{ category_id?: string, name?: string, seconds?: number, position?: number, attempt?: 'started'|'submitted'|null }>} sections
 * @returns {object|null}
 */
export function nextSection(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return null;

  const sorted = [...sections].sort((a, b) => {
    const posA = Number(a?.position) || 0;
    const posB = Number(b?.position) || 0;
    return posA - posB;
  });

  const found = sorted.find(
    (s) => s && (s.attempt === null || s.attempt === undefined || s.attempt === '')
  );
  return found || null;
}

/**
 * Formats a timestamp in India Standard Time (`Asia/Kolkata`).
 *
 * @param {string|Date} isoOrDate
 * @returns {{ datePart: string, timePart: string } | null}
 */
function formatIstParts(isoOrDate) {
  if (!isoOrDate) return null;
  const dt = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(dt.getTime())) return null;

  const datePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(dt);

  const timePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(dt)
    .replace(/\bam\b/i, 'AM')
    .replace(/\bpm\b/i, 'PM');

  return { datePart, timePart };
}

/**
 * Formats the opening and closing window for an online weekly test in India time:
 * - When both `opens_at` and `closes_at` are empty/null: `"All day (India time)"`
 * - When both are on the same IST date: `"10:00 AM to 6:00 PM IST"`
 * - When on different IST dates: `"18 Oct, 10:00 AM to 19 Oct, 6:00 PM IST"`
 * - When only `opens_at` is set: `"Opens 10:00 AM IST"`
 * - When only `closes_at` is set: `"Closes 6:00 PM IST"`
 *
 * @param {string|null|undefined} opens_at
 * @param {string|null|undefined} closes_at
 * @returns {string}
 */
export function windowText(opens_at, closes_at) {
  const openParts = formatIstParts(opens_at);
  const closeParts = formatIstParts(closes_at);

  if (!openParts && !closeParts) {
    return 'All day (India time)';
  }

  if (openParts && closeParts) {
    if (openParts.datePart === closeParts.datePart) {
      return `${openParts.timePart} to ${closeParts.timePart} IST`;
    }
    return `${openParts.datePart}, ${openParts.timePart} to ${closeParts.datePart}, ${closeParts.timePart} IST`;
  }

  if (openParts) {
    return `Opens ${openParts.timePart} IST`;
  }

  return `Closes ${closeParts.timePart} IST`;
}

/**
 * Partitions the array of weekly tests from `my_weekly_tests()` into three groups:
 * - `availableNow`: online tests with `state === 'open'` and offline tests with `state === 'today'`
 * - `upcoming`: online or offline tests with `state === 'upcoming'`
 * - `past`: online tests with `state === 'closed'` and offline tests with `state === 'past'`
 *
 * Within `availableNow` and `upcoming`, tests are ordered by `test_date ASC` (soonest first);
 * within `past`, tests are ordered by `test_date DESC` (most recent first).
 *
 * @param {Array<Record<string, any>>} tests
 * @returns {{ availableNow: Array<Record<string, any>>, upcoming: Array<Record<string, any>>, past: Array<Record<string, any>> }}
 */
export function groupTests(tests) {
  const availableNow = [];
  const upcoming = [];
  const past = [];

  if (!Array.isArray(tests)) {
    return { availableNow, upcoming, past };
  }

  for (const test of tests) {
    if (!test || typeof test !== 'object') continue;
    const state = String(test.state || '').toLowerCase();

    if (state === 'open' || state === 'today') {
      availableNow.push(test);
    } else if (state === 'upcoming') {
      upcoming.push(test);
    } else if (state === 'closed' || state === 'past') {
      past.push(test);
    } else {
      past.push(test);
    }
  }

  availableNow.sort((a, b) => String(a.test_date || '').localeCompare(String(b.test_date || '')));
  upcoming.sort((a, b) => String(a.test_date || '').localeCompare(String(b.test_date || '')));
  past.sort((a, b) => String(b.test_date || '').localeCompare(String(a.test_date || '')));

  return { availableNow, upcoming, past };
}
