/**
 * Trendz Tracker — Pure Daily To-Do Form, Section Options & Student Link Logic (js/todoForm.js)
 *
 * Pure, DOM-free and network-free functions for:
 * 1. `normalizeTaskInput(input, section)`:
 *    - Trims every text value (`title`, `section`, `category_id`, `activity_key`, `level`).
 *    - Turns empty strings `""` into `null` for `category_id`, `activity_key`, and `level`.
 *    - Validates `title` (required, 1..80 chars) and `level` (optional, max 30 chars).
 *    - Enforces mutually exclusive target fields by section:
 *      - `'basics'` and `'round'` -> `category_id` only (`activity_key = null`).
 *      - `'elements'` and `'memoriad'` -> `activity_key` only (`category_id = null`).
 *      - `'flash'` -> neither (`category_id = null`, `activity_key = null`).
 *      - Never sets both `category_id` and `activity_key`.
 * 2. `optionsForSection(section, categories, drillCatalog, memoriadModules)`:
 *    - Returns `{ value, label }[]` options for the section's optional target dropdown.
 * 3. `taskLink(task)`:
 *    - Computes the exact student-side practice URL for a daily task.
 * 4. `formatTaskTarget(task, categories, drillCatalog, memoriadModules)`:
 *    - Formats the human-readable target label for the Admin Daily To-Do table.
 */

import { DRILL_CATALOG } from './drillCatalog.js';
import { MEMORIAD_TIME_LIMITS } from './memoriadConfig.js';

export const VALID_TASK_SECTIONS = Object.freeze([
  'basics',
  'round',
  'elements',
  'memoriad',
  'flash',
]);

export const TASK_TITLE_MAX_LENGTH = 80;
export const TASK_LEVEL_MAX_LENGTH = 30;

/**
 * The four Memoriad modules derived from `js/memoriadConfig.js` keys with their official titles.
 */
export const MEMORIAD_MODULES = Object.freeze([
  { key: 'calendar', title: 'Mental Calendar Dates' },
  { key: 'additions', title: 'Mental Additions' },
  { key: 'multiplications', title: 'Mental Multiplications' },
  { key: 'square_roots', title: 'Mental Square Roots' },
].filter((m) => Object.prototype.hasOwnProperty.call(MEMORIAD_TIME_LIMITS, m.key)));

export const SECTION_DISPLAY_NAMES = Object.freeze({
  basics: 'Basics',
  round: 'Round',
  elements: 'Elements',
  memoriad: 'Memoriad',
  flash: 'Flash Anzan',
});

/**
 * Trims a value if it is a string; returns `""` for null/undefined/non-string.
 * @param {unknown} val
 * @returns {string}
 */
function trimText(val) {
  if (typeof val !== 'string') return '';
  return val.trim();
}

/**
 * Normalizes and validates raw form input for `public.daily_tasks`.
 *
 * @param {object} input - Raw task input ({ title, section, category_id, activity_key, target, level, active })
 * @param {string} [sectionOverride] - Explicit section string (falls back to `input.section`)
 * @returns {{ value: { title: string, section: string, category_id: string|null, activity_key: string|null, level: string|null, active: boolean } } | { errors: Record<string, string> }}
 */
export function normalizeTaskInput(input = {}, sectionOverride) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const errors = {};

  const rawSection = sectionOverride !== undefined ? sectionOverride : safeInput.section;
  const section = trimText(rawSection).toLowerCase();

  if (!VALID_TASK_SECTIONS.includes(section)) {
    errors.section = 'Select a valid section (basics, round, elements, memoriad, or flash).';
  }

  const title = trimText(safeInput.title);
  if (!title) {
    errors.title = 'Task title is required.';
  } else if (title.length > TASK_TITLE_MAX_LENGTH) {
    errors.title = `Task title must be at most ${TASK_TITLE_MAX_LENGTH} characters (currently ${title.length}).`;
  }

  const rawLevel = trimText(safeInput.level);
  let level = null;
  if (rawLevel.length > 0) {
    if (rawLevel.length > TASK_LEVEL_MAX_LENGTH) {
      errors.level = `Level must be at most ${TASK_LEVEL_MAX_LENGTH} characters (currently ${rawLevel.length}).`;
    } else {
      level = rawLevel;
    }
  }

  // Extract raw target values; empty strings always become null
  const rawCategoryId = trimText(
    safeInput.category_id !== undefined ? safeInput.category_id : safeInput.target
  );
  const rawActivityKey = trimText(
    safeInput.activity_key !== undefined ? safeInput.activity_key : safeInput.target
  );

  let category_id = null;
  let activity_key = null;

  if (section === 'basics' || section === 'round') {
    category_id = rawCategoryId.length > 0 ? rawCategoryId : null;
    activity_key = null;
  } else if (section === 'elements' || section === 'memoriad') {
    category_id = null;
    activity_key = rawActivityKey.length > 0 ? rawActivityKey : null;
  } else {
    // 'flash' or invalid section: neither target is set
    category_id = null;
    activity_key = null;
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  const active = safeInput.active === undefined ? true : Boolean(safeInput.active);

  return {
    value: {
      title,
      section,
      category_id,
      activity_key,
      level,
      active,
    },
  };
}

