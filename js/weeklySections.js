/**
 * Pure helpers for Weekly Test sections of every kind (Phase 16a).
 *
 * Intent:
 * - Centralize validation, human-readable summaries, and database row shaping
 *   for weekly test sections ('basics', 'flash', 'elements', 'memoriad', 'round').
 * - Convert flash speed between seconds (0.2-5.0 s) and integer milliseconds
 *   (200-5000 ms) without floating-point rounding drift.
 * - Keep zero DOM or network dependencies so these helpers are unit-testable
 *   under `node --test` and reusable across Admin Weekly Tests, Student Weekly Test,
 *   and Demo Mode.
 */

import { DRILL_CATALOG, DRILL_CATALOG_LIST } from './drillCatalog.js';
import { isBasicsOnlineAvailable } from './basicsSupport.js';

export const SECTION_KINDS = Object.freeze([
  'basics',
  'flash',
  'elements',
  'memoriad',
  'round'
]);

export const BASICS_ALLOWED_SECONDS = Object.freeze([30, 60, 120, 300]);

export const FLASH_MODES = Object.freeze(['add', 'add_sub']);

export const MEMORIAD_MODULES = Object.freeze([
  { key: 'calendar', title: 'Mental Calendar Dates' },
  { key: 'additions', title: 'Mental Additions' },
  { key: 'multiplications', title: 'Mental Multiplications' },
  { key: 'square_roots', title: 'Mental Square Roots' }
]);

export const MEMORIAD_MODULE_MAP = Object.freeze(
  Object.fromEntries(MEMORIAD_MODULES.map((m) => [m.key, m]))
);

/**
 * Returns a short human-readable label for a section kind.
 * @param {string} kind
 * @returns {string}
 */
export function sectionKindLabel(kind) {
  const k = String(kind || 'basics').trim().toLowerCase();
  if (k === 'basics') return 'Basics';
  if (k === 'flash') return 'Flash Anzan';
  if (k === 'elements') return 'Elements';
  if (k === 'memoriad') return 'Memoriad';
  if (k === 'round') return 'Round scores';
  return 'Section';
}

/**
 * Formats a Basics section duration in seconds into plain English.
 * @param {number|string|null|undefined} seconds
 * @returns {string}
 */
export function formatSectionSeconds(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s === 30) return '30 seconds';
  if (s === 60) return '1 minute';
  if (s === 120) return '2 minutes';
  if (s === 300) return '5 minutes';
  if (s % 60 === 0) {
    const mins = s / 60;
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  }
  return `${s} seconds`;
}

/**
 * Converts a Flash speed in seconds (e.g. 0.2..5.0) to integer milliseconds
 * (200..5000) without floating-point error.
 * @param {number|string|null|undefined} seconds
 * @returns {number|null}
 */
export function speedSecondsToMs(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return null;
  const num = Number(seconds);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1000);
}

/**
 * Formats integer milliseconds into a clean seconds string (e.g. 500 -> "0.5", 1000 -> "1").
 * @param {number|string|null|undefined} ms
 * @returns {string}
 */
export function speedMsToSecondsText(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const secs = Math.round(n) / 1000;
  // Strip trailing zeros cleanly via Number.toString()
  return String(Number(secs.toFixed(3)));
}

/**
 * Resolves flash_speed_ms from a section object that may hold either
 * `flash_speed_ms` or `flash_speed_seconds` / `speed_seconds`.
 * @param {object} section
 * @returns {number|null}
 */
export function resolveFlashSpeedMs(section) {
  if (!section || typeof section !== 'object') return null;
  if (section.flash_speed_ms !== null && section.flash_speed_ms !== undefined && section.flash_speed_ms !== '') {
    const ms = Number(section.flash_speed_ms);
    return Number.isFinite(ms) ? Math.round(ms) : null;
  }
  const secVal = section.flash_speed_seconds ?? section.speed_seconds ?? null;
  return speedSecondsToMs(secVal);
}

/**
 * Resolves the category object or name from optional lookup tables.
 * @param {object} section
 * @param {object} [lookup] - Optional `{ categoriesById, categories }`
 * @returns {{ id: string|null, name: string, group_name: string|null }}
 */
function resolveCategoryInfo(section, lookup = {}) {
  const catId = section?.category_id ? String(section.category_id) : null;
  let catObj = null;

  if (catId) {
    if (lookup?.categoriesById && typeof lookup.categoriesById === 'object') {
      catObj = lookup.categoriesById instanceof Map
        ? lookup.categoriesById.get(catId)
        : lookup.categoriesById[catId];
    } else if (Array.isArray(lookup?.categories)) {
      catObj = lookup.categories.find((c) => String(c.id) === catId) || null;
    }
  }

  const name = String(
    section?.name ||
    section?.category_name ||
    section?.category ||
    catObj?.name ||
    ''
  ).trim();

  const group_name = catObj?.group_name
    ? String(catObj.group_name).trim().toLowerCase()
    : null;

  return { id: catId, name, group_name };
}

