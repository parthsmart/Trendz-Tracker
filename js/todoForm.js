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
 * Returns the dynamic field label for `required_count` ("How many per day")
 * based on the selected task section:
 * - Basics and Round -> "Rounds per day"
 * - Elements -> "Sets per day"
 * - Flash Anzan -> "Tries per day"
 * - Memoriad -> "Rounds per day"
 *
 * @param {string} section
 * @returns {string}
 */
export function requiredCountLabelForSection(section) {
  const sec = trimText(section).toLowerCase();
  if (sec === 'basics' || sec === 'round' || sec === 'memoriad') {
    return 'Rounds per day';
  }
  if (sec === 'elements') {
    return 'Sets per day';
  }
  if (sec === 'flash') {
    return 'Tries per day';
  }
  return 'How many per day';
}

/**
 * Normalizes and validates raw form input for `public.daily_tasks`.
 *
 * @param {object} input - Raw task input ({ title, section, category_id, activity_key, target, level, required_count, active })
 * @param {string} [sectionOverride] - Explicit section string (falls back to `input.section`)
 * @returns {{ value: { title: string, section: string, category_id: string|null, activity_key: string|null, level: string|null, required_count: number, active: boolean } } | { errors: Record<string, string> }}
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

  // Validate required_count: integer 1..50; empty ("" / null / undefined) -> 1
  const rawReqCount = safeInput.required_count;
  let required_count = 1;
  if (
    rawReqCount === undefined ||
    rawReqCount === null ||
    (typeof rawReqCount === 'string' && rawReqCount.trim() === '')
  ) {
    required_count = 1;
  } else if (typeof rawReqCount === 'number') {
    if (!Number.isInteger(rawReqCount) || rawReqCount < 1 || rawReqCount > 50) {
      errors.required_count = 'Must be a whole number from 1 to 50.';
    } else {
      required_count = rawReqCount;
    }
  } else if (typeof rawReqCount === 'string') {
    const trimmedReq = rawReqCount.trim();
    if (!/^\d+$/.test(trimmedReq)) {
      errors.required_count = 'Must be a whole number from 1 to 50.';
    } else {
      const parsedReq = Number(trimmedReq);
      if (!Number.isInteger(parsedReq) || parsedReq < 1 || parsedReq > 50) {
        errors.required_count = 'Must be a whole number from 1 to 50.';
      } else {
        required_count = parsedReq;
      }
    }
  } else {
    errors.required_count = 'Must be a whole number from 1 to 50.';
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
  let flash_digits = null;
  let flash_count = null;
  let flash_speed_ms = null;
  let flash_mode = null;

  if (section === 'basics' || section === 'round') {
    category_id = rawCategoryId.length > 0 ? rawCategoryId : null;
    activity_key = null;
  } else if (section === 'elements' || section === 'memoriad') {
    category_id = null;
    activity_key = rawActivityKey.length > 0 ? rawActivityKey : null;
  } else if (section === 'flash') {
    category_id = null;
    activity_key = null;

    // 1. flash_digits: empty or "any" -> null; otherwise whole number 1..5
    const rawDigits = safeInput.flash_digits;
    if (
      rawDigits === undefined ||
      rawDigits === null ||
      trimText(String(rawDigits)) === '' ||
      trimText(String(rawDigits)).toLowerCase() === 'any'
    ) {
      flash_digits = null;
    } else {
      const strDigits = trimText(String(rawDigits));
      const numDigits = typeof rawDigits === 'number' ? rawDigits : Number(strDigits);
      if (
        typeof rawDigits === 'boolean' ||
        !/^\d+$/.test(strDigits) ||
        !Number.isInteger(numDigits) ||
        numDigits < 1 ||
        numDigits > 5
      ) {
        errors.flash_digits = 'Digits must be a whole number from 1 to 5 (or Any).';
      } else {
        flash_digits = numDigits;
      }
    }

    // 2. flash_count: empty or "any" -> null; otherwise whole number 2..1000
    const rawCount = safeInput.flash_count;
    if (
      rawCount === undefined ||
      rawCount === null ||
      trimText(String(rawCount)) === '' ||
      trimText(String(rawCount)).toLowerCase() === 'any'
    ) {
      flash_count = null;
    } else {
      const strCount = trimText(String(rawCount));
      const numCount = typeof rawCount === 'number' ? rawCount : Number(strCount);
      if (
        typeof rawCount === 'boolean' ||
        !/^\d+$/.test(strCount) ||
        !Number.isInteger(numCount) ||
        numCount < 2 ||
        numCount > 1000
      ) {
        errors.flash_count = 'Numbers in the question must be a whole number from 2 to 1000 (or empty for Any).';
      } else {
        flash_count = numCount;
      }
    }

    // 3. flash_speed_ms: input in seconds (0.2 to 5.0 in steps of 0.1), stored as milliseconds (200 to 5000)
    const rawSpeed =
      safeInput.flash_speed_ms !== undefined
        ? safeInput.flash_speed_ms
        : safeInput.flash_speed_seconds;
    if (
      rawSpeed === undefined ||
      rawSpeed === null ||
      trimText(String(rawSpeed)) === '' ||
      trimText(String(rawSpeed)).toLowerCase() === 'any'
    ) {
      flash_speed_ms = null;
    } else {
      const strSpeed = trimText(String(rawSpeed));
      const sec = typeof rawSpeed === 'number' ? rawSpeed : Number(strSpeed);
      const tenths = Math.round(sec * 10);
      if (
        typeof rawSpeed === 'boolean' ||
        !/^\d+(\.\d+)?$/.test(strSpeed) ||
        !Number.isFinite(sec) ||
        Math.abs(sec * 10 - tenths) > 1e-6 ||
        tenths < 2 ||
        tenths > 50
      ) {
        errors.flash_speed_ms = 'Speed per number must be from 0.2 to 5.0 seconds in steps of 0.1 (or empty for Any).';
      } else {
        flash_speed_ms = tenths * 100;
      }
    }

    // 4. flash_mode: empty or "any" -> null; otherwise 'add' or 'add_sub'
    const rawMode = safeInput.flash_mode;
    if (
      rawMode === undefined ||
      rawMode === null ||
      trimText(String(rawMode)) === '' ||
      trimText(String(rawMode)).toLowerCase() === 'any'
    ) {
      flash_mode = null;
    } else {
      const cleanMode = trimText(String(rawMode)).toLowerCase();
      if (cleanMode !== 'add' && cleanMode !== 'add_sub') {
        errors.flash_mode = 'Mode must be Add only, Add and subtract, or Any.';
      } else {
        flash_mode = cleanMode;
      }
    }
  } else {
    // invalid section: clear all targets
    category_id = null;
    activity_key = null;
  }

  // duration_seconds: empty / "any" / "default" -> null; otherwise integer 5..3600
  let duration_seconds = null;
  const rawDuration = safeInput.duration_seconds;
  const hasDuration =
    rawDuration !== undefined &&
    rawDuration !== null &&
    trimText(String(rawDuration)) !== '' &&
    trimText(String(rawDuration)).toLowerCase() !== 'default' &&
    trimText(String(rawDuration)).toLowerCase() !== 'any';

  if (section === 'flash') {
    if (hasDuration) {
      errors.duration_seconds =
        'Flash Anzan duration is determined by its number count and speed interval (t = count × speed) and cannot use an arbitrary duration.';
    }
    duration_seconds = null;
  } else if (hasDuration) {
    const strDuration = trimText(String(rawDuration));
    const numDuration = typeof rawDuration === 'number' ? rawDuration : Number(strDuration);
    if (
      typeof rawDuration === 'boolean' ||
      !/^\d+$/.test(strDuration) ||
      !Number.isInteger(numDuration) ||
      numDuration < 5 ||
      numDuration > 3600
    ) {
      errors.duration_seconds =
        'Duration must be a whole number between 5 and 3600 seconds (or empty for default).';
    } else {
      duration_seconds = numDuration;
    }
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
      flash_digits,
      flash_count,
      flash_speed_ms,
      flash_mode,
      duration_seconds,
      level,
      required_count,
      active,
    },
  };
}

/**
 * Formats a human-readable summary of a Flash Anzan task's fixed settings.
 * Returns text such as `"1 digit, 50 numbers, 0.5 s, add only"` or `"Any flash anzan try"`.
 *
 * @param {object} task
 * @returns {string}
 */
