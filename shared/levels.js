/**
 * Trendz Tracker: the one list of student levels (shared/levels.js)
 *
 * Every level dropdown, filter, import and validation reads from here, so the
 * list only ever exists once and always shows in this order.
 *
 * Staff accounts keep the special levels 'Teacher' and 'Admin', which are
 * never offered for students.
 *
 * The same list is enforced by the `profiles_level_allowed` check constraint
 * (supabase/migrations/21_standard_student_levels.sql). Keep both in sync.
 */

export const STUDENT_LEVELS = Object.freeze([
  'KA-1',
  'KA-2',
  'KA-3',
  'Level 1',
  'Level 2',
  'Level 3',
  'Level 4',
  'Level 5',
  'Level 6',
  'Graduate',
  'Master',
  'Grandmaster',
]);

export const STAFF_LEVELS = Object.freeze(['Teacher', 'Admin']);

function squash(value) {
  return String(value).toLowerCase().replace(/[\s_\-.]+/g, '');
}

const ALIASES = new Map();
for (const level of [...STUDENT_LEVELS, ...STAFF_LEVELS]) {
  ALIASES.set(squash(level), level);
}
// Friendly spellings people type in forms and spreadsheets.
for (let n = 1; n <= 3; n += 1) {
  ALIASES.set(`ka${n}`, `KA-${n}`);
}
for (let n = 1; n <= 6; n += 1) {
  ALIASES.set(`l${n}`, `Level ${n}`);
  ALIASES.set(`lvl${n}`, `Level ${n}`);
  // A bare number means "Level N" (approved mapping for the old value '2').
  ALIASES.set(String(n), `Level ${n}`);
}
ALIASES.set('grad', 'Graduate');

/**
 * Returns the canonical level for `raw`, or `null` when it is blank or not a
 * recognised level. Matching ignores case, spaces, hyphens and underscores, so
 * 'ka 1', 'KA1' and 'Ka-1' all give 'KA-1'.
 *
 * @param {unknown} raw
 * @param {{ allowStaff?: boolean }} [options]
 * @returns {string|null}
 */
export function normalizeLevel(raw, { allowStaff = false } = {}) {
  if (raw === null || raw === undefined) return null;
  const key = squash(raw);
  if (!key) return null;
  const match = ALIASES.get(key) || null;
  if (match && !allowStaff && STAFF_LEVELS.includes(match)) return null;
  return match;
}

/**
 * Upgrades a level saved before the standard list (Nov 2026) to the new list, using
 * the mapping the owner approved. Same rules as migration 21, so restoring an old
 * backup gives the same result as the live migration did:
 * - staff (teacher/admin) keep 'Teacher' / 'Admin' (or blank);
 * - a student with 'Teacher' becomes 'Level 1' (the TEACH_01–04 accounts);
 * - recognised spellings become canonical ('2' → 'Level 2', 'ka1' → 'KA-1');
 * - anything else (e.g. 'Junior 1', 'Junior 2') becomes blank, to be set by hand.
 *
 * @param {unknown} level
 * @param {string} [role]
 * @returns {string|null}
 */
export function upgradeLegacyLevel(level, role = 'student') {
  if (role === 'teacher' || role === 'admin') {
    return normalizeLevel(level, { allowStaff: true });
  }
  const staff = normalizeLevel(level, { allowStaff: true });
  if (staff === 'Teacher') return 'Level 1';
  return normalizeLevel(level);
}

/** True when `value` is exactly one of STUDENT_LEVELS. */
export function isStudentLevel(value) {
  return typeof value === 'string' && STUDENT_LEVELS.includes(value);
}

/**
 * Validates an optional student level field.
 * Blank → `{ value: null }`. Recognised → `{ value: canonical }`. Otherwise `{ error }`.
 *
 * @param {unknown} raw
 * @param {{ allowStaff?: boolean }} [options]
 * @returns {{ value: string|null } | { error: string }}
 */
export function validateLevel(raw, options = {}) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { value: null };
  }
  const value = normalizeLevel(raw, options);
  if (!value) {
    return { error: `Level must be one of: ${STUDENT_LEVELS.join(', ')}.` };
  }
  return { value };
}

/** Sort position of a level in STUDENT_LEVELS; unknown values sort last. */
export function levelRank(value) {
  const index = STUDENT_LEVELS.indexOf(value);
  return index === -1 ? STUDENT_LEVELS.length : index;
}

/** Sorts levels by their place in STUDENT_LEVELS (unknown values last, alphabetically). */
export function sortLevels(levels = []) {
  return [...levels].sort((a, b) => levelRank(a) - levelRank(b) || String(a).localeCompare(String(b)));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML `<option>` list for a level `<select>`.
 *
 * @param {{ blankLabel?: string|null, blankValue?: string, selected?: string|null }} [options]
 *   blankLabel: text of a first empty option (e.g. 'All levels', 'No level'); null for none.
 */
export function levelOptionsHtml({ blankLabel = null, blankValue = '', selected = null } = {}) {
  const parts = [];
  if (blankLabel !== null) {
    parts.push(`<option value="${escapeHtml(blankValue)}">${escapeHtml(blankLabel)}</option>`);
  }
  for (const level of STUDENT_LEVELS) {
    const sel = level === selected ? ' selected' : '';
    parts.push(`<option value="${escapeHtml(level)}"${sel}>${escapeHtml(level)}</option>`);
  }
  return parts.join('');
}

/** Filter value meaning "students with no level set". */
export const NO_LEVEL_FILTER = '__none__';

/**
 * Options for a level *filter*: "All levels", every level, then "No level".
 *
 * @param {{ allLabel?: string, includeNoLevel?: boolean }} [options]
 */
export function levelFilterOptionsHtml({ allLabel = 'All levels', includeNoLevel = true } = {}) {
  const html = levelOptionsHtml({ blankLabel: allLabel });
  return includeNoLevel
    ? `${html}<option value="${NO_LEVEL_FILTER}">No level</option>`
    : html;
}

/**
 * True when a student's `level` passes a filter value from levelFilterOptionsHtml.
 * '' matches everyone; NO_LEVEL_FILTER matches blank levels.
 */
export function matchesLevelFilter(studentLevel, filterValue) {
  if (!filterValue) return true;
  const clean = typeof studentLevel === 'string' ? studentLevel.trim() : '';
  if (filterValue === NO_LEVEL_FILTER) return clean === '';
  return clean.toLowerCase() === String(filterValue).toLowerCase();
}

/**
 * Fills a `<select>` with the level list, keeping its current value when it is still a level.
 *
 * @param {HTMLSelectElement|null} selectEl
 * @param {{ blankLabel?: string|null, blankValue?: string }} [options]
 */
export function fillLevelSelect(selectEl, options = {}) {
  if (!selectEl) return;
  const current = selectEl.value;
  selectEl.innerHTML = levelOptionsHtml(options);
  const canonical = normalizeLevel(current);
  if (canonical) selectEl.value = canonical;
  else if (options.blankLabel !== undefined && options.blankLabel !== null) {
    selectEl.value = options.blankValue ?? '';
  }
}
