/**
 * Trendz Tracker — Phase 17a: JMCWC Simulator Versioned Blueprints & Validator (api/_jmcwcBlueprints.js)
 *
 * Defines the canonical 23-category sheet registry matching `public.jmcwc_categories`,
 * validates `jmcwc_papers` blueprint objects (`spec.sections[{ key, questions: [{ slot, max_marks, generator, parameters }] }]`),
 * and provides draft versioned blueprints for `junior1`, `junior2`, and `senior`.
 *
 * IMPORTANT SOURCE GOVERNANCE:
 * - Because `JMCWC-2026-Simulator-Juniors-1.xlsx`, `JMCWC-2026-Simulator-Juniors-2.xlsx`,
 *   `JMCWC-2026-Simulator-Seniors.xlsx`, and `JMCWC Rules 2025.pdf` were not attached to the conversation
 *   or present in the workspace/Supabase Storage, all three group blueprints are explicitly marked
 *   `published: false` (`source_verified: false`), with unresolved cell references documented.
 * - `validatePaperBlueprintForPublish` blocks setting `published: true` until cell-by-cell workbook
 *   formulas and the 4 known broken references (`Int Mults H7/H12`, `Brackets B43`,
 *   `Fraction Multiplications BD229`, `Cube Roots - Exact S51`) are verified against the attached `.xlsx` files.
 */

import { JMCWC_CATEGORY_KEYS, JMCWC_GROUPS } from './_jmcwcMath.js';

/**
 * Exact 23-category registry verified against `public.jmcwc_categories` in Supabase Mumbai.
 */
export const JMCWC_CATEGORY_REGISTRY = Object.freeze([
  { sort_order: 1, key: 'addition', title: 'Integer addition', workbook_sheet: 'Int Adds' },
  { sort_order: 2, key: 'subtraction', title: 'Integer subtraction', workbook_sheet: 'Int Subs' },
  { sort_order: 3, key: 'mixed', title: 'Mixed addition and subtraction', workbook_sheet: 'Mixed adds+subs' },
  { sort_order: 4, key: 'multiplication', title: 'Integer multiplication', workbook_sheet: 'Int Mults' },
  { sort_order: 5, key: 'division', title: 'Integer division', workbook_sheet: 'Int Divs' },
  { sort_order: 6, key: 'brackets', title: 'Brackets', workbook_sheet: 'Brackets' },
  { sort_order: 7, key: 'prime_factors', title: 'Prime factorisation', workbook_sheet: 'Primes' },
  { sort_order: 8, key: 'hcf_lcm', title: 'HCF and LCM', workbook_sheet: 'HCF LCM' },
  { sort_order: 9, key: 'fraction_add', title: 'Fraction addition', workbook_sheet: 'Fraction Additions' },
  { sort_order: 10, key: 'fraction_sub', title: 'Fraction subtraction', workbook_sheet: 'Fraction Subtractions' },
  { sort_order: 11, key: 'fraction_mul', title: 'Fraction multiplication', workbook_sheet: 'Fraction Multiplications' },
  { sort_order: 12, key: 'fraction_div', title: 'Fraction division', workbook_sheet: 'Fraction Divisions' },
  { sort_order: 13, key: 'approximation', title: 'Approximations', workbook_sheet: 'Approximations' },
  { sort_order: 14, key: 'remainder', title: 'Remainders', workbook_sheet: 'Remainders' },
  { sort_order: 15, key: 'ratio', title: 'Ratios', workbook_sheet: 'Ratios' },
  { sort_order: 16, key: 'square_root', title: 'Perfect square roots', workbook_sheet: 'Perfect Square Roots' },
  { sort_order: 17, key: 'inexact_square_root', title: 'Inexact square roots', workbook_sheet: 'Irrational Square Roots' },
  { sort_order: 18, key: 'next_square', title: 'Next squares', workbook_sheet: 'Next Squares' },
  { sort_order: 19, key: 'cube_root', title: 'Exact cube roots', workbook_sheet: 'Cube Roots - Exact' },
  { sort_order: 20, key: 'next_cube', title: 'Next cubes', workbook_sheet: 'Next Cubes' },
  { sort_order: 21, key: 'calendar', title: 'Calendars', workbook_sheet: 'Calendars' },
  { sort_order: 22, key: 'elapsed_time', title: 'Elapsed time', workbook_sheet: 'Times Elapsed' },
  { sort_order: 23, key: 'sum_squares', title: 'Sums of squares', workbook_sheet: 'Sums of Squares' },
]);

