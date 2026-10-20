/**
 * Trendz Tracker — Pure Memoriad Statistics & History Helpers (js/memoriadStats.js)
 *
 * Pure, DOM-free functions for `/pages/memoriad.html` and `js/memoriadCard.js`:
 * - Best score per module: highest `correct` first, then higher accuracy (`correct / total`),
 *   then shorter time (`used_seconds` or `time_seconds`).
 * - For `calendar`, also groups best scores by `settings.dates` (`25, 50, 75, 100, 125`).
 * - Last 5 tries per module (sorted newest first, with date formatted in Indian Standard Time).
 * - Tries this week in Indian Standard Time (`Asia/Kolkata`, last 7 days inclusive of today IST).
 */

export const MEMORIAD_MODULE_CATALOG = [
  {
    key: 'calendar',
    title: 'Mental Calendar Dates',
    subtitle: 'Identify the weekday (Monday–Sunday) for Gregorian dates between 1600 and 2099.',
    badge: '25 to 125 Dates',
    available: true,
  },
  {
    key: 'additions',
    title: 'Mental Additions',
    subtitle: '10 questions of ten 10-digit numbers with column-step highlighting and slot entry.',
    badge: '10 × (10 × 10d)',
    available: true,
  },
  {
    key: 'multiplications',
    title: 'Mental Multiplications',
    subtitle: 'High-precision multi-digit mental multiplication under competition conditions.',
    badge: 'Coming soon',
    available: false,
  },
  {
    key: 'square_roots',
    title: 'Mental Square Roots',
    subtitle: 'Competition square root extraction with decimal precision.',
    badge: 'Coming soon',
    available: false,
  },
];

/**
 * Converts a Date or ISO timestamp into `YYYY-MM-DD` in Indian Standard Time (`Asia/Kolkata`).
 * @param {string | Date | number | null | undefined} input
 * @returns {string}
 */
export function toIstDateString(input) {
  if (!input) return '';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value || '';
  const m = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  return y && m && day ? `${y}-${m}-${day}` : '';
}

/**
 * Formats an ISO timestamp or YYYY-MM-DD string into a readable IST date (e.g. `20 Oct 2026`).
 * @param {string | Date | null | undefined} input
 * @returns {string}
 */
export function formatIstShortDate(input) {
  const ymd = toIstDateString(input);
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[(m || 1) - 1] || ''} ${y}`;
}

/**
 * Infers the module key (`'calendar'` or `'additions'`) from an `activity_results` row.
 * @param {object} row
 * @returns {string | null}
 */
export function resolveRowModule(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.activity_type && row.activity_type !== 'memoriad') return null;

  if (typeof row.module === 'string' && row.module.trim()) {
    return row.module.trim().toLowerCase();
  }

  const fromSettings = row.settings?.module;
  if (typeof fromSettings === 'string' && fromSettings.trim()) {
    return fromSettings.trim().toLowerCase();
  }

  const name = String(row.activity_name || '').toLowerCase();
  if (name.includes('calendar')) return 'calendar';
  if (name.includes('addition')) return 'additions';
  if (name.includes('multiplication')) return 'multiplications';
  if (name.includes('root')) return 'square_roots';
  return null;
}

/**
 * Normalises a raw `activity_results` row into a consistent Memoriad attempt summary.
 * @param {object} row
 */
export function normalizeMemoriadRow(row) {
  const moduleKey = resolveRowModule(row);
  const correct = Number(row?.settings?.correct ?? row?.correct) || 0;
  const attempted = Number(row?.settings?.attempted ?? row?.total) || 0;
  const score = Number(row?.settings?.score ?? correct) || 0;
  const usedSeconds =
    row?.settings?.used_seconds !== undefined && row?.settings?.used_seconds !== null
      ? Number(row.settings.used_seconds)
      : Number(row?.time_seconds) || 0;
  const dates =
    moduleKey === 'calendar'
      ? Number(row?.settings?.dates || row?.settings?.questions || 125)
      : null;
  const questions = Number(row?.settings?.questions) || (moduleKey === 'calendar' ? dates : 10);
  const accuracy = attempted > 0 ? correct / attempted : 0;
  const createdAt = row?.created_at || row?.entry_date || null;
  const dateIst = toIstDateString(createdAt);

  return {
    id: row?.id || null,
    module: moduleKey,
    correct,
    attempted,
    score,
    used_seconds: Number(usedSeconds.toFixed(2)),
    time_seconds: Number(row?.time_seconds ?? Math.round(usedSeconds)),
    dates,
    questions,
    accuracy,
    created_at: createdAt,
    date_ist: dateIst,
    date_display: formatIstShortDate(createdAt),
  };
}

/**
 * Compares two normalized Memoriad attempts to determine which is better:
 * 1. Higher `correct`
 * 2. Higher `accuracy` (`correct / attempted`)
 * 3. Shorter `used_seconds`
 * Returns < 0 if `a` is better than `b`, > 0 if `b` is better than `a`, 0 if tied.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareMemoriadAttempts(a, b) {
  if (b.correct !== a.correct) {
    return b.correct - a.correct;
  }
  if (Math.abs(b.accuracy - a.accuracy) > 1e-9) {
    return b.accuracy - a.accuracy;
  }
  return a.used_seconds - b.used_seconds;
}

/**
 * Picks the best attempt from an array of normalized or raw rows.
 * @param {Array<object>} rows
 * @returns {object | null}
 */
export function pickBestAttempt(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = rows
    .map((r) => (r && r.used_seconds !== undefined && r.accuracy !== undefined ? r : normalizeMemoriadRow(r)))
    .filter((r) => r.attempted > 0);
  if (normalized.length === 0) return null;

  const sorted = normalized.slice().sort(compareMemoriadAttempts);
  return sorted[0] || null;
}

/**
 * Returns rows whose IST date falls within the 7-day window `[todayIst - 6 days .. todayIst]`.
 * @param {Array<object>} rows
 * @param {string | Date} [todayIstInput=new Date()]
 * @returns {Array<object>}
 */
export function memoriadTriesThisWeek(rows, todayIstInput = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const todayStr = toIstDateString(todayIstInput) || toIstDateString(new Date());
  if (!todayStr) return [];

  const [y, m, d] = todayStr.split('-').map(Number);
  const endUtc = Date.UTC(y, m - 1, d);
  const startUtc = endUtc - 6 * 24 * 60 * 60 * 1000;
  const startDate = new Date(startUtc);
  const startStr = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(startDate.getUTCDate()).padStart(2, '0')}`;

  return rows.filter((row) => {
    const mod = resolveRowModule(row);
    if (!mod) return false;
    const rowDate = row.date_ist || toIstDateString(row.created_at || row.entry_date);
    return rowDate >= startStr && rowDate <= todayStr;
  });
}

