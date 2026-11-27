/**
 * Trendz Tracker — Student Practice Access Domain & Controller (js/studentAccess.js)
 *
 * Implements:
 * 1. Curriculum level defaults & student overrides
 * 2. Section access checks (Basics, Elements, Flash Anzan, Memoriad, Main Round)
 * 3. Provenance tracking ('From Level X' vs 'Student override' vs 'Default (Full access)')
 * 4. Teacher bulk action ('Apply to my students in this level')
 * 5. Full parity between Supabase and DemoDB
 */

import { DRILL_CATALOG, DRILL_GROUPS } from './drillCatalog.js';
import { MEMORIAD_MODULE_CATALOG } from './memoriadStats.js';
import { JMCWC_CATEGORY_TITLES } from './jmcwcClient.js';
import { FLASH_LIMITS, allowedFlashModes, flashModeLabel } from './flashStats.js';
import {
  SIMPLE_ACTIVITIES,
  SIMPLE_ACTIVITY_KEYS,
  SIMPLE_GROUPS,
  normalizeSimplePracticeRule,
  isSimplePracticeAllowed,
  isSimpleActivityAllowed,
} from './simplePractice.js';
import {
  ORAL_OPERATIONS,
  ORAL_OPERATION_KEYS,
  ORAL_DIGIT_SIZES,
  normalizeOralRoundsRule,
  isOralRoundsAllowed,
} from './oralRounds.js';

export { isOralRoundsAllowed, isSimplePracticeAllowed, isSimpleActivityAllowed, allowedFlashModes };

export const PRESET_FULL_ACCESS = Object.freeze({
  basics: Object.freeze({ all: true, categories: [] }),
  elements: Object.freeze({ all: true, drills: [] }),
  flash: Object.freeze({ allowed: true, modes: [...FLASH_LIMITS.MODES] }),
  memoriad: Object.freeze({
    all: true,
    modules: ['calendar', 'additions', 'multiplications', 'division', 'square_roots'],
    calendar_variants: [25, 50, 75, 100, 125],
  }),
  main_round: Object.freeze({ all: true, categories: [] }),
  oral_rounds: Object.freeze({
    allowed: true,
    operations: ['add', 'sub', 'mul'],
    digits: [1, 2, 3, 4, 5],
  }),
  simple_practice: Object.freeze({ allowed: true, activities: [...SIMPLE_ACTIVITY_KEYS] }),
});

/** Level 1 Starter for Oral Rounds: addition and subtraction with 1 and 2 digit numbers. */
export const ORAL_ROUNDS_LEVEL_1 = Object.freeze({
  allowed: true,
  operations: Object.freeze(['add', 'sub']),
  digits: Object.freeze([1, 2]),
});

export const PRESET_LEVEL_1 = Object.freeze({
  basics: Object.freeze({ all: false, categories: ['1d4r'] }),
  elements: Object.freeze({
    all: false,
    drills: ['squares_stage_1', 'day_codes', 'month_codes'],
  }),
  flash: Object.freeze({ allowed: true, modes: [...FLASH_LIMITS.MODES] }),
  memoriad: Object.freeze({
    all: false,
    modules: ['calendar'],
    calendar_variants: [25],
  }),
  main_round: Object.freeze({ all: false, categories: [] }),
  oral_rounds: ORAL_ROUNDS_LEVEL_1,
  simple_practice: Object.freeze({ allowed: true, activities: [...SIMPLE_ACTIVITY_KEYS] }),
});

export const MEMORIAD_CALENDAR_VARIANTS = Object.freeze([25, 50, 75, 100, 125]);

/**
 * Normalizes a category or drill key for robust case-insensitive and space-insensitive matching.
 * e.g. "1D 4R" -> "1d4r", "1d4r" -> "1d4r"
 */
