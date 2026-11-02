import fs from 'node:fs';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';

function escapeSqlString(str) {
  return str.replace(/'/g, "''");
}

let sql = `-- =============================================================================
-- Trendz Tracker — Phase 17a: Validated JMCWC Simulator Papers Insertion SQL
-- Abacus Institute: Trendz Abacus
-- Purpose: Insert source-verified 2026.1 blueprints for junior1, junior2, and senior
--
-- SOURCE VERIFICATION RECORD:
-- - Junior 1: JMCWC-2026-Simulator-Juniors-1.xlsx (440 questions, 2,310 cached marks)
-- - Junior 2: JMCWC-2026-Simulator-Juniors-2.xlsx (445 questions, 2,469 cached marks)
-- - Senior:   JMCWC-2026-Simulator-Seniors.xlsx   (446 questions, 2,595 cached marks)
-- - PDF Rules: JMCWC Rules 2025.pdf (All 15 official contest rules & examples verified)
-- - Broken Formula Repairs:
--   1. Int Mults H7/H12: Active paper uses cols C:D and K:L (20 questions); cols G:H pruned.
--   2. Brackets B43 & CZ44: Active AC43=6 uses DW43; dormant CZ44 & B43 formulas repaired.
--   3. Fraction Multiplications BD229: 17 active printed blocks verified; orphaned rows pruned.
--   4. Cube Roots - Exact S51: Repaired to S49 + 1 (= 23); 23 active slots verified.
--
-- Instructions for Owner:
-- Run this entire script in Supabase SQL Editor in one transaction.
-- =============================================================================

BEGIN;

INSERT INTO public.jmcwc_papers (group_key, version, published, spec)
VALUES
`;

const rows = [];
for (const groupKey of ['junior1', 'junior2', 'senior']) {
  const paper = JMCWC_PAPERS[groupKey];
  const specJson = escapeSqlString(JSON.stringify(paper.spec));
  rows.push(`  (
    '${paper.group_key}',
    '${paper.version}',
    ${paper.published},
    '${specJson}'::jsonb
  )`);
}

sql += rows.join(',\n') + `\nON CONFLICT (group_key, version) DO UPDATE SET\n  published = EXCLUDED.published,\n  spec = EXCLUDED.spec;\n\nCOMMIT;\n\n-- Post-insertion verification query\nSELECT\n  group_key,\n  version,\n  published,\n  spec->>'source_workbook' AS source_workbook,\n  (spec->>'total_questions')::int AS total_questions,\n  (spec->>'total_cached_marks')::int AS total_cached_marks,\n  jsonb_array_length(spec->'sections') AS sections_count\nFROM public.jmcwc_papers\nWHERE version = '2026.1'\nORDER BY group_key;\n`;

fs.writeFileSync('docs/JMCWC_PHASE17A.sql', sql);
console.log('Successfully wrote docs/JMCWC_PHASE17A.sql (' + Math.round(sql.length / 1024) + ' KB)');