/**
 * Returns the selectable `{ value, label }` options for a section's optional target filter.
 *
 * - `'basics'` / `'round'`: active categories of that section only (never mixed).
 * - `'elements'`: enabled drills from `js/drillCatalog.js` (`value = drill.key`, `label = drill.title`).
 * - `'memoriad'`: the four modules (`calendar`, `additions`, `multiplications`, `square_roots`).
 * - `'flash'`: `[]` (no options).
 *
 * @param {string} section
 * @param {Array<object>} [categories=[]]
 * @param {Record<string, object>|Array<object>} [drillCatalog=DRILL_CATALOG]
 * @param {Array<{ key?: string, value?: string, title?: string, label?: string }>} [memoriadModules=MEMORIAD_MODULES]
 * @returns {Array<{ value: string, label: string }>}
 */
export function optionsForSection(
  section,
  categories = [],
  drillCatalog = DRILL_CATALOG,
  memoriadModules = MEMORIAD_MODULES
) {
  const sec = trimText(section).toLowerCase();

  if (sec === 'basics' || sec === 'round') {
    if (!Array.isArray(categories)) return [];
    return categories
      .filter((c) => {
        if (!c || typeof c !== 'object') return false;
        const catSec = trimText(c.section).toLowerCase();
        return catSec === sec && c.active !== false && trimText(String(c.id ?? '')).length > 0;
      })
      .map((c) => ({
        value: trimText(String(c.id)),
        label: trimText(String(c.name ?? '')),
      }));
  }

  if (sec === 'elements') {
    const list = Array.isArray(drillCatalog)
      ? drillCatalog
      : drillCatalog && typeof drillCatalog === 'object'
        ? Object.values(drillCatalog)
        : [];
    return list
      .filter((d) => d && typeof d === 'object' && d.enabled === true && trimText(d.key).length > 0)
      .map((d) => ({
        value: trimText(d.key),
        label: trimText(d.title || d.key),
      }));
  }

  if (sec === 'memoriad') {
    if (!Array.isArray(memoriadModules)) return [];
    return memoriadModules
      .filter((m) => m && typeof m === 'object' && trimText(m.key ?? m.value).length > 0)
      .map((m) => ({
        value: trimText(m.key ?? m.value),
        label: trimText(m.title ?? m.label ?? m.key ?? m.value),
      }));
  }

  return [];
}

/**
 * Computes the student-side link for a daily task row (from `daily_tasks` or `todo_for` RPC).
 *
 * Rules:
 * - `basics` with a category -> `/pages/basics.html?cat=<id>`
 * - `basics` without -> `/pages/basics.html`
 * - `round` -> `/pages/round-scores.html`
 * - `elements` with a key -> `/pages/element-drill.html?drill=<key>`
 * - `elements` without -> `/pages/elements.html`
 * - `memoriad` with a key -> `/pages/memoriad-play.html?module=<key>`
 * - `memoriad` without -> `/pages/memoriad.html`
 * - `flash` -> `/pages/flash.html`
 *
 * @param {object} task
 * @returns {string}
 */
export function taskLink(task = {}) {
  const safeTask = task && typeof task === 'object' ? task : {};
  const section = trimText(safeTask.section ?? safeTask.task_section).toLowerCase();
  const categoryId = trimText(
    safeTask.category_id !== undefined && safeTask.category_id !== null
      ? String(safeTask.category_id)
      : safeTask.task_category_id !== undefined && safeTask.task_category_id !== null
        ? String(safeTask.task_category_id)
        : ''
  );
  const activityKey = trimText(
    safeTask.activity_key !== undefined && safeTask.activity_key !== null
      ? String(safeTask.activity_key)
      : safeTask.task_activity_key !== undefined && safeTask.task_activity_key !== null
        ? String(safeTask.task_activity_key)
        : ''
  );

  if (section === 'basics') {
    return categoryId
      ? `/pages/basics.html?cat=${encodeURIComponent(categoryId)}`
      : '/pages/basics.html';
  }

  if (section === 'round') {
    return '/pages/round-scores.html';
  }

  if (section === 'elements') {
    return activityKey
      ? `/pages/element-drill.html?drill=${encodeURIComponent(activityKey)}`
      : '/pages/elements.html';
  }

  if (section === 'memoriad') {
    return activityKey
      ? `/pages/memoriad-play.html?module=${encodeURIComponent(activityKey)}`
      : '/pages/memoriad.html';
  }

  if (section === 'flash') {
    return '/pages/flash.html';
  }

  return '/pages/student.html';
}

