import fs from 'node:fs';
import { extractAllSectionsForGroup } from './extractJmcwcSections.js';

// Read 2026.3 specs directly from docs/JMCWC_PAPERS_2026_3.sql
const sqlContent = fs.readFileSync('docs/JMCWC_PAPERS_2026_3.sql', 'utf8');

function extractSpecForGroup(sql, group) {
  const marker = `'${group}',\n      '2026.3',\n      false,\n      '`;
  const start = sql.indexOf(marker);
  if (start === -1) throw new Error(`Could not find marker for ${group}`);
  const jsonStart = start + marker.length;
  const jsonEnd = sql.indexOf("'::jsonb", jsonStart);
  if (jsonEnd === -1) throw new Error(`Could not find jsonb end for ${group}`);
  const escaped = sql.slice(jsonStart, jsonEnd);
  const unescaped = escaped.replace(/''/g, "'");
  return JSON.parse(unescaped);
}

const j1_2026_3 = extractSpecForGroup(sqlContent, 'junior1');
const j2_2026_3 = extractSpecForGroup(sqlContent, 'junior2');
const sr_2026_3 = extractSpecForGroup(sqlContent, 'senior');

const j1Sections = extractAllSectionsForGroup('j1', 'JMCWC-2026-Simulator-Juniors-1.xlsx');
const j2Sections = extractAllSectionsForGroup('j2', 'JMCWC-2026-Simulator-Juniors-2.xlsx');
const srSections = extractAllSectionsForGroup('sr', 'JMCWC-2026-Simulator-Seniors.xlsx');