/**
 * Produces a concise, plain-English summary for a weekly test section of any kind.
 *
 * Examples:
 * - Basics (with seconds): "Basics: 1D 4R, 2 minutes"
 * - Basics (offline without seconds): "Basics: 1D 4R"
 * - Flash: "Flash: 1 digit, 50 numbers, 0.5 s, add only, 5 tries"
 * - Elements: "Elements: Day Codes"
 * - Memoriad: "Memoriad: Mental Additions"
 * - Round: "Round: ADD"
 *
 * @param {object} section
 * @param {object} [lookup] - Optional `{ categoriesById, categories }`
 * @returns {string}
 */
export function sectionSummary(section, lookup = {}) {
  if (!section || typeof section !== 'object') return 'Section';
  const kind = String(section.kind || 'basics').trim().toLowerCase();

  if (kind === 'basics') {
    const { name } = resolveCategoryInfo(section, lookup);
    const catLabel = name || 'Category';
    const dur = formatSectionSeconds(section.seconds);
    return dur ? `Basics: ${catLabel}, ${dur}` : `Basics: ${catLabel}`;
  }

  if (kind === 'round') {
    const { name } = resolveCategoryInfo(section, lookup);
    const catLabel = name || 'Category';
    return `Round: ${catLabel}`;
  }

  if (kind === 'flash') {
    const digits = Number(section.flash_digits) || 1;
    const count = Number(section.flash_count) || 10;
    const speedMs = resolveFlashSpeedMs(section) || 1000;
    const speedText = speedMsToSecondsText(speedMs) || '1';
    const mode = String(section.flash_mode || 'add').toLowerCase() === 'add_sub'
      ? 'add & sub'
      : 'add only';
    const tries = Number(section.question_count) || 1;

    const digitWord = digits === 1 ? 'digit' : 'digits';
    const triesWord = tries === 1 ? 'try' : 'tries';
    return `Flash: ${digits} ${digitWord}, ${count} numbers, ${speedText} s, ${mode}, ${tries} ${triesWord}`;
  }

  if (kind === 'elements') {
    const key = String(section.activity_key || '').trim();
    const drill = DRILL_CATALOG[key];
    const title = drill?.title || section.name || key || 'Drill';
    return `Elements: ${title}`;
  }

  if (kind === 'memoriad') {
    const key = String(section.activity_key || '').trim();
    const mod = MEMORIAD_MODULE_MAP[key];
    const title = mod?.title || section.name || key || 'Module';
    return `Memoriad: ${title}`;
  }

  return 'Section';
}

/**
 * Returns the short item title without the kind prefix (useful when the kind badge
 * is already rendered separately).
 * @param {object} section
 * @param {object} [lookup]
 * @returns {string}
 */
export function sectionShortTitle(section, lookup = {}) {
  if (!section || typeof section !== 'object') return 'Section';
  const kind = String(section.kind || 'basics').trim().toLowerCase();

  if (kind === 'basics' || kind === 'round') {
    const { name } = resolveCategoryInfo(section, lookup);
    return name || 'Category';
  }
  if (kind === 'elements') {
    const key = String(section.activity_key || '').trim();
    return DRILL_CATALOG[key]?.title || section.name || key || 'Elements drill';
  }
  if (kind === 'memoriad') {
    const key = String(section.activity_key || '').trim();
    return MEMORIAD_MODULE_MAP[key]?.title || section.name || key || 'Memoriad module';
  }
  if (kind === 'flash') {
    const digits = Number(section.flash_digits) || 1;
    const count = Number(section.flash_count) || 10;
    const speedMs = resolveFlashSpeedMs(section) || 1000;
    const speedText = speedMsToSecondsText(speedMs) || '1';
    const mode = String(section.flash_mode || 'add').toLowerCase() === 'add_sub'
      ? 'add & sub'
      : 'add only';
    const tries = Number(section.question_count) || 1;
    return `${digits} ${digits === 1 ? 'digit' : 'digits'}, ${count} numbers, ${speedText} s, ${mode}, ${tries} ${tries === 1 ? 'try' : 'tries'}`;
  }
  return sectionSummary(section, lookup);
}