export function normalizeCategoryKey(key) {
  if (!key) return '';
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Checks whether a Basics category is permitted under the given basics rule.
 * Matches by category ID or normalized category name (e.g. '1d4r' matches '1D 4R').
 */
export function isBasicsCategoryAllowed(categoryOrId, basicsRule) {
  if (!basicsRule || basicsRule.all === true || basicsRule.categories === null) return true;
  const allowedList = Array.isArray(basicsRule.categories) ? basicsRule.categories : [];
  if (allowedList.length === 0) return false;

  const targetId = typeof categoryOrId === 'object' && categoryOrId !== null
    ? String(categoryOrId.id || '')
    : String(categoryOrId || '');
  const targetName = typeof categoryOrId === 'object' && categoryOrId !== null
    ? String(categoryOrId.name || '')
    : '';

  const normId = normalizeCategoryKey(targetId);
  const normName = normalizeCategoryKey(targetName);

  return allowedList.some((allowed) => {
    const normAllowed = normalizeCategoryKey(allowed);
    if (allowed === targetId || normAllowed === normId) return true;
    if (normName && (normAllowed === normName || allowed === targetName)) return true;
    return false;
  });
}

/**
 * Resolves a human-friendly provenance label for where an access setting originated.
 * e.g. "From Level 1", "Student override", "Default (Full access)"
 */
export function resolveAccessProvenance(access) {
  if (!access) return 'Default (Full access)';
  if (access.source_label) return access.source_label;
  if (access.scope === 'student' || access.source === 'override' || access.has_override) return 'Student override';
  if (access.scope === 'level' || access.source === 'level') return `From ${access.level || 'Level'}`;
  return 'Default (Full access)';
}

/**
 * Checks whether an Elements drill is permitted under the given elements rule.
 * Supports:
 * - isElementDrillAllowed(drillKey, elementsRule)
 * - isElementDrillAllowed(topic, drill, elementsRule)
 */
export function isElementDrillAllowed(topicOrDrill, drillOrElementsRule, maybeElementsRule) {
  let drillKey = topicOrDrill;
  let elementsRule = drillOrElementsRule;

  if (maybeElementsRule !== undefined) {
    const topic = String(topicOrDrill || '').trim().toLowerCase();
    const drill = String(drillOrElementsRule || '').trim().toLowerCase();
    drillKey = `${topic}_${drill}`;
    elementsRule = maybeElementsRule;

    if (!elementsRule || elementsRule.all === true) return true;
    if (elementsRule.topics && typeof elementsRule.topics === 'object' && elementsRule.topics[topic]) {
      const topObj = elementsRule.topics[topic];
      if (topObj.allowed === false) return false;
      if (Array.isArray(topObj.drills)) {
        return topObj.drills.some(
          (d) => String(d).trim().toLowerCase() === drill || normalizeCategoryKey(d) === normalizeCategoryKey(drill)
        );
      }
      return topObj.allowed !== false;
    }
  }

  if (!elementsRule || elementsRule.all === true) return true;
  const allowedList = Array.isArray(elementsRule.drills) ? elementsRule.drills : [];
  if (allowedList.length === 0) return false;
  const cleanKey = String(drillKey || '').trim().toLowerCase();
  const normKey = normalizeCategoryKey(cleanKey);
  return allowedList.some((k) => String(k).trim().toLowerCase() === cleanKey || normalizeCategoryKey(k) === normKey);
}

/**
 * Checks whether Flash Anzan is allowed.
 * Uses a single Allowed / Hidden switch.
 */
export function isFlashAllowed(flashRule) {
  if (!flashRule || typeof flashRule.allowed !== 'boolean') return true;
  return flashRule.allowed === true;
}

/**
 * Checks whether a Memoriad module (and optional Calendar date count) is permitted.
 */
export function isMemoriadAllowed(moduleKey, dates, memoriadRule) {
  if (!memoriadRule || memoriadRule.all === true) return true;

  const cleanModule = String(moduleKey || '').trim().toLowerCase();

  // Support object map format: modules: { calendar: { allowed: true, variants: [25] } }
  if (memoriadRule.modules && typeof memoriadRule.modules === 'object' && !Array.isArray(memoriadRule.modules)) {
    const modObj = memoriadRule.modules[cleanModule];
    if (!modObj) return false;
    if (modObj.allowed === false) return false;
    if (cleanModule === 'calendar' && dates !== undefined && dates !== null) {
      const variants = Array.isArray(modObj.variants) ? modObj.variants.map(Number) : [];
      if (variants.length > 0 && !variants.includes(Number(dates))) {
        return false;
      }
    }
    return true;
  }

  const allowedModules = Array.isArray(memoriadRule.modules) ? memoriadRule.modules : [];

  if (cleanModule === 'calendar') {
    if (!allowedModules.includes('calendar') && memoriadRule.all !== true) {
      return false;
    }
    if (dates !== undefined && dates !== null) {
      const allowedDates = Array.isArray(memoriadRule.calendar_variants)
        ? memoriadRule.calendar_variants.map(Number)
        : [];
      if (allowedDates.length > 0 && !allowedDates.includes(Number(dates))) {
        return false;
      }
    }
    return true;
  }

  return allowedModules.includes(cleanModule);
}

/**
 * Checks whether a Main Round category is allowed for a student.
 */
export function isMainRoundCategoryAllowed(categoryKey, mainRoundRule, isEligible = true) {
  if (!isEligible || (mainRoundRule && mainRoundRule.eligible === false)) return false;
  if (!mainRoundRule || mainRoundRule.all === true) return true;
  const allowedCategories = Array.isArray(mainRoundRule.categories) ? mainRoundRule.categories : [];
  const cleanKey = String(categoryKey || '').trim().toLowerCase();
  return allowedCategories.some((k) => String(k).trim().toLowerCase() === cleanKey);
}

/**
 * Checks whether a Main Round full-paper start is allowed.
 * Requires access to ALL categories included in the paper.
 */
export function isMainRoundFullPaperAllowed(paperCategories, mainRoundRule, isEligible = true) {
  if (!isEligible || (mainRoundRule && mainRoundRule.eligible === false)) return false;
  if (!mainRoundRule || mainRoundRule.all === true) return true;

  const categoriesToCheck = Array.isArray(paperCategories) && paperCategories.length > 0
    ? paperCategories
    : Object.keys(JMCWC_CATEGORY_TITLES);

  for (const catKey of categoriesToCheck) {
    if (!isMainRoundCategoryAllowed(catKey, mainRoundRule, isEligible)) {
      return false;
    }
  }
  return true;
}

/**
 * Fetches the effective practice access for a student.
 */
export async function fetchStudentEffectiveAccess(studentId, options = {}) {
  if (!studentId) {
    return {
      ok: false,
      error: 'Missing student ID',
    };
  }

  let supabase = null;
  let isDemo = false;
  let demoDbInstance = null;

  if (options && typeof options.rpc === 'function') {
    supabase = options;
  } else if (options && typeof options === 'object') {
    supabase = options.supabase || null;
    isDemo = Boolean(options.isDemo);
    demoDbInstance = options.DemoDB || null;
  }

  if (isDemo) {
    if (demoDbInstance && typeof demoDbInstance.getStudentEffectiveAccess === 'function') {
      return demoDbInstance.getStudentEffectiveAccess(studentId);
    }
    return {
      ok: true,
      student_id: studentId,
      level: 'Level 1',
      scope: 'default',
      source_label: 'Default (Full access)',
      has_override: false,
      settings: JSON.parse(JSON.stringify(PRESET_FULL_ACCESS)),
      main_round_eligible: true,
    };
  }

  if (!supabase || typeof supabase.rpc !== 'function') {
    return {
      ok: false,
      error: 'Live Supabase client is missing or invalid',
    };
  }

  const { data, error } = await supabase.rpc('get_student_effective_access', {
    p_student_id: studentId,
  });

  if (error) {
    console.warn('[studentAccess] Error loading effective access:', error.message);
    return {
      ok: false,
      error: error.message,
    };
  }

  if (!data || typeof data !== 'object' || data.ok !== true || !data.settings || typeof data.settings !== 'object') {
    return {
      ok: false,
      error: 'Empty or malformed access lookup response from server',
    };
  }

  return data;
}

/**
 * Fetches level access defaults.
 */
export async function fetchLevelAccessDefaults(level, { supabase, isDemo = false, DemoDB = null }) {
  if (!level) {
    return { ok: false, error: 'Level is required' };
  }

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.getLevelAccessDefaults === 'function') {
      return DemoDB.getLevelAccessDefaults(level);
    }
    return {
      ok: true,
      level,
      has_rule: false,
      settings: JSON.parse(JSON.stringify(PRESET_FULL_ACCESS)),
    };
  }

  const { data, error } = await supabase.rpc('get_level_access_defaults', {
    p_level: level,
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return data;
}

/**
 * Saves level access defaults (Admin only).
 */
export async function saveLevelAccessDefaults(level, settings, { supabase, isDemo = false, DemoDB = null }) {
  if (!level) return { ok: false, error: 'Level is required' };

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.saveLevelAccessDefaults === 'function') {
      return DemoDB.saveLevelAccessDefaults(level, settings);
    }
    return { ok: true, level, settings };
  }

  const { data, error } = await supabase.rpc('admin_save_level_access', {
    p_level: level,
    p_settings: settings,
  });

  if (error) return { ok: false, error: error.message };
  return data;
}