/**
 * Resolves the human-readable target description for an Admin Daily To-Do row.
 * Never returns `"Unknown Category"` when a task has no specific category or activity.
 *
 * @param {object} task
 * @param {Array<object>} [categories=[]]
 * @param {Record<string, object>|Array<object>} [drillCatalog=DRILL_CATALOG]
 * @param {Array<object>} [memoriadModules=MEMORIAD_MODULES]
 * @returns {{ text: string, isAny: boolean }}
 */
export function formatTaskTarget(
  task = {},
  categories = [],
  drillCatalog = DRILL_CATALOG,
  memoriadModules = MEMORIAD_MODULES
) {
  const safeTask = task && typeof task === 'object' ? task : {};
  const section = trimText(safeTask.section ?? safeTask.task_section).toLowerCase();
  const sectionTitle = SECTION_DISPLAY_NAMES[section] || section || 'section';

  const categoryId = trimText(
    safeTask.category_id !== undefined && safeTask.category_id !== null
      ? String(safeTask.category_id)
      : safeTask.task_category_id !== undefined && safeTask.task_category_id !== null
        ? String(safeTask.task_category_id)
        : ''
  );
  const activityKey = trimText(
    safeTask.activity_key !== undefined && safeTask.activity_key !== null
      ? String(safeTask.activity_key)
      : safeTask.task_activity_key !== undefined && safeTask.task_activity_key !== null
        ? String(safeTask.task_activity_key)
        : ''
  );

  if (section === 'basics' || section === 'round') {
    if (!categoryId) {
      return { text: `Any activity in ${sectionTitle}`, isAny: true };
    }
    const matched = Array.isArray(categories)
      ? categories.find((c) => c && String(c.id) === categoryId)
      : null;
    if (matched && trimText(matched.name)) {
      return { text: trimText(matched.name), isAny: false };
    }
    return { text: `Any activity in ${sectionTitle}`, isAny: true };
  }

  if (section === 'elements') {
    if (!activityKey) {
      return { text: 'Any activity in Elements', isAny: true };
    }
    const list = Array.isArray(drillCatalog)
      ? drillCatalog
      : drillCatalog && typeof drillCatalog === 'object'
        ? Object.values(drillCatalog)
        : [];
    const matched = list.find(
      (d) => d && trimText(d.key) === activityKey && d.enabled !== false
    );
    if (matched && trimText(matched.title)) {
      return { text: trimText(matched.title), isAny: false };
    }
    return { text: 'Activity no longer available', isAny: false, unavailable: true };
  }

  if (section === 'memoriad') {
    if (!activityKey) {
      return { text: 'Any activity in Memoriad', isAny: true };
    }
    const matched = Array.isArray(memoriadModules)
      ? memoriadModules.find((m) => m && trimText(m.key ?? m.value) === activityKey)
      : null;
    if (matched && trimText(matched.title ?? matched.label)) {
      return { text: trimText(matched.title ?? matched.label), isAny: false };
    }
    return { text: 'Activity no longer available', isAny: false, unavailable: true };
  }

  return { text: `Any activity in ${sectionTitle}`, isAny: true };
}

/**
 * Returns false when a task points to a specific `activity_key` that has been
 * removed from the catalog, true otherwise.
 *
 * @param {object} task
 * @param {Array<object>} [categories=[]]
 * @param {Record<string, object>|Array<object>} [drillCatalog=DRILL_CATALOG]
 * @param {Array<object>} [memoriadModules=MEMORIAD_MODULES]
 * @returns {boolean}
 */
export function isTaskActivityAvailable(
  task = {},
  categories = [],
  drillCatalog = DRILL_CATALOG,
  memoriadModules = MEMORIAD_MODULES
) {
  const target = formatTaskTarget(task, categories, drillCatalog, memoriadModules);
  return !target.unavailable;
}