export const KNOWN_BROKEN_WORKBOOK_REFERENCES = Object.freeze([
  {
    category_key: 'multiplication',
    workbook_sheet: 'Int Mults',
    cells: ['H7', 'H12'],
    issue: 'Broken cell references in Int Mults H7/H12 and upstream generator helper cells.',
    status: 'unresolved_awaiting_xlsx_attachment',
  },
  {
    category_key: 'brackets',
    workbook_sheet: 'Brackets',
    cells: ['B43'],
    issue: 'Broken formula/reference in Brackets B43.',
    status: 'unresolved_awaiting_xlsx_attachment',
  },
  {
    category_key: 'fraction_mul',
    workbook_sheet: 'Fraction Multiplications',
    cells: ['BD229'],
    issue: 'Broken reference in Fraction Multiplications BD229 and downstream dependencies.',
    status: 'unresolved_awaiting_xlsx_attachment',
  },
  {
    category_key: 'cube_root',
    workbook_sheet: 'Cube Roots - Exact',
    cells: ['S51'],
    issue: 'Broken reference in Cube Roots - Exact S51.',
    status: 'unresolved_awaiting_xlsx_attachment',
  },
]);

/**
 * Build a structured 23-section blueprint for a given group tier ('junior1' | 'junior2' | 'senior')
 * so that all 23 category generators, subtypes, and grading paths can be deterministically tested.
 * Marked `published: false` and `source_verified: false` until the 3 `.xlsx` files are inspected.
 */