/**
 * Summarizes a single Memoriad module (`'calendar'` or `'additions'`) from `activity_results` rows:
 * - `best`: overall best attempt for the module
 * - `bestByDates`: for `'calendar'`, map `{ 25: best|null, 50: ..., 75: ..., 100: ..., 125: ... }`
 * - `lastFive`: up to 5 most recent tries sorted newest first
 * - `triesThisWeek`: count of tries in the last 7 days in IST
 * - `totalTries`: total count of tries for this module
 *
 * @param {Array<object>} rows
 * @param {string} moduleKey
 * @param {string | Date} [todayIstInput=new Date()]
 */
export function summarizeMemoriadModule(rows, moduleKey, todayIstInput = new Date()) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const matching = safeRows
    .filter((r) => resolveRowModule(r) === moduleKey)
    .map(normalizeMemoriadRow)
    .filter((r) => r.attempted > 0);

  // Sort newest first by created_at (fallback to array order)
  const chronologicalDesc = matching.slice().sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  const best = pickBestAttempt(matching);
  const lastFive = chronologicalDesc.slice(0, 5);
  const weekRows = memoriadTriesThisWeek(matching, todayIstInput);

  let bestByDates = null;
  if (moduleKey === 'calendar') {
    bestByDates = {};
    for (const dateCount of [25, 50, 75, 100, 125]) {
      const subset = matching.filter((r) => Number(r.dates) === dateCount);
      bestByDates[dateCount] = pickBestAttempt(subset);
    }
  }

  return {
    module: moduleKey,
    totalTries: matching.length,
    triesThisWeek: weekRows.length,
    best,
    bestByDates,
    lastFive,
  };
}

/**
 * Summarizes all Memoriad modules for `/pages/memoriad.html` and the dashboard card.
 * @param {Array<object>} rows
 * @param {string | Date} [todayIstInput=new Date()]
 */
export function summarizeAllMemoriad(rows, todayIstInput = new Date()) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const memoriadRows = safeRows.filter(
    (r) => (!r?.activity_type || r.activity_type === 'memoriad') && resolveRowModule(r) !== null
  );
  const weekRows = memoriadTriesThisWeek(memoriadRows, todayIstInput);

  return {
    triesThisWeek: weekRows.length,
    totalTries: memoriadRows.length,
    modules: {
      calendar: summarizeMemoriadModule(memoriadRows, 'calendar', todayIstInput),
      additions: summarizeMemoriadModule(memoriadRows, 'additions', todayIstInput),
      multiplications: summarizeMemoriadModule(memoriadRows, 'multiplications', todayIstInput),
      square_roots: summarizeMemoriadModule(memoriadRows, 'square_roots', todayIstInput),
    },
  };
}
