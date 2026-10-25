/**
 * Trendz Tracker — Pure Admin Profile Form, Level Suggestion & Audit Diff Logic (js/profileForm.js)
 *
 * Pure, DOM-free and network-free helpers for Phase 10c:
 * 1. `normalizeProfileInput(input)`:
 *    - Trims `full_name` (2 to 60 characters, required) and `level` (1 to 30 characters, or empty -> `null`).
 *    - Normalizes `active` and `leaderboard_visible` to booleans.
 *    - Never outputs `student_code` or `role` (enforced by database trigger as well).
 *    - Returns `{ value }` or `{ errors: { field: message } }`.
 * 2. `suggestLevel(levels, typed)`:
 *    - When `typed` (trimmed) matches an existing level in `levels` except for upper/lower case
 *      (e.g. `'junior 1'` vs `'Junior 1'`), returns the canonical existing level (`'Junior 1'`).
 *    - Returns `null` when `typed` is empty, already matches exact case, or has no case-insensitive match.
 * 3. `diffProfileFields(original, nextValue)`:
 *    - Returns an object with only the fields among `full_name`, `level`, `active`, `leaderboard_visible`
 *      that actually changed, for a single minimal `UPDATE` on `public.profiles`.
 * 4. `formatProfileAuditChanges(auditRow)`:
 *    - Formats `old_values` -> `new_values` from `public.profile_audit` into `{ field, label, oldText, newText }[]`.
 */

export const PROFILE_NAME_MIN_LENGTH = 2;
export const PROFILE_NAME_MAX_LENGTH = 60;
export const PROFILE_LEVEL_MIN_LENGTH = 1;
export const PROFILE_LEVEL_MAX_LENGTH = 30;

function trimText(val) {
  if (typeof val !== 'string') return '';
  return val.trim();
}

/**
 * Normalizes and validates editable student profile fields.
 *
 * @param {object} input - `{ full_name, level, active, leaderboard_visible }`
 * @returns {{ value: { full_name: string, level: string|null, active: boolean, leaderboard_visible: boolean } } | { errors: Record<string, string> }}
 */
