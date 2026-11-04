import fs from 'node:fs';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';

function escapeSqlString(str) {
  return str.replace(/'/g, "''");
}

let sql = `-- =============================================================================
-- Trendz Tracker — Phase 17a: Validated JMCWC Simulator Papers Insertion SQL
-- Abacus Institute: Trendz Abacus
-- Purpose: Insert source-verified 2026.4 blueprints for junior1, junior2, and senior
--
-- STRICT TRANSACTION & CONFLICT GOVERNANCE:
-- - Inserts a version if it does not exist.
-- - If it already exists with identical spec and published status, leaves it unchanged.
-- - If it exists with different spec or published status, aborts transaction with clear error.
-- - NEVER overwrites an existing published version.
-- - Contains 100% complete JSON without any ellipses or placeholders.
--
-- Instructions for Owner:
-- Run this entire script in Supabase SQL Editor in one transaction.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_rec RECORD;
  v_existing RECORD;
BEGIN
  -- 1. Create temporary staging table with candidate blueprints
  CREATE TEMP TABLE _pending_papers (
    group_key TEXT NOT NULL,
    version TEXT NOT NULL,
    published BOOLEAN NOT NULL,
    spec JSONB NOT NULL
  ) ON COMMIT DROP;

  -- 2. Stage candidate papers
  INSERT INTO _pending_papers (group_key, version, published, spec)
  VALUES
`;

const rows = [];
for (const groupKey of ['junior1', 'junior2', 'senior']) {
  const paper = JMCWC_PAPERS[groupKey];
  const specJson = escapeSqlString(JSON.stringify(paper.spec));
  rows.push(`    (
      '${paper.group_key}',
      '${paper.version}',
      ${paper.published},
      '${specJson}'::jsonb
    )`);
}

sql += rows.join(',\n') + `;\n\n  -- 3. Validate and conditionally insert each paper\n  FOR v_rec IN SELECT * FROM _pending_papers ORDER BY group_key LOOP\n    SELECT group_key, version, published, spec\n    INTO v_existing\n    FROM public.jmcwc_papers\n    WHERE group_key = v_rec.group_key AND version = v_rec.version;\n\n    IF NOT FOUND THEN\n      -- Does not exist: insert fresh version\n      INSERT INTO public.jmcwc_papers (group_key, version, published, spec)\n      VALUES (v_rec.group_key, v_rec.version, v_rec.published, v_rec.spec);\n      RAISE NOTICE 'Inserted new paper % version %', v_rec.group_key, v_rec.version;\n    ELSIF v_existing.published = v_rec.published AND v_existing.spec = v_rec.spec THEN\n      -- Already exists with exactly the same spec and publication state: leave unchanged\n      RAISE NOTICE 'Paper % version % already exists with identical spec and status; left unchanged.', v_rec.group_key, v_rec.version;\n    ELSE\n      -- Exists with different content or state: abort with clear error\n      RAISE EXCEPTION 'Conflict: paper % version % already exists with different spec or published status (existing published=%, new published=%). Database prohibits modifying existing papers.',\n        v_rec.group_key, v_rec.version, v_existing.published, v_rec.published;\n    END IF;\n  END LOOP;\nEND $$;\n\nCOMMIT;\n\n-- Post-insertion verification query\nSELECT\n  group_key,\n  version,\n  published,\n  spec->>'source_workbook' AS source_workbook,\n  (spec->>'total_questions')::int AS total_questions,\n  (spec->>'total_cached_marks')::int AS total_cached_marks,\n  jsonb_array_length(spec->'sections') AS sections_count\nFROM public.jmcwc_papers\nWHERE version = ''2026.4''\nORDER BY group_key;\n`;

fs.writeFileSync('docs/JMCWC_PAPERS_2026_4.sql', sql);
console.log('Successfully wrote docs/JMCWC_PAPERS_2026_4.sql (' + Math.round(sql.length / 1024) + ' KB)');