/**
 * Validates an array of weekly test section drafts for a given testType ('online' | 'offline').
 *
 * Rules:
 * - Online tests require 1 to 12 sections.
 * - Offline tests allow 0 to 12 sections.
 * - Round sections are rejected in online tests.
 * - Basics: category must belong to 'basics'; online basics must be supported by
 *   the question generator and have seconds in [30, 60, 120, 300]; offline basics
 *   seconds is optional (null or [30, 60, 120, 300]).
 * - Flash: digits 1-5, numbers 2-1000, speed 200-5000 ms (0.2-5.0 s), mode add|add_sub, tries 1-10.
 * - Elements: activity_key must exist in DRILL_CATALOG with enabled === true.
 * - Memoriad: activity_key must be one of the 4 Memoriad modules.
 * - Round: category must belong to 'round' (offline only).
 * - Uniqueness within one test: no duplicate category_id, no duplicate activity_key,
 *   and no two identical Flash sections (same digits, count, speed_ms, mode, tries).
 *
 * @param {Array<object>} sections
 * @param {'online'|'offline'} testType
 * @param {object} [lookup] - Optional `{ categoriesById, categories }`
 * @returns {{ valid: boolean, error: string|null, errors: string[] }}
 */
export function validateSections(sections, testType = 'online', lookup = {}) {
  const errors = [];
  const normalizedType = String(testType || 'online').trim().toLowerCase();

  if (!Array.isArray(sections)) {
    return { valid: false, error: 'Sections must be a list.', errors: ['Sections must be a list.'] };
  }

  if (normalizedType === 'online' && sections.length === 0) {
    errors.push('Online tests require at least 1 section.');
  }
  if (sections.length > 12) {
    errors.push('A weekly test can have at most 12 sections.');
  }

  const seenCategoryIds = new Set();
  const seenActivityKeys = new Set();
  const seenFlashSignatures = new Set();

  sections.forEach((sec, idx) => {
    const label = `Section #${idx + 1}`;
    if (!sec || typeof sec !== 'object') {
      errors.push(`${label} is invalid.`);
      return;
    }

    const kind = String(sec.kind || '').trim().toLowerCase();
    if (!SECTION_KINDS.includes(kind)) {
      errors.push(`${label}: Please choose a valid section kind.`);
      return;
    }

    if (kind === 'round' && normalizedType === 'online') {
      errors.push(`${label}: Round scores are available for offline tests only for now.`);
      return;
    }

    if (kind === 'basics') {
      const { id: catId, name: catName, group_name: groupName } = resolveCategoryInfo(sec, lookup);
      if (!catId) {
        errors.push(`${label} (Basics): Please select a Basics category.`);
      } else {
        if (groupName && groupName !== 'basics') {
          errors.push(`${label} (Basics): Selected category must belong to Basics.`);
        }
        if (seenCategoryIds.has(catId)) {
          errors.push(`${label} (Basics): Category "${catName || catId}" is already added in another section.`);
        } else {
          seenCategoryIds.add(catId);
        }
        if (normalizedType === 'online' && catName && !isBasicsOnlineAvailable(catName)) {
          errors.push(`${label} (Basics): "${catName}" is not supported for online question generation yet.`);
        }
      }

      const rawSec = sec.seconds;
      const hasSeconds = rawSec !== null && rawSec !== undefined && rawSec !== '';
      if (normalizedType === 'online') {
        const s = Number(rawSec);
        if (!hasSeconds || !BASICS_ALLOWED_SECONDS.includes(s)) {
          errors.push(`${label} (Basics): Please choose a time limit (30s, 1m, 2m, or 5m) for online Basics.`);
        }
      } else if (hasSeconds) {
        const s = Number(rawSec);
        if (!BASICS_ALLOWED_SECONDS.includes(s)) {
          errors.push(`${label} (Basics): Time limit must be 30s, 1m, 2m, or 5m (or left blank for offline).`);
        }
      }
      return;
    }

    if (kind === 'round') {
      const { id: catId, name: catName, group_name: groupName } = resolveCategoryInfo(sec, lookup);
      if (!catId) {
        errors.push(`${label} (Round): Please select a Round category.`);
      } else {
        if (groupName && groupName !== 'round') {
          errors.push(`${label} (Round): Selected category must belong to Round scores.`);
        }
        if (seenCategoryIds.has(catId)) {
          errors.push(`${label} (Round): Category "${catName || catId}" is already added in another section.`);
        } else {
          seenCategoryIds.add(catId);
        }
      }
      return;
    }

    if (kind === 'elements') {
      const key = String(sec.activity_key || '').trim();
      const drill = DRILL_CATALOG[key];
      if (!key || !drill || !drill.enabled) {
        errors.push(`${label} (Elements): Please select an enabled Elements drill.`);
      } else if (seenActivityKeys.has(`elements:${key}`)) {
        errors.push(`${label} (Elements): "${drill.title}" is already included in this test.`);
      } else {
        seenActivityKeys.add(`elements:${key}`);
      }
      return;
    }

    if (kind === 'memoriad') {
      const key = String(sec.activity_key || '').trim();
      const mod = MEMORIAD_MODULE_MAP[key];
      if (!key || !mod) {
        errors.push(`${label} (Memoriad): Please select a valid Memoriad module.`);
      } else if (seenActivityKeys.has(`memoriad:${key}`)) {
        errors.push(`${label} (Memoriad): "${mod.title}" is already included in this test.`);
      } else {
        seenActivityKeys.add(`memoriad:${key}`);
      }
      return;
    }

    if (kind === 'flash') {
      const digits = Number(sec.flash_digits);
      const count = Number(sec.flash_count);
      const speedMs = resolveFlashSpeedMs(sec);
      const mode = String(sec.flash_mode || '').trim().toLowerCase();
      const tries = Number(sec.question_count);

      if (!Number.isInteger(digits) || digits < 1 || digits > 5) {
        errors.push(`${label} (Flash Anzan): Digits must be a whole number from 1 to 5.`);
      }
      if (!Number.isInteger(count) || count < 2 || count > 1000) {
        errors.push(`${label} (Flash Anzan): Numbers count must be a whole number from 2 to 1000.`);
      }
      if (speedMs === null || !Number.isInteger(speedMs) || speedMs < 200 || speedMs > 5000) {
        errors.push(`${label} (Flash Anzan): Speed must be between 0.2 s and 5.0 s.`);
      }
      if (!FLASH_MODES.includes(mode)) {
        errors.push(`${label} (Flash Anzan): Mode must be "add only" or "add & subtract".`);
      }
      if (!Number.isInteger(tries) || tries < 1 || tries > 10) {
        errors.push(`${label} (Flash Anzan): Number of tries must be between 1 and 10.`);
      }

      if (
        Number.isInteger(digits) &&
        Number.isInteger(count) &&
        Number.isInteger(speedMs) &&
        FLASH_MODES.includes(mode) &&
        Number.isInteger(tries)
      ) {
        const sig = `${digits}:${count}:${speedMs}:${mode}:${tries}`;
        if (seenFlashSignatures.has(sig)) {
          errors.push(`${label} (Flash Anzan): Duplicate Flash Anzan section with identical settings.`);
        } else {
          seenFlashSignatures.add(sig);
        }
      }
    }
  });

  return {
    valid: errors.length === 0,
    error: errors[0] || null,
    errors
  };
}