export function normalizeProfileInput(input = {}) {
  const safe = input && typeof input === 'object' ? input : {};
  const errors = {};

  const full_name = trimText(safe.full_name);
  if (!full_name) {
    errors.full_name = `Full name is required (${PROFILE_NAME_MIN_LENGTH} to ${PROFILE_NAME_MAX_LENGTH} characters).`;
  } else if (full_name.length < PROFILE_NAME_MIN_LENGTH || full_name.length > PROFILE_NAME_MAX_LENGTH) {
    errors.full_name = `Full name must be between ${PROFILE_NAME_MIN_LENGTH} and ${PROFILE_NAME_MAX_LENGTH} characters (currently ${full_name.length}).`;
  }

  const rawLevel = trimText(safe.level);
  let level = null;
  if (rawLevel.length > 0) {
    if (rawLevel.length < PROFILE_LEVEL_MIN_LENGTH || rawLevel.length > PROFILE_LEVEL_MAX_LENGTH) {
      errors.level = `Level must be between ${PROFILE_LEVEL_MIN_LENGTH} and ${PROFILE_LEVEL_MAX_LENGTH} characters (currently ${rawLevel.length}).`;
    } else {
      level = rawLevel;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  const active = safe.active === undefined ? true : Boolean(safe.active);
  const leaderboard_visible =
    safe.leaderboard_visible === undefined ? true : Boolean(safe.leaderboard_visible);

  return {
    value: {
      full_name,
      level,
      active,
      leaderboard_visible,
    },
  };
}

/**
 * Checks whether `typed` equals an existing level in `levels` except for upper/lower case.
 *
 * @param {Array<string|null|undefined>} levels - Existing levels from student profiles
 * @param {string|null|undefined} typed - Current text in the level input
 * @returns {string|null} The existing level string if it differs only by case, or `null`
 */
export function suggestLevel(levels = [], typed = '') {
  const cleanTyped = trimText(typed);
  if (!cleanTyped || !Array.isArray(levels)) {
    return null;
  }

  const lowerTyped = cleanTyped.toLowerCase();
  const uniqueLevels = [];
  const seenExact = new Set();

  for (const item of levels) {
    const clean = trimText(item);
    if (clean && !seenExact.has(clean)) {
      seenExact.add(clean);
      uniqueLevels.push(clean);
    }
  }

  // If the typed string already matches an existing level with exact casing, no suggestion is needed
  if (seenExact.has(cleanTyped)) {
    return null;
  }

  const match = uniqueLevels.find((lvl) => lvl.toLowerCase() === lowerTyped && lvl !== cleanTyped);
  return match || null;
}

/**
 * Extracts distinct non-empty sorted levels from an array of student profiles or level strings.
 *
 * @param {Array<object|string>} items
 * @returns {string[]}
 */
export function collectExistingLevels(items = []) {
  if (!Array.isArray(items)) return [];
  const seenLower = new Set();
  const result = [];

  for (const item of items) {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object' ? item.level : '';
    const clean = trimText(raw);
    const lower = clean.toLowerCase();
    if (clean && !seenLower.has(lower)) {
      seenLower.add(lower);
      result.push(clean);
    }
  }

  return result.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Computes the minimal object of changed fields between `originalProfile` and normalized `nextValue`.
 *
 * @param {object} originalProfile
 * @param {{ full_name: string, level: string|null, active: boolean, leaderboard_visible: boolean }} nextValue
 * @returns { Partial<{ full_name: string, level: string|null, active: boolean, leaderboard_visible: boolean }> }
 */
export function diffProfileFields(originalProfile = {}, nextValue = {}) {
  const orig = originalProfile && typeof originalProfile === 'object' ? originalProfile : {};
  const origName = trimText(orig.full_name);
  const origLevel = trimText(orig.level) || null;
  const origActive = orig.active !== false;
  const origVisible = orig.leaderboard_visible !== false;

  const updates = {};

  if (nextValue.full_name !== undefined && nextValue.full_name !== origName) {
    updates.full_name = nextValue.full_name;
  }
  if (nextValue.level !== undefined && (nextValue.level || null) !== origLevel) {
    updates.level = nextValue.level || null;
  }
  if (nextValue.active !== undefined && Boolean(nextValue.active) !== origActive) {
    updates.active = Boolean(nextValue.active);
  }
  if (
    nextValue.leaderboard_visible !== undefined &&
    Boolean(nextValue.leaderboard_visible) !== origVisible
  ) {
    updates.leaderboard_visible = Boolean(nextValue.leaderboard_visible);
  }

  return updates;
}

const AUDIT_FIELD_LABELS = Object.freeze({
  full_name: 'Full Name',
  level: 'Level',
  leaderboard_visible: 'Show on leaderboards',
  active: 'Active',
});

function formatAuditValue(field, val) {
  if (field === 'active') {
    if (val === true) return 'Active';
    if (val === false) return 'Inactive';
  }
  if (field === 'leaderboard_visible') {
    if (val === true) return 'Shown';
    if (val === false) return 'Hidden';
  }
  if (val === null || val === undefined || val === '') {
    return field === 'level' ? 'None (All levels)' : 'None';
  }
  return String(val);
}

/**
 * Formats a `profile_audit` row (`{ old_values, new_values }`) or `(oldValues, newValues)` into an array of field changes.
 *
 * @param {Record<string, any>} firstArg - Either `{ old_values, new_values }` or `oldValues`
 * @param {Record<string, any>} [secondArg] - Optional `newValues` when called with two arguments
 * @returns {Array<{ field: string, label: string, oldDisplay: string, newDisplay: string }>}
 */
export function formatProfileAuditChanges(firstArg = {}, secondArg = undefined) {
  let oldVals = {};
  let newVals = {};

  if (secondArg !== undefined) {
    oldVals = firstArg && typeof firstArg === 'object' ? firstArg : {};
    newVals = secondArg && typeof secondArg === 'object' ? secondArg : {};
  } else {
    oldVals =
      firstArg && firstArg.old_values && typeof firstArg.old_values === 'object'
        ? firstArg.old_values
        : {};
    newVals =
      firstArg && firstArg.new_values && typeof firstArg.new_values === 'object'
        ? firstArg.new_values
        : {};
  }

  const orderedFields = ['full_name', 'level', 'leaderboard_visible', 'active'];
  const extraFields = Object.keys({ ...oldVals, ...newVals }).filter(
    (k) => !orderedFields.includes(k)
  );
  const allFields = [...orderedFields, ...extraFields];

  const changes = [];
  for (const field of allFields) {
    const hasOld = Object.prototype.hasOwnProperty.call(oldVals, field);
    const hasNew = Object.prototype.hasOwnProperty.call(newVals, field);
    if (!hasOld && !hasNew) continue;

    const oldV = oldVals[field];
    const newV = newVals[field];
    if (oldV === newV) continue;

    const oldFormatted = formatAuditValue(field, oldV);
    const newFormatted = formatAuditValue(field, newV);

    changes.push({
      field,
      label: AUDIT_FIELD_LABELS[field] || field,
      oldDisplay: oldFormatted,
      newDisplay: newFormatted,
    });
  }

  return changes;
}