const blueprintContent = `/**
 * Trendz Tracker — Phase 17a: JMCWC Simulator Versioned Blueprints & Validator (api/_jmcwcBlueprints.js)
 *
 * Defines the canonical 23-category sheet registry matching \`public.jmcwc_categories\`,
 * validates \`jmcwc_papers\` blueprint objects (\`spec.sections[{ key, questions: [{ slot, max_marks, generator, parameters }] }]\`),
 * and provides source-verified versioned blueprints for \`junior1\`, \`junior2\`, and \`senior\`.
 *
 * PRESERVED VERSIONS:
 * - \`2026.3\` (historical published/staged version, preserved strictly immutable)
 * - \`2026.4\` (source-faithful unpublished version with active dependency chains)
 */

import { JMCWC_CATEGORY_KEYS, JMCWC_GROUPS } from './_jmcwcMath.js';

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

export const VERIFIED_BROKEN_WORKBOOK_REPAIRS = Object.freeze([
  {
    category_key: 'multiplication',
    workbook_sheet: 'Int Mults',
    cells: ['H7', 'H12', 'AF16', 'AF22'],
    issue: 'Broken cell references in Int Mults H7/H12 and orphaned AF generator rows.',
    resolution: 'Verified that the active paper has 20 questions in cols C:D (A1..A10) and K:L (B1..B10) summed in L56=L54+D54; middle col G:H is an unprinted remnant.',
    status: 'resolved_verified',
  },
  {
    category_key: 'brackets',
    workbook_sheet: 'Brackets',
    cells: ['B43', 'CZ44'],
    issue: 'Broken formula in Brackets B43 dormant branches (AC43=5, AC43=8) and CZ44.',
    resolution: 'In all 3 workbooks AC43=6 evaluates active branch DW43 (answer DV43, 100% intact); CZ44 repaired to "("&DA43&" + "&DC43&DD43&DE43&" + "&DG43&")" and B43 updated.',
    status: 'resolved_verified',
  },
  {
    category_key: 'fraction_mul',
    workbook_sheet: 'Fraction Multiplications',
    cells: ['BD229..HT239'],
    issue: 'Broken reference in Fraction Multiplications BD229 and downstream dependencies.',
    resolution: 'Verified that the active paper has 17 questions in rows R9..R217 summed in Z241; rows 229..239 are unprinted helper rows from a deleted 18th question.',
    status: 'resolved_verified',
  },
  {
    category_key: 'cube_root',
    workbook_sheet: 'Cube Roots - Exact',
    cells: ['S51'],
    issue: 'Broken reference in Cube Roots - Exact S51 (hidden sequence counter).',
    resolution: 'Repaired S51 = S49 + 1 (= 23); question radicand C51, answer G51, and mark I51 are 100% intact and summed in I53.',
    status: 'resolved_verified',
  },
]);

// Preserved historical 2026.3 blueprints
export const JMCWC_PAPERS_2026_3 = Object.freeze({
  junior1: {
    group_key: 'junior1',
    version: '2026.3',
    published: false,
    spec: ${JSON.stringify(j1_2026_3, null, 2)},
  },
  junior2: {
    group_key: 'junior2',
    version: '2026.3',
    published: false,
    spec: ${JSON.stringify(j2_2026_3, null, 2)},
  },
  senior: {
    group_key: 'senior',
    version: '2026.3',
    published: false,
    spec: ${JSON.stringify(sr_2026_3, null, 2)},
  },
});

// New source-faithful 2026.4 blueprints (unpublished)
export const JMCWC_PAPERS_2026_4 = Object.freeze({
  junior1: {
    group_key: 'junior1',
    version: '2026.4',
    published: false,
    spec: {
      schema_version: '17a.1',
      source_workbook: 'JMCWC-2026-Simulator-Juniors-1.xlsx',
      source_verified: true,
      flat_duration_seconds: 7200,
      total_questions: 440,
      total_cached_marks: 2310,
      repairs: VERIFIED_BROKEN_WORKBOOK_REPAIRS,
      sections: ${JSON.stringify(j1Sections, null, 2)},
    },
  },
  junior2: {
    group_key: 'junior2',
    version: '2026.4',
    published: false,
    spec: {
      schema_version: '17a.1',
      source_workbook: 'JMCWC-2026-Simulator-Juniors-2.xlsx',
      source_verified: true,
      flat_duration_seconds: 7200,
      total_questions: 445,
      total_cached_marks: 2469,
      repairs: VERIFIED_BROKEN_WORKBOOK_REPAIRS,
      sections: ${JSON.stringify(j2Sections, null, 2)},
    },
  },
  senior: {
    group_key: 'senior',
    version: '2026.4',
    published: false,
    spec: {
      schema_version: '17a.1',
      source_workbook: 'JMCWC-2026-Simulator-Seniors.xlsx',
      source_verified: true,
      flat_duration_seconds: 7200,
      total_questions: 446,
      total_cached_marks: 2595,
      repairs: VERIFIED_BROKEN_WORKBOOK_REPAIRS,
      sections: ${JSON.stringify(srSections, null, 2)},
    },
  },
});

// Default active paper blueprints point to 2026.4
export const JMCWC_PAPERS = JMCWC_PAPERS_2026_4;

// Backward-compatibility alias for 2026.3 tests
export const JMCWC_DRAFT_PAPERS = JMCWC_PAPERS_2026_3;

/**
 * Validate a \`jmcwc_papers\` record structure and check whether it is safe to publish.
 */
export function validatePaperBlueprint(paperRow) {
  const errors = [];
  const warnings = [];

  if (!paperRow || typeof paperRow !== 'object') {
    return { valid: false, canPublish: false, errors: ['Paper row must be an object'], warnings };
  }

  if (!JMCWC_GROUPS.includes(paperRow.group_key)) {
    errors.push(\`Invalid group_key: \${paperRow.group_key}\`);
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
      \`Expected \${JMCWC_CATEGORY_KEYS.length} category sections, found \${sectionKeys.length}\`
    );
  }

  for (let i = 0; i < JMCWC_CATEGORY_KEYS.length; i++) {
    const expectedKey = JMCWC_CATEGORY_KEYS[i];
    if (sectionKeys[i] !== expectedKey) {
      errors.push(
        \`Section at index \${i} must be '\${expectedKey}', found '\${sectionKeys[i] ?? 'missing'}'\`
      );
    }
  }

  for (const sec of spec.sections) {
    if (!Array.isArray(sec.questions) || sec.questions.length === 0) {
      errors.push(\`Section '\${sec.key}' must contain at least one question slot\`);
      continue;
    }
    const seenSlots = new Set();
    for (const q of sec.questions) {
      if (!Number.isInteger(q.slot) || q.slot < 1) {
        errors.push(\`Invalid slot number in section '\${sec.key}': \${q.slot}\`);
      }
      if (seenSlots.has(q.slot)) {
        errors.push(\`Duplicate slot \${q.slot} in section '\${sec.key}'\`);
      }
      seenSlots.add(q.slot);

      if (!Number.isInteger(q.max_marks) || q.max_marks <= 0) {
        errors.push(\`Invalid max_marks in section '\${sec.key}' slot \${q.slot}: \${q.max_marks}\`);
      }
      if (typeof q.generator !== 'string' || !q.generator.trim()) {
        errors.push(\`Missing generator in section '\${sec.key}' slot \${q.slot}\`);
      }
      if (!q.parameters || typeof q.parameters !== 'object') {
        errors.push(\`Missing parameters object in section '\${sec.key}' slot \${q.slot}\`);
        continue;
      }

      // Contract check: scoring metadata belongs inside parameters, NOT at slot level
      if ('scoring_mode' in q) {
        errors.push(\`Slot \${q.slot} in '\${sec.key}' has forbidden slot-level scoring_mode; must be inside parameters.\`);
      }
      if ('mark_rule' in q || 'mark_range' in q) {
        errors.push(\`Slot \${q.slot} in '\${sec.key}' has forbidden slot-level mark_rule/mark_range; must be inside parameters.\`);
      }

      const p = q.parameters;
      const scoringMode = p.scoring_mode || 'fixed';

      if (scoringMode === 'dynamic') {
        const validRules = {
          multiplication: ['multiplication_digits_product'],
          prime_factors: ['prime_factors_target_scale'],
          approximation: ['approximation_product_digits'],
          sum_squares: ['sum_squares_j1_decomposition', 'sum_squares_j2_target', 'sum_squares_sr_target'],
        };
        const allowed = validRules[sec.key];
        if (!allowed) {
          errors.push(\`Category '\${sec.key}' does not support dynamic scoring.\`);
        } else if (!allowed.includes(p.mark_rule)) {
          errors.push(\`Invalid mark_rule '\${p.mark_rule}' for category '\${sec.key}' in slot \${q.slot}.\`);
        }
        if (!Array.isArray(p.mark_range) || p.mark_range.length !== 2) {
          errors.push(\`Dynamic slot \${q.slot} in '\${sec.key}' missing ordered 2-element mark_range array.\`);
        } else {
          const [minM, maxM] = p.mark_range;
          if (!Number.isInteger(minM) || minM <= 0 || !Number.isInteger(maxM) || maxM <= 0 || minM > maxM) {
            errors.push(\`Dynamic slot \${q.slot} in '\${sec.key}' invalid mark_range [\${minM}, \${maxM}]: must be positive ordered integers.\`);
          } else if (q.max_marks < minM || q.max_marks > maxM) {
            errors.push(\`Baseline max_marks \${q.max_marks} outside mark_range [\${minM}, \${maxM}] for slot \${q.slot} in '\${sec.key}'.\`);
          }
        }
      } else if (scoringMode === 'fixed') {
        if ('mark_rule' in p) {
          errors.push(\`Fixed slot \${q.slot} in '\${sec.key}' must not declare mark_rule.\`);
        }
        if ('mark_range' in p) {
          errors.push(\`Fixed slot \${q.slot} in '\${sec.key}' must not declare mark_range.\`);
        }
      } else {
        errors.push(\`Invalid scoring_mode '\${scoringMode}' for slot \${q.slot} in '\${sec.key}'.\`);
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
`;

fs.writeFileSync('api/_jmcwcBlueprints.js', blueprintContent);
console.log('Successfully wrote api/_jmcwcBlueprints.js with both 2026.3 and 2026.4');