/**
 * Converts a single section object to its clean database row shape for `weekly_test_sections`,
 * nulling out columns that do not belong to the section's `kind`.
 *
 * @param {object} section
 * @param {number} position - 1-based position
 * @param {string} [testId] - Optional test_id to attach
 * @returns {object}
 */
export function toSectionRow(section, position = 1, testId = undefined) {
  const kind = String(section?.kind || 'basics').trim().toLowerCase();
  const pos = Number(position) || Number(section?.position) || 1;

  const row = {
    position: pos,
    kind,
    category_id: null,
    activity_key: null,
    seconds: null,
    flash_digits: null,
    flash_count: null,
    flash_speed_ms: null,
    flash_mode: null,
    question_count: null
  };

  if (testId !== undefined && testId !== null) {
    row.test_id = testId;
  }

  if (kind === 'basics') {
    row.category_id = section.category_id || null;
    const rawSec = section.seconds;
    row.seconds = rawSec !== null && rawSec !== undefined && rawSec !== ''
      ? Number(rawSec)
      : null;
  } else if (kind === 'round') {
    row.category_id = section.category_id || null;
  } else if (kind === 'elements' || kind === 'memoriad') {
    row.activity_key = section.activity_key ? String(section.activity_key).trim() : null;
  } else if (kind === 'flash') {
    row.flash_digits = Number(section.flash_digits);
    row.flash_count = Number(section.flash_count);
    row.flash_speed_ms = resolveFlashSpeedMs(section);
    row.flash_mode = String(section.flash_mode || 'add').trim().toLowerCase();
    row.question_count = Number(section.question_count);
  }

  return row;
}

/**
 * Converts a section or list of sections to database rows for `weekly_test_sections`.
 * If an array is passed, returns an array of rows with 1-based `position`.
 * If a single section object is passed, returns a single row object.
 *
 * @param {Array<object>|object} sectionsOrSection
 * @param {string} [testId]
 * @returns {Array<object>|object}
 */
export function toRows(sectionsOrSection, testId = undefined) {
  if (Array.isArray(sectionsOrSection)) {
    return sectionsOrSection.map((sec, idx) => toSectionRow(sec, idx + 1, testId));
  }
  return toSectionRow(sectionsOrSection, sectionsOrSection?.position || 1, testId);
}

/**
 * Returns enabled Elements drills from DRILL_CATALOG_LIST for section builder dropdowns.
 * @returns {Array<{ key: string, title: string, group: string }>}
 */
export function getEnabledElementsDrills() {
  return DRILL_CATALOG_LIST.filter((d) => d.enabled);
}