/**
 * Saves a student access override.
 */
export async function saveStudentAccessOverride(studentId, settings, { supabase, isDemo = false, DemoDB = null }) {
  if (!studentId) return { ok: false, error: 'Student ID is required' };

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.saveStudentAccessOverride === 'function') {
      return DemoDB.saveStudentAccessOverride(studentId, settings);
    }
    return { ok: true, student_id: studentId, settings };
  }

  const { data, error } = await supabase.rpc('save_student_access_override', {
    p_student_id: studentId,
    p_settings: settings,
  });

  if (error) return { ok: false, error: error.message };
  return data;
}

/**
 * Resets a student access override to inherit level settings.
 */
export async function resetStudentAccessOverride(studentId, { supabase, isDemo = false, DemoDB = null }) {
  if (!studentId) return { ok: false, error: 'Student ID is required' };

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.resetStudentAccessOverride === 'function') {
      return DemoDB.resetStudentAccessOverride(studentId);
    }
    return { ok: true, student_id: studentId };
  }

  const { data, error } = await supabase.rpc('reset_student_access_override', {
    p_student_id: studentId,
  });

  if (error) return { ok: false, error: error.message };
  return data;
}

/**
 * Gets student count for teacher bulk action in a level.
 */
export async function getTeacherLevelStudentCount(level, { supabase, isDemo = false, DemoDB = null, currentProfile = null }) {
  if (!level) return { ok: true, count: 0 };

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.getTeacherLevelStudentCount === 'function') {
      return DemoDB.getTeacherLevelStudentCount(level, currentProfile?.id);
    }
    return { ok: true, count: 1 };
  }

  const { data, error } = await supabase.rpc('get_teacher_level_student_count', {
    p_level: level,
  });

  if (error) return { ok: false, error: error.message };
  return data;
}

/**
 * Applies access settings in bulk to teacher's assigned students in a level.
 */