export function flashSummary(task = {}) {
  const safeTask = task && typeof task === 'object' ? task : {};
  const parts = [];

  const rawDigits =
    safeTask.flash_digits !== undefined
      ? safeTask.flash_digits
      : safeTask.task_flash_digits !== undefined
        ? safeTask.task_flash_digits
        : safeTask.digits;
  if (rawDigits !== null && rawDigits !== undefined && trimText(String(rawDigits)) !== '') {
    const d = Number(rawDigits);
    if (Number.isInteger(d) && d >= 1 && d <= 5) {
      parts.push(d === 1 ? '1 digit' : `${d} digits`);
    }
  }

  const rawCount =
    safeTask.flash_count !== undefined
      ? safeTask.flash_count
      : safeTask.task_flash_count !== undefined
        ? safeTask.task_flash_count
        : safeTask.count;
  if (rawCount !== null && rawCount !== undefined && trimText(String(rawCount)) !== '') {
    const c = Number(rawCount);
    if (Number.isInteger(c) && c >= 2 && c <= 1000) {
      parts.push(`${c} numbers`);
    }
  }

  const rawSpeedMs =
    safeTask.flash_speed_ms !== undefined
      ? safeTask.flash_speed_ms
      : safeTask.task_flash_speed_ms !== undefined
        ? safeTask.task_flash_speed_ms
        : safeTask.speed_ms !== undefined
          ? safeTask.speed_ms
          : safeTask.speed;
  if (rawSpeedMs !== null && rawSpeedMs !== undefined && trimText(String(rawSpeedMs)) !== '') {
    const ms = Number(rawSpeedMs);
    if (Number.isInteger(ms) && ms >= 200 && ms <= 5000 && ms % 100 === 0) {
      parts.push(`${(ms / 1000).toFixed(1)} s`);
    }
  }

  const rawMode =
    safeTask.flash_mode !== undefined
      ? safeTask.flash_mode
      : safeTask.task_flash_mode !== undefined
        ? safeTask.task_flash_mode
        : safeTask.mode;
  if (rawMode !== null && rawMode !== undefined && trimText(String(rawMode)) !== '') {
    const m = trimText(String(rawMode)).toLowerCase();
    if (m === 'add') {
      parts.push('add only');
    } else if (m === 'add_sub') {
      parts.push('add and subtract');
    }
  }

  if (parts.length === 0) {
    return 'Any flash anzan try';
  }
  return parts.join(', ');
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
 * - `flash` -> `/pages/flash.html?task=1` plus any set parameters (`digits`, `count`, `speed`, `mode`)
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

  const taskId = trimText(
    safeTask.id !== undefined && safeTask.id !== null
      ? String(safeTask.id)
      : safeTask.task_id !== undefined && safeTask.task_id !== null
        ? String(safeTask.task_id)
        : ''
  );
  const taskQuery = taskId ? `&todo_task_id=${encodeURIComponent(taskId)}` : '';

  if (section === 'basics') {
    return categoryId
      ? `/pages/basics.html?cat=${encodeURIComponent(categoryId)}${taskQuery}`
      : `/pages/basics.html${taskId ? `?todo_task_id=${encodeURIComponent(taskId)}` : ''}`;
  }

  if (section === 'round') {
    return '/pages/round-scores.html';
  }

  if (section === 'elements') {
    return activityKey
      ? `/pages/element-drill.html?drill=${encodeURIComponent(activityKey)}${taskQuery}`
      : `/pages/elements.html${taskId ? `?todo_task_id=${encodeURIComponent(taskId)}` : ''}`;
  }

  if (section === 'memoriad') {
    return activityKey
      ? `/pages/memoriad-play.html?module=${encodeURIComponent(activityKey)}${taskQuery}`
      : `/pages/memoriad.html${taskId ? `?todo_task_id=${encodeURIComponent(taskId)}` : ''}`;
  }

  if (section === 'flash') {
    const queryParts = ['task=1'];
    if (taskId) {
      queryParts.push(`todo_task_id=${encodeURIComponent(taskId)}`);
    }

    const rawDigits =
      safeTask.flash_digits !== undefined ? safeTask.flash_digits : safeTask.task_flash_digits;
    if (rawDigits !== null && rawDigits !== undefined && trimText(String(rawDigits)) !== '') {
      const d = Number(rawDigits);
      if (Number.isInteger(d) && d >= 1 && d <= 5) {
        queryParts.push(`digits=${encodeURIComponent(String(d))}`);
      }
    }

    const rawCount =
      safeTask.flash_count !== undefined ? safeTask.flash_count : safeTask.task_flash_count;
    if (rawCount !== null && rawCount !== undefined && trimText(String(rawCount)) !== '') {
      const c = Number(rawCount);
      if (Number.isInteger(c) && c >= 2 && c <= 1000) {
        queryParts.push(`count=${encodeURIComponent(String(c))}`);
      }
    }

    const rawSpeedMs =
      safeTask.flash_speed_ms !== undefined
        ? safeTask.flash_speed_ms
        : safeTask.task_flash_speed_ms;
    if (rawSpeedMs !== null && rawSpeedMs !== undefined && trimText(String(rawSpeedMs)) !== '') {
      const ms = Number(rawSpeedMs);
      if (Number.isInteger(ms) && ms >= 200 && ms <= 5000 && ms % 100 === 0) {
        queryParts.push(`speed=${encodeURIComponent(String(ms))}`);
      }
    }

    const rawMode =
      safeTask.flash_mode !== undefined ? safeTask.flash_mode : safeTask.task_flash_mode;
    if (rawMode !== null && rawMode !== undefined && trimText(String(rawMode)) !== '') {
      const m = trimText(String(rawMode)).toLowerCase();
      if (m === 'add' || m === 'add_sub') {
        queryParts.push(`mode=${encodeURIComponent(m)}`);
      }
    }

    return `/pages/flash.html?${queryParts.join('&')}`;
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

  if (section === 'flash') {
    const text = flashSummary(safeTask);
    return { text, isAny: text === 'Any flash anzan try' };
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