function buildGroupBlueprintSpec(groupKey, workbookFilename) {
  const tier = groupKey === 'senior' ? 3 : groupKey === 'junior2' ? 2 : 1;

  const sectionBuilders = {
    addition: () => [
      {
        slot: 1,
        max_marks: 1,
        generator: 'addition',
        parameters: { subtype: 'standard', terms: 2, digits: [2 + tier, 2 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Adds', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 2,
        generator: 'addition',
        parameters: { subtype: 'missing_digit', terms: 2, digits: [3 + tier, 3 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Adds', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    subtraction: () => [
      {
        slot: 1,
        max_marks: 1,
        generator: 'subtraction',
        parameters: { subtype: 'standard', minuend_digits: [3 + tier, 4 + tier], subtrahend_digits: [2 + tier, 3 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Subs', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 2,
        generator: 'subtraction',
        parameters: { subtype: 'missing_digit', minuend_digits: [3 + tier, 4 + tier], subtrahend_digits: [3, 3 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Subs', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    mixed: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'mixed',
        parameters: { terms: 3 + tier, digits: [2 + tier, 3 + tier], allow_negative: tier >= 2 },
        source_ref: { workbook: workbookFilename, sheet: 'Mixed adds+subs', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    multiplication: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'multiplication',
        parameters: { subtype: 'standard', factor_digits: [1 + tier, 2 + tier] },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Int Mults',
          broken_ref_note: 'Inspect H7/H12 and upstream helper cells once workbook is attached',
          status: 'unresolved_broken_ref_H7_H12',
        },
      },
      {
        slot: 2,
        max_marks: 3,
        generator: 'multiplication',
        parameters: { subtype: 'missing_digit', factor_digits: [2, 2 + tier] },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Int Mults',
          broken_ref_note: 'Inspect H7/H12 and upstream helper cells once workbook is attached',
          status: 'unresolved_broken_ref_H7_H12',
        },
      },
    ],
    division: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'division',
        parameters: { subtype: 'exact', divisor_digits: [1, 1 + tier], quotient_digits: [2, 2 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Divs', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 3,
        generator: 'division',
        parameters: { subtype: 'missing_digit', divisor_digits: [2, 2], quotient_digits: [2, 2 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Int Divs', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    brackets: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'brackets',
        parameters: { subtype: 'sum_of_products', digits: 1 + tier },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Brackets',
          broken_ref_note: 'Inspect Brackets B43 once workbook is attached',
          status: 'unresolved_broken_ref_B43',
        },
      },
      {
        slot: 2,
        max_marks: 3,
        generator: 'brackets',
        parameters: { subtype: 'difference_of_squares', digits: 1 + tier },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Brackets',
          broken_ref_note: 'Inspect Brackets B43 once workbook is attached',
          status: 'unresolved_broken_ref_B43',
        },
      },
    ],
    prime_factors: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'prime_factors',
        parameters: {
          primes_pool: tier === 1 ? [2, 3, 5, 7, 11] : [2, 3, 5, 7, 11, 13, 17, 19],
          min_factors: 2 + tier,
          max_factors: 3 + tier,
        },
        source_ref: { workbook: workbookFilename, sheet: 'Primes', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    hcf_lcm: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'hcf_lcm',
        parameters: { subtype: 'hcf_2', min_gcd: 4, max_gcd: 12 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'HCF LCM', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 2,
        generator: 'hcf_lcm',
        parameters: { subtype: 'lcm_2', min_gcd: 3, max_gcd: 10 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'HCF LCM', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 3,
        max_marks: 3,
        generator: 'hcf_lcm',
        parameters: { subtype: 'hcf_3', min_gcd: 4, max_gcd: 10 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'HCF LCM', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    fraction_add: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'fraction_add',
        parameters: { min_den: 2, max_den: 6 + 3 * tier, max_whole: tier },
        source_ref: { workbook: workbookFilename, sheet: 'Fraction Additions', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    fraction_sub: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'fraction_sub',
        parameters: { min_den: 2, max_den: 6 + 3 * tier, max_whole: 1 + tier, allow_negative: false },
        source_ref: { workbook: workbookFilename, sheet: 'Fraction Subtractions', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    fraction_mul: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'fraction_mul',
        parameters: { min_den: 2, max_den: 6 + 3 * tier, max_whole: tier },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Fraction Multiplications',
          broken_ref_note: 'Inspect Fraction Multiplications BD229 and dependencies once workbook is attached',
          status: 'unresolved_broken_ref_BD229',
        },
      },
    ],
    fraction_div: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'fraction_div',
        parameters: { min_den: 2, max_den: 6 + 2 * tier, max_whole: tier },
        source_ref: { workbook: workbookFilename, sheet: 'Fraction Divisions', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    approximation: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'approximation',
        parameters: { subtype: 'sig_figs_product', sig_figs: 1 + tier },
        source_ref: { workbook: workbookFilename, sheet: 'Approximations', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    remainder: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'remainder',
        parameters: { dividend_digits: [2 + tier, 3 + tier], divisor_min: 7, divisor_max: 25 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'Remainders', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    ratio: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'ratio',
        parameters: { subtype: 'missing_term' },
        source_ref: { workbook: workbookFilename, sheet: 'Ratios', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 2,
        generator: 'ratio',
        parameters: { subtype: 'simplify' },
        source_ref: { workbook: workbookFilename, sheet: 'Ratios', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    square_root: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'square_root',
        parameters: { root_digits: [2, 1 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Perfect Square Roots', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    inexact_square_root: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'inexact_square_root',
        parameters: { target_decimals: tier === 3 ? 2 : 1, min_radicand: 50, max_radicand: 1500 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'Irrational Square Roots', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    next_square: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'next_square',
        parameters: { subtype: 'next_square_value', root_digits: [2, 1 + tier] },
        source_ref: { workbook: workbookFilename, sheet: 'Next Squares', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    cube_root: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'cube_root',
        parameters: { root_digits: [2, 2] },
        source_ref: {
          workbook: workbookFilename,
          sheet: 'Cube Roots - Exact',
          broken_ref_note: 'Inspect Cube Roots - Exact S51 once workbook is attached',
          status: 'unresolved_broken_ref_S51',
        },
      },
    ],
    next_cube: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'next_cube',
        parameters: { subtype: 'next_cube_value', min_root: 5, max_root: 15 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'Next Cubes', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    calendar: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'calendar',
        parameters: { subtype: 'weekday', year_min: 1600, year_max: 2099 },
        source_ref: { workbook: workbookFilename, sheet: 'Calendars', status: 'awaiting_workbook_cell_inspection' },
      },
      {
        slot: 2,
        max_marks: 2,
        generator: 'calendar',
        parameters: { subtype: 'month', year_min: 1900, year_max: 2099 },
        source_ref: { workbook: workbookFilename, sheet: 'Calendars', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    elapsed_time: () => [
      {
        slot: 1,
        max_marks: 2,
        generator: 'elapsed_time',
        parameters: { format: 'hours_minutes', min_minutes: 45, max_minutes: 600 },
        source_ref: { workbook: workbookFilename, sheet: 'Times Elapsed', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
    sum_squares: () => [
      {
        slot: 1,
        max_marks: 3,
        generator: 'sum_squares',
        parameters: { min_count: 2, max_count: 4, min_base: 2, max_base: 10 * tier },
        source_ref: { workbook: workbookFilename, sheet: 'Sums of Squares', status: 'awaiting_workbook_cell_inspection' },
      },
    ],
  };

  const sections = JMCWC_CATEGORY_REGISTRY.map((cat) => ({
    key: cat.key,
    workbook_sheet: cat.workbook_sheet,
    questions: sectionBuilders[cat.key](),
  }));

  return {
    schema_version: '17a-draft.1',
    source_workbook: workbookFilename,
    source_verified: false,
    flat_duration_seconds: 7200,
    unresolved_slots: KNOWN_BROKEN_WORKBOOK_REFERENCES,
    notes:
      'Draft unpublished blueprint scaffolding all 23 visible workbook sheets. Actual per-slot cell formulas and broken cell repairs (Int Mults H7/H12, Brackets B43, Fraction Multiplications BD229, Cube Roots - Exact S51) require attaching the 3 .xlsx workbooks and 2025 Rules PDF before setting published=true.',
    sections,
  };
}

export const JMCWC_DRAFT_PAPERS = Object.freeze({
  junior1: {
    group_key: 'junior1',
    version: '2026.17a-unpublished',
    published: false,
    spec: buildGroupBlueprintSpec('junior1', 'JMCWC-2026-Simulator-Juniors-1.xlsx'),
  },
  junior2: {
    group_key: 'junior2',
    version: '2026.17a-unpublished',
    published: false,
    spec: buildGroupBlueprintSpec('junior2', 'JMCWC-2026-Simulator-Juniors-2.xlsx'),
  },
  senior: {
    group_key: 'senior',
    version: '2026.17a-unpublished',
    published: false,
    spec: buildGroupBlueprintSpec('senior', 'JMCWC-2026-Simulator-Seniors.xlsx'),
  },
});

/**
 * Validate a `jmcwc_papers` record structure and check whether it is safe to publish.
 */
export function validatePaperBlueprint(paperRow) {
  const errors = [];
  const warnings = [];

  if (!paperRow || typeof paperRow !== 'object') {
    return { valid: false, canPublish: false, errors: ['Paper row must be an object'], warnings };
  }

  if (!JMCWC_GROUPS.includes(paperRow.group_key)) {
    errors.push(`Invalid group_key: ${paperRow.group_key}`);
  }

  if (typeof paperRow.version !== 'string' || !paperRow.version.trim()) {
    errors.push('Paper version must be a non-empty string');
  }

  const spec = paperRow.spec;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.sections)) {
    errors.push('Paper spec.sections must be an array');
    return { valid: false, canPublish: false, errors, warnings };
  }

  const sectionKeys = spec.sections.map((s) => s.key);
  if (sectionKeys.length !== JMCWC_CATEGORY_KEYS.length) {
    errors.push(
      `Expected ${JMCWC_CATEGORY_KEYS.length} category sections, found ${sectionKeys.length}`
    );
  }

  for (let i = 0; i < JMCWC_CATEGORY_KEYS.length; i++) {
    const expectedKey = JMCWC_CATEGORY_KEYS[i];
    if (sectionKeys[i] !== expectedKey) {
      errors.push(
        `Section at index ${i} must be '${expectedKey}', found '${sectionKeys[i] ?? 'missing'}'`
      );
    }
  }

  for (const sec of spec.sections) {
    if (!Array.isArray(sec.questions) || sec.questions.length === 0) {
      errors.push(`Section '${sec.key}' must contain at least one question slot`);
      continue;
    }
    const seenSlots = new Set();
    for (const q of sec.questions) {
      if (!Number.isInteger(q.slot) || q.slot < 1) {
        errors.push(`Invalid slot number in section '${sec.key}': ${q.slot}`);
      }
      if (seenSlots.has(q.slot)) {
        errors.push(`Duplicate slot ${q.slot} in section '${sec.key}'`);
      }
      seenSlots.add(q.slot);

      if (!Number.isFinite(q.max_marks) || q.max_marks <= 0) {
        errors.push(`Invalid max_marks in section '${sec.key}' slot ${q.slot}: ${q.max_marks}`);
      }
      if (typeof q.generator !== 'string' || !q.generator.trim()) {
        errors.push(`Missing generator in section '${sec.key}' slot ${q.slot}`);
      }
      if (!q.parameters || typeof q.parameters !== 'object') {
        errors.push(`Missing parameters object in section '${sec.key}' slot ${q.slot}`);
      }
    }
  }

  const hasUnresolvedSlots =
    Array.isArray(spec.unresolved_slots) &&
    spec.unresolved_slots.some((u) => u.status && String(u.status).startsWith('unresolved'));
  const isSourceVerified = spec.source_verified === true;

  if (!isSourceVerified || hasUnresolvedSlots) {
    warnings.push(
      'Blueprint has unverified workbook sources or unresolved broken formula slots; must remain published=false.'
    );
  }

  if (paperRow.published === true && (!isSourceVerified || hasUnresolvedSlots)) {
    errors.push(
      'Cannot set published=true while source_verified is false or unresolved_slots remain.'
    );
  }

  return {
    valid: errors.length === 0,
    canPublish: errors.length === 0 && isSourceVerified && !hasUnresolvedSlots,
    errors,
    warnings,
  };
}