export async function teacherBulkApplyLevelAccess(level, settings, { supabase, isDemo = false, DemoDB = null, currentProfile = null }) {
  if (!level) return { ok: false, error: 'Level is required' };

  if (isDemo || !supabase || typeof supabase.rpc !== 'function') {
    if (DemoDB && typeof DemoDB.teacherBulkApplyLevelAccess === 'function') {
      return DemoDB.teacherBulkApplyLevelAccess(level, settings, currentProfile?.id);
    }
    return { ok: true, count: 1 };
  }

  const { data, error } = await supabase.rpc('teacher_bulk_apply_level_access', {
    p_level: level,
    p_settings: settings,
  });

  if (error) return { ok: false, error: error.message };
  return data;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Builds the HTML markup for the Student Access Editor.
 */
export function renderAccessEditorHtml({
  settings = PRESET_FULL_ACCESS,
  basicsCategories = [],
  isTeacher = false,
  isEligibleForMainRound = true,
  canToggleEligibility = true,
}) {
  const current = settings || PRESET_FULL_ACCESS;
  const basics = current.basics || { all: true, categories: [] };
  const elements = current.elements || { all: true, drills: [] };
  const flash = current.flash || { allowed: true };
  const memoriad = current.memoriad || { all: true, modules: [], calendar_variants: [25, 50, 75, 100, 125] };
  const mainRound = current.main_round || { all: true, categories: [] };
  const oral = normalizeOralRoundsRule(current.oral_rounds);
  const simple = normalizeSimplePracticeRule(current.simple_practice);
  const flashModes = allowedFlashModes({ ...flash, allowed: true });

  // 1. Basics HTML
  const basicsCount = basics.all ? 'All allowed' : `${(basics.categories || []).length} allowed`;
  const basicsItemsHtml = basicsCategories.map((c) => {
    const isChecked = isBasicsCategoryAllowed(c, basics);
    return `
      <label class="access-item-checkbox">
        <input type="checkbox" name="access_basics" value="${escapeHtml(c.id)}" data-cat-name="${escapeHtml(c.name)}" ${isChecked ? 'checked' : ''} />
        <span>${escapeHtml(c.name)}</span>
      </label>
    `;
  }).join('');

  // 2. Elements HTML (Grouped by topics)
  const allElementsDrills = Object.values(DRILL_CATALOG);
  const elementsCount = elements.all ? 'All allowed' : `${(elements.drills || []).length} allowed`;

  const elementsGroupsHtml = DRILL_GROUPS.map((group) => {
    const drillsInGroup = allElementsDrills.filter((d) => d.group === group);
    if (drillsInGroup.length === 0) return '';

    const drillsHtml = drillsInGroup.map((d) => {
      const isChecked = isElementDrillAllowed(d.key, elements);
      return `
        <label class="access-item-checkbox" style="font-size: 12px;">
          <input type="checkbox" name="access_elements" value="${escapeHtml(d.key)}" data-group="${escapeHtml(group)}" ${isChecked ? 'checked' : ''} />
          <span>${escapeHtml(d.title)}</span>
        </label>
      `;
    }).join('');

    return `
      <div class="access-subgroup" style="margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px dashed var(--border-hairline);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-1);">
          <strong style="font-size: 13px; color: var(--text-main);">${escapeHtml(group)}</strong>
          <button type="button" class="btn btn-ghost btn-xs btn-toggle-element-group" data-group="${escapeHtml(group)}" style="padding: 1px 6px; font-size: 11px;">Toggle group</button>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px;">
          ${drillsHtml}
        </div>
      </div>
    `;
  }).join('');

  // 3. Flash Anzan HTML (Allowed / Hidden switch and the modes the student may use)
  const isFlashActive = isFlashAllowed(flash);
  const flashModesHtml = FLASH_LIMITS.MODES.map((m) => `
      <label class="access-item-checkbox">
        <input type="checkbox" name="access_flash_mode" value="${escapeHtml(m)}" ${flashModes.includes(m) ? 'checked' : ''} />
        <span>${escapeHtml(flashModeLabel(m, 'option'))}</span>
      </label>
    `).join('');

  // 7. Simple HTML
  const simpleBadge = formatSimpleBadge(simple.allowed, simple.activities.length);
  const simpleGroupsHtml = SIMPLE_GROUPS.map((g) => {
    const items = SIMPLE_ACTIVITIES.filter((a) => a.group === g.key).map((a) => `
        <label class="access-item-checkbox" style="font-size: 12px;">
          <input type="checkbox" name="access_simple_activity" value="${escapeHtml(a.key)}" ${simple.activities.includes(a.key) ? 'checked' : ''} />
          <span>${escapeHtml(a.label)}</span>
        </label>
      `).join('');
    return `
      <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">${escapeHtml(g.label)}</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; margin-bottom: var(--space-3);">
        ${items}
      </div>
    `;
  }).join('');

  // 4. Memoriad HTML
  const memCount = memoriad.all ? 'All allowed' : 'Custom';
  const memModulesHtml = MEMORIAD_MODULE_CATALOG.filter((m) => m.key !== 'calendar').map((m) => {
    const isChecked = isMemoriadAllowed(m.key, null, memoriad);
    return `
      <label class="access-item-checkbox">
        <input type="checkbox" name="access_memoriad_module" value="${escapeHtml(m.key)}" ${isChecked ? 'checked' : ''} />
        <span>${escapeHtml(m.title)}</span>
      </label>
    `;
  }).join('');

  const isCalAllowed = isMemoriadAllowed('calendar', null, memoriad);
  const calendarVariantsHtml = MEMORIAD_CALENDAR_VARIANTS.map((n) => {
    const isChecked = isCalAllowed && isMemoriadAllowed('calendar', n, memoriad);
    return `
      <label class="access-item-checkbox" style="font-size: 12px;">
        <input type="checkbox" name="access_memoriad_cal_var" value="${n}" ${isChecked ? 'checked' : ''} />
        <span>${n} dates</span>
      </label>
    `;
  }).join('');

  // 5. Main Round HTML
  const isRoundEligible = isEligibleForMainRound;
  const roundCount = !isRoundEligible
    ? 'Ineligible'
    : mainRound.all
      ? 'All categories'
      : `${(mainRound.categories || []).length} categories`;

  const mainRoundCatsHtml = Object.entries(JMCWC_CATEGORY_TITLES).map(([catKey, title]) => {
    const isChecked = isMainRoundCategoryAllowed(catKey, mainRound, isRoundEligible);
    return `
      <label class="access-item-checkbox" style="font-size: 12px;">
        <input type="checkbox" name="access_main_round_cat" value="${escapeHtml(catKey)}" ${isChecked ? 'checked' : ''} ${!isRoundEligible ? 'disabled' : ''} />
        <span>${escapeHtml(title)}</span>
      </label>
    `;
  }).join('');

  // 6. Oral Rounds HTML
  const oralBadge = formatOralBadge(oral.allowed, oral.operations.length, oral.digits.length);
  const oralOpsHtml = ORAL_OPERATIONS.map((op) => `
      <label class="access-item-checkbox">
        <input type="checkbox" name="access_oral_op" value="${escapeHtml(op.key)}" ${oral.operations.includes(op.key) ? 'checked' : ''} />
        <span>${escapeHtml(op.label)} (${escapeHtml(op.symbol)})</span>
      </label>
    `).join('');
  const oralDigitsHtml = ORAL_DIGIT_SIZES.map((d) => `
      <label class="access-item-checkbox" style="font-size: 12px;">
        <input type="checkbox" name="access_oral_digit" value="${d}" ${oral.digits.includes(d) ? 'checked' : ''} />
        <span>${d} digit</span>
      </label>
    `).join('');

  return `
    <div class="student-access-editor" style="display: flex; flex-direction: column; gap: var(--space-4);">
      <!-- Presets Toolbar -->
      <div class="access-presets-bar" style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; background: var(--bg-surface-subtle); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border-hairline);">
        <span style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Presets:</span>
        <button type="button" class="btn btn-outline btn-xs" id="btn-preset-full-access">Full Access</button>
        <button type="button" class="btn btn-outline btn-xs" id="btn-preset-level-1">Level 1 Starter</button>
        <button type="button" class="btn btn-outline btn-xs" id="btn-preset-clear-all">Clear All</button>
      </div>

      <!-- Section 1: Basics -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Basics Practice</strong>
            <span class="badge badge-neutral" id="summary-basics-badge" style="margin-left: 8px;">${basicsCount}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-basics-select-all">Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-basics-clear-all">Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px;">
            ${basicsItemsHtml || '<div style="color: var(--text-muted); font-size: 12px;">No basics categories found.</div>'}
          </div>
        </div>
      </details>

      <!-- Section 2: Elements -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Elements Drills</strong>
            <span class="badge badge-neutral" id="summary-elements-badge" style="margin-left: 8px;">${elementsCount}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-elements-select-all">Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-elements-clear-all">Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          ${elementsGroupsHtml}
        </div>
      </details>

      <!-- Section 3: Flash Anzan (switch and modes) -->
      <div class="card" id="access-flash-section" style="padding: var(--space-3) var(--space-4); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2);">
        <div>
          <strong style="display: block;">Flash Anzan</strong>
          <span style="font-size: var(--text-xs); color: var(--text-muted);">When allowed, every digit level and speed is open. Choose the modes below.</span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span id="flash-status-label" style="font-weight: 600; font-size: 13px; color: ${isFlashActive ? 'var(--color-primary)' : 'var(--text-muted)'};">
            ${isFlashActive ? 'Allowed' : 'Hidden'}
          </span>
          <label class="switch" style="position: relative; display: inline-block; width: 44px; height: 24px; margin: 0;">
            <input type="checkbox" id="switch-flash-allowed" ${isFlashActive ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;" />
            <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${isFlashActive ? 'var(--color-primary)' : '#ccc'}; transition: .3s; border-radius: 24px;"></span>
          </label>
        </div>
        <div style="flex-basis: 100%; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; padding-top: var(--space-2); border-top: 1px dashed var(--border-hairline);">
          <span style="font-size: 12px; font-weight: 700; color: var(--text-muted);">Modes</span>
          ${flashModesHtml}
        </div>
      </div>

      <!-- Section 4: Memoriad -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Memoriad Practice</strong>
            <span class="badge badge-neutral" id="summary-memoriad-badge" style="margin-left: 8px;">${memCount}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-memoriad-select-all">Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-memoriad-clear-all">Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          <!-- Mental Calendar Dates with independent variant toggles -->
          <div style="margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px dashed var(--border-hairline);">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
              <label class="access-item-checkbox" style="font-weight: 600;">
                <input type="checkbox" id="check-memoriad-calendar" value="calendar" ${isCalAllowed ? 'checked' : ''} />
                <span>Mental Calendar Dates</span>
              </label>
            </div>
            <div style="margin-left: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
              ${calendarVariantsHtml}
            </div>
          </div>
          <!-- Other Memoriad modules -->
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px;">
            ${memModulesHtml}
          </div>
        </div>
      </details>

      <!-- Section 5: Main Round (Competition) -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Main Round (Competition)</strong>
            <span class="badge badge-neutral" id="summary-main-round-badge" style="margin-left: 8px;">${roundCount}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-main-round-select-all" ${!isRoundEligible ? 'disabled' : ''}>Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-main-round-clear-all" ${!isRoundEligible ? 'disabled' : ''}>Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          <!-- Eligibility Info / Switch -->
          <div style="margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: ${isRoundEligible ? 'var(--bg-surface-subtle)' : '#FFFBEB'}; border: 1px solid ${isRoundEligible ? 'var(--border-hairline)' : '#FDE68A'};">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <div>
                <strong>Competition Eligibility:</strong>
                <span style="font-size: 13px; color: ${isRoundEligible ? 'var(--color-primary)' : '#92400E'}; font-weight: 600;">
                  ${isRoundEligible ? 'Eligible for competition simulator' : 'Not eligible for Main Round'}
                </span>
                <span style="display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                  ${canToggleEligibility ? 'Admin can toggle eligibility.' : 'Main Round eligibility is managed by Administrators.'}
                </span>
              </div>
              ${canToggleEligibility ? `
                <label class="switch" style="position: relative; display: inline-block; width: 44px; height: 24px; margin: 0;">
                  <input type="checkbox" id="switch-main-round-eligible" ${isRoundEligible ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;" />
                  <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${isRoundEligible ? 'var(--color-primary)' : '#ccc'}; transition: .3s; border-radius: 24px;"></span>
                </label>
              ` : `
                <span class="badge ${isRoundEligible ? 'badge-primary' : 'badge-neutral'}">${isRoundEligible ? 'Eligible' : 'Ineligible'}</span>
              `}
            </div>
          </div>

          <div style="margin-bottom: var(--space-2); font-size: 12px; color: var(--text-muted);">
            <em>Note: A full-paper start requires access to all categories in that paper.</em>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px;">
            ${mainRoundCatsHtml}
          </div>
        </div>
      </details>

      <!-- Section 6: Oral Rounds (listening practice, never on the leaderboard) -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;" id="access-oral-rounds-section">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Oral Rounds</strong>
            <span class="badge badge-neutral" id="summary-oral-rounds-badge" style="margin-left: 8px;">${escapeHtml(oralBadge)}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-oral-select-all">Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-oral-clear-all">Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px dashed var(--border-hairline);">
            <span style="font-size: var(--text-xs); color: var(--text-muted);">The computer reads each question aloud. Scores stay on the student's screen and never reach the leaderboard or streaks.</span>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="oral-status-label" style="font-weight: 600; font-size: 13px; color: ${oral.allowed ? 'var(--color-primary)' : 'var(--text-muted)'};">
                ${oral.allowed ? 'Allowed' : 'Hidden'}
              </span>
              <label class="switch" style="position: relative; display: inline-block; width: 44px; height: 24px; margin: 0;">
                <input type="checkbox" id="switch-oral-allowed" aria-label="Allow Oral Rounds" ${oral.allowed ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;" />
                <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${oral.allowed ? 'var(--color-primary)' : '#ccc'}; transition: .3s; border-radius: 24px;"></span>
              </label>
            </div>
          </div>
          <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">Operations</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; margin-bottom: var(--space-3);">
            ${oralOpsHtml}
          </div>
          <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-bottom: 4px;">Digit sizes for each number</div>
          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            ${oralDigitsHtml}
          </div>
        </div>
      </details>

      <!-- Section 7: Simple (no-formula sums and tables dodging) -->
      <details class="card access-section-card" open style="padding: 0; overflow: hidden;" id="access-simple-section">
        <summary class="card-header" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div>
            <strong>Simple</strong>
            <span class="badge badge-neutral" id="summary-simple-badge" style="margin-left: 8px;">${escapeHtml(simpleBadge)}</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-ghost btn-xs" id="btn-simple-select-all">Select all</button>
            <button type="button" class="btn btn-ghost btn-xs" id="btn-simple-clear-all">Clear</button>
          </div>
        </summary>
        <div class="card-body" style="padding: var(--space-3) var(--space-4);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px dashed var(--border-hairline);">
            <span style="font-size: var(--text-xs); color: var(--text-muted);">No-formula sums and tables dodging, practised online or logged from paper.</span>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="simple-status-label" style="font-weight: 600; font-size: 13px; color: ${simple.allowed ? 'var(--color-primary)' : 'var(--text-muted)'};">
                ${simple.allowed ? 'Allowed' : 'Hidden'}
              </span>
              <label class="switch" style="position: relative; display: inline-block; width: 44px; height: 24px; margin: 0;">
                <input type="checkbox" id="switch-simple-allowed" aria-label="Allow Simple practice" ${simple.allowed ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;" />
                <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${simple.allowed ? 'var(--color-primary)' : '#ccc'}; transition: .3s; border-radius: 24px;"></span>
              </label>
            </div>
          </div>
          ${simpleGroupsHtml}
        </div>
      </details>
    </div>
  `;
}

/**
 * Extracts current settings JSON from the rendered editor container.
 */
export function extractAccessSettingsFromEditor(containerEl) {
  if (!containerEl) return PRESET_FULL_ACCESS;

  // 1. Basics
  const basicsChecked = Array.from(containerEl.querySelectorAll('input[name="access_basics"]:checked'))
    .map((el) => el.value);
  const totalBasics = containerEl.querySelectorAll('input[name="access_basics"]').length;
  const basics = {
    all: totalBasics > 0 && basicsChecked.length === totalBasics,
    categories: basicsChecked,
  };

  // 2. Elements
  const elementsChecked = Array.from(containerEl.querySelectorAll('input[name="access_elements"]:checked'))
    .map((el) => el.value);
  const totalElements = containerEl.querySelectorAll('input[name="access_elements"]').length;
  const elements = {
    all: totalElements > 0 && elementsChecked.length === totalElements,
    drills: elementsChecked,
  };

  // 3. Flash Anzan
  const flashInput = containerEl.querySelector('#switch-flash-allowed');
  const flashModeInputs = containerEl.querySelectorAll('input[name="access_flash_mode"]');
  const flash = {
    allowed: flashInput ? flashInput.checked : true,
    modes: flashModeInputs.length
      ? Array.from(flashModeInputs).filter((el) => el.checked).map((el) => el.value)
      : [...FLASH_LIMITS.MODES],
  };

  // 4. Memoriad
  const calChecked = containerEl.querySelector('#check-memoriad-calendar')?.checked ?? true;
  const calVariantsChecked = Array.from(containerEl.querySelectorAll('input[name="access_memoriad_cal_var"]:checked'))
    .map((el) => Number(el.value));
  const otherMemModules = Array.from(containerEl.querySelectorAll('input[name="access_memoriad_module"]:checked'))
    .map((el) => el.value);

  const modules = [...otherMemModules];
  if (calChecked) modules.push('calendar');

  const memoriad = {
    all: calChecked && calVariantsChecked.length === MEMORIAD_CALENDAR_VARIANTS.length && otherMemModules.length === 3,
    modules,
    calendar_variants: calVariantsChecked,
  };

  // 5. Main Round
  const eligibleSwitch = containerEl.querySelector('#switch-main-round-eligible');
  const isEligible = eligibleSwitch ? eligibleSwitch.checked : true;
  const roundChecked = Array.from(containerEl.querySelectorAll('input[name="access_main_round_cat"]:checked'))
    .map((el) => el.value);
  const totalRoundCats = Object.keys(JMCWC_CATEGORY_TITLES).length;

  const main_round = {
    all: isEligible && roundChecked.length === totalRoundCats,
    eligible: isEligible,
    categories: roundChecked,
  };

  // 6. Oral Rounds
  const oralSwitch = containerEl.querySelector('#switch-oral-allowed');
  const oral_rounds = {
    allowed: oralSwitch ? oralSwitch.checked : true,
    operations: Array.from(containerEl.querySelectorAll('input[name="access_oral_op"]:checked')).map((el) => el.value),
    digits: Array.from(containerEl.querySelectorAll('input[name="access_oral_digit"]:checked')).map((el) => Number(el.value)),
  };

  // 7. Simple
  const simpleSwitch = containerEl.querySelector('#switch-simple-allowed');
  const simple_practice = {
    allowed: simpleSwitch ? simpleSwitch.checked : true,
    activities: Array.from(containerEl.querySelectorAll('input[name="access_simple_activity"]:checked')).map((el) => el.value),
  };

  return {
    basics,
    elements,
    flash,
    memoriad,
    main_round,
    oral_rounds,
    simple_practice,
  };
}

function formatSimpleBadge(allowed, count) {
  if (!allowed) return 'Hidden';
  return `${count} of ${SIMPLE_ACTIVITY_KEYS.length} allowed`;
}

function formatOralBadge(allowed, opsCount, digitsCount) {
  if (!allowed) return 'Hidden';
  return `${opsCount} of ${ORAL_OPERATION_KEYS.length} operations · ${digitsCount} digit size${digitsCount === 1 ? '' : 's'}`;
}

/**
 * Attaches interactive listeners (presets, toggle all, switches) to the editor.
 */
export function wireAccessEditorEvents(containerEl, onSettingsChange = null) {
  if (!containerEl) return;

  const notify = () => {
    if (typeof onSettingsChange === 'function') {
      const s = extractAccessSettingsFromEditor(containerEl);
      onSettingsChange(s);
    }
  };

  // Preset: Full Access
  containerEl.querySelector('#btn-preset-full-access')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (!cb.disabled) cb.checked = true;
    });
    updateFlashVisuals();
    notify();
  });

  // Preset: Level 1
  containerEl.querySelector('#btn-preset-level-1')?.addEventListener('click', () => {
    // Uncheck everything first
    containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (!cb.disabled) cb.checked = false;
    });
    // Check 1D 4R
    containerEl.querySelectorAll('input[name="access_basics"]').forEach((cb) => {
      const catName = cb.getAttribute('data-cat-name') || cb.value;
      if (normalizeCategoryKey(catName) === '1d4r') cb.checked = true;
    });
    // Check basic elements
    containerEl.querySelectorAll('input[name="access_elements"]').forEach((cb) => {
      if (['squares_stage_1', 'day_codes', 'month_codes'].includes(cb.value)) cb.checked = true;
    });
    // Flash allowed with every mode
    const flashCb = containerEl.querySelector('#switch-flash-allowed');
    if (flashCb) flashCb.checked = true;
    containerEl.querySelectorAll('input[name="access_flash_mode"]').forEach((cb) => (cb.checked = true));
    // Simple: allowed with every activity
    const simpleCb = containerEl.querySelector('#switch-simple-allowed');
    if (simpleCb) simpleCb.checked = true;
    containerEl.querySelectorAll('input[name="access_simple_activity"]').forEach((cb) => (cb.checked = true));
    // Memoriad: Calendar 25 only
    const calCb = containerEl.querySelector('#check-memoriad-calendar');
    if (calCb) calCb.checked = true;
    containerEl.querySelectorAll('input[name="access_memoriad_cal_var"]').forEach((cb) => {
      cb.checked = cb.value === '25';
    });
    // Oral Rounds: allowed, addition and subtraction, 1 and 2 digit numbers
    const oralCb = containerEl.querySelector('#switch-oral-allowed');
    if (oralCb) oralCb.checked = ORAL_ROUNDS_LEVEL_1.allowed;
    containerEl.querySelectorAll('input[name="access_oral_op"]').forEach((cb) => {
      cb.checked = ORAL_ROUNDS_LEVEL_1.operations.includes(cb.value);
    });
    containerEl.querySelectorAll('input[name="access_oral_digit"]').forEach((cb) => {
      cb.checked = ORAL_ROUNDS_LEVEL_1.digits.includes(Number(cb.value));
    });
    updateFlashVisuals();
    notify();
  });

  // Preset: Clear All
  containerEl.querySelector('#btn-preset-clear-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (!cb.disabled) cb.checked = false;
    });
    updateFlashVisuals();
    notify();
  });

  // Basics select all / clear
  containerEl.querySelector('#btn-basics-select-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_basics"]').forEach((cb) => (cb.checked = true));
    notify();
  });
  containerEl.querySelector('#btn-basics-clear-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_basics"]').forEach((cb) => (cb.checked = false));
    notify();
  });

  // Elements select all / clear / group toggles
  containerEl.querySelector('#btn-elements-select-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_elements"]').forEach((cb) => (cb.checked = true));
    notify();
  });
  containerEl.querySelector('#btn-elements-clear-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_elements"]').forEach((cb) => (cb.checked = false));
    notify();
  });
  containerEl.querySelectorAll('.btn-toggle-element-group').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.getAttribute('data-group');
      const cbs = containerEl.querySelectorAll(`input[name="access_elements"][data-group="${group}"]`);
      const allChecked = Array.from(cbs).every((cb) => cb.checked);
      cbs.forEach((cb) => (cb.checked = !allChecked));
      notify();
    });
  });

  // Flash Switch
  function updateFlashVisuals() {
    const flashCb = containerEl.querySelector('#switch-flash-allowed');
    const label = containerEl.querySelector('#flash-status-label');
    const slider = containerEl.querySelector('#switch-flash-allowed + .slider');
    if (!flashCb) return;
    if (label) {
      label.textContent = flashCb.checked ? 'Allowed' : 'Hidden';
      label.style.color = flashCb.checked ? 'var(--color-primary)' : 'var(--text-muted)';
    }
    if (slider) {
      slider.style.backgroundColor = flashCb.checked ? 'var(--color-primary)' : '#ccc';
    }
  }
  containerEl.querySelector('#switch-flash-allowed')?.addEventListener('change', () => {
    updateFlashVisuals();
    notify();
  });

  // Memoriad select all / clear
  containerEl.querySelector('#btn-memoriad-select-all')?.addEventListener('click', () => {
    const calCb = containerEl.querySelector('#check-memoriad-calendar');
    if (calCb) calCb.checked = true;
    containerEl.querySelectorAll('input[name="access_memoriad_cal_var"]').forEach((cb) => (cb.checked = true));
    containerEl.querySelectorAll('input[name="access_memoriad_module"]').forEach((cb) => (cb.checked = true));
    notify();
  });
  containerEl.querySelector('#btn-memoriad-clear-all')?.addEventListener('click', () => {
    const calCb = containerEl.querySelector('#check-memoriad-calendar');
    if (calCb) calCb.checked = false;
    containerEl.querySelectorAll('input[name="access_memoriad_cal_var"]').forEach((cb) => (cb.checked = false));
    containerEl.querySelectorAll('input[name="access_memoriad_module"]').forEach((cb) => (cb.checked = false));
    notify();
  });

  // Oral Rounds switch, select all / clear
  function updateOralVisuals() {
    const oralCb = containerEl.querySelector('#switch-oral-allowed');
    if (!oralCb) return;
    const label = containerEl.querySelector('#oral-status-label');
    const slider = containerEl.querySelector('#switch-oral-allowed + .slider');
    const badge = containerEl.querySelector('#summary-oral-rounds-badge');
    if (label) {
      label.textContent = oralCb.checked ? 'Allowed' : 'Hidden';
      label.style.color = oralCb.checked ? 'var(--color-primary)' : 'var(--text-muted)';
    }
    if (slider) slider.style.backgroundColor = oralCb.checked ? 'var(--color-primary)' : '#ccc';
    if (badge) {
      badge.textContent = formatOralBadge(
        oralCb.checked,
        containerEl.querySelectorAll('input[name="access_oral_op"]:checked').length,
        containerEl.querySelectorAll('input[name="access_oral_digit"]:checked').length
      );
    }
  }
  containerEl.querySelector('#btn-oral-select-all')?.addEventListener('click', () => {
    const oralCb = containerEl.querySelector('#switch-oral-allowed');
    if (oralCb) oralCb.checked = true;
    containerEl
      .querySelectorAll('input[name="access_oral_op"], input[name="access_oral_digit"]')
      .forEach((cb) => (cb.checked = true));
    updateOralVisuals();
    notify();
  });
  containerEl.querySelector('#btn-oral-clear-all')?.addEventListener('click', () => {
    containerEl
      .querySelectorAll('input[name="access_oral_op"], input[name="access_oral_digit"]')
      .forEach((cb) => (cb.checked = false));
    updateOralVisuals();
    notify();
  });
  // Simple switch, select all / clear
  function updateSimpleVisuals() {
    const simpleCb = containerEl.querySelector('#switch-simple-allowed');
    if (!simpleCb) return;
    const label = containerEl.querySelector('#simple-status-label');
    const slider = containerEl.querySelector('#switch-simple-allowed + .slider');
    const badge = containerEl.querySelector('#summary-simple-badge');
    if (label) {
      label.textContent = simpleCb.checked ? 'Allowed' : 'Hidden';
      label.style.color = simpleCb.checked ? 'var(--color-primary)' : 'var(--text-muted)';
    }
    if (slider) slider.style.backgroundColor = simpleCb.checked ? 'var(--color-primary)' : '#ccc';
    if (badge) {
      badge.textContent = formatSimpleBadge(
        simpleCb.checked,
        containerEl.querySelectorAll('input[name="access_simple_activity"]:checked').length
      );
    }
  }
  containerEl.querySelector('#btn-simple-select-all')?.addEventListener('click', () => {
    const simpleCb = containerEl.querySelector('#switch-simple-allowed');
    if (simpleCb) simpleCb.checked = true;
    containerEl.querySelectorAll('input[name="access_simple_activity"]').forEach((cb) => (cb.checked = true));
    updateSimpleVisuals();
    notify();
  });
  containerEl.querySelector('#btn-simple-clear-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_simple_activity"]').forEach((cb) => (cb.checked = false));
    updateSimpleVisuals();
    notify();
  });

  // Presets toggle every checkbox, so refresh the Oral Rounds and Simple visuals after them too.
  ['#btn-preset-full-access', '#btn-preset-level-1', '#btn-preset-clear-all'].forEach((sel) => {
    containerEl.querySelector(sel)?.addEventListener('click', updateOralVisuals);
    containerEl.querySelector(sel)?.addEventListener('click', updateSimpleVisuals);
  });

  // Main Round select all / clear
  containerEl.querySelector('#btn-main-round-select-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_main_round_cat"]').forEach((cb) => {
      if (!cb.disabled) cb.checked = true;
    });
    notify();
  });
  containerEl.querySelector('#btn-main-round-clear-all')?.addEventListener('click', () => {
    containerEl.querySelectorAll('input[name="access_main_round_cat"]').forEach((cb) => {
      if (!cb.disabled) cb.checked = false;
    });
    notify();
  });

  // Any change notifies
  containerEl.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      if (e.target.matches('#switch-oral-allowed, input[name="access_oral_op"], input[name="access_oral_digit"]')) {
        updateOralVisuals();
      }
      if (e.target.matches('#switch-simple-allowed, input[name="access_simple_activity"]')) {
        updateSimpleVisuals();
      }
      notify();
    }
  });
}
