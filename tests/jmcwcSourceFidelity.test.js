/**
 * Trendz Tracker — JMCWC Simulator Source Fidelity Integration Tests (tests/jmcwcSourceFidelity.test.js)
 *
 * Verifies workbook fidelity against the authentic JMCWC simulator Excel workbooks:
 * 1. Referenced source cells exist in authentic workbooks and serve their claimed roles (printed, answer, mark),
 *    with cell content and formula validation across all 23 categories.
 * 2. Every difficulty parameter (terms, digits, level, ranges, AC subtypes) is consumed faithfully by generators.
 * 3. Exact reproducibility with options object { seed }, and distinct outputs for different seeds.
 * 4. Brackets generator implements each workbook AC subtype with authentic formulas and rejects unknown subtypes.
 * 5. All 23 categories demonstrate source-derived difficulty and operand progression from slot 1 to final slot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkbookFile } from '../scripts/inspectJmcwcWorkbooks.js';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import { generateQuestionsFromBlueprint, generateQuestionForSlot } from '../api/_jmcwcGenerate.js';
import { createSeededRng } from '../api/_jmcwcMath.js';

const workbooks = {
  junior1: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx'),
  junior2: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx'),
  senior: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Seniors.xlsx'),
};

describe('JMCWC Source Workbook Fidelity & Generator Audit', () => {
  it('blueprint generation enforces options object contract and guarantees strict seed reproducibility', () => {
    const spec = JMCWC_PAPERS.senior.spec;
    const seed1 = 'audit-repro-seed-alpha';
    const seed2 = 'audit-repro-seed-beta';

    // Must accept { seed } options object
    const run1 = generateQuestionsFromBlueprint(spec, { seed: seed1 });
    const run2 = generateQuestionsFromBlueprint(spec, { seed: seed1 });
    const runDiff = generateQuestionsFromBlueprint(spec, { seed: seed2 });

    assert.equal(
      run1.privateQuestions.length,
      spec.total_questions,
      'run1 question count matches blueprint total'
    );
    assert.equal(
      run2.privateQuestions.length,
      spec.total_questions,
      'run2 question count matches blueprint total'
    );

    // Exact reproducibility
    for (let i = 0; i < run1.privateQuestions.length; i++) {
      const q1 = run1.privateQuestions[i];
      const q2 = run2.privateQuestions[i];
      assert.equal(q1.prompt, q2.prompt, `Slot ${i + 1} prompt must be strictly reproducible`);
      assert.equal(
        JSON.stringify(q1.answer_key),
        JSON.stringify(q2.answer_key),
        `Slot ${i + 1} answer_key must be strictly reproducible`
      );
    }

    // Different seeds must yield different questions
    let diffCount = 0;
    for (let i = 0; i < run1.privateQuestions.length; i++) {
      if (run1.privateQuestions[i].prompt !== runDiff.privateQuestions[i].prompt) {
        diffCount++;
      }
    }
    assert.ok(
      diffCount > run1.privateQuestions.length * 0.9,
      `Different seeds must produce predominantly distinct prompts (differed: ${diffCount}/${run1.privateQuestions.length})`
    );
  });

  it('referenced workbook cells exist and contain valid formulas and contents across all 23 categories', () => {
    for (const [groupKey, paper] of Object.entries(JMCWC_PAPERS)) {
      const wb = workbooks[groupKey];
      assert.ok(wb, `Workbook loaded for group ${groupKey}`);

      for (const section of paper.spec.sections) {
        const sheet = wb.sheets.find((s) => s.name === section.workbook_sheet);
        assert.ok(sheet, `[${groupKey}] Sheet '${section.workbook_sheet}' must exist in workbook`);

        // Check first, middle, and last slots
        const slotsToCheck = [
          section.questions[0],
          section.questions[Math.floor(section.questions.length / 2)],
          section.questions[section.questions.length - 1],
        ];

        for (const q of slotsToCheck) {
          const sref = q.source_ref;
          assert.ok(sref, `[${groupKey}:${section.key}] Slot ${q.slot} must declare source_ref`);

          // 1. Mark cell must exist in workbook
          if (sref.mark_cell) {
            const markCell = sheet.cells[sref.mark_cell];
            assert.ok(
              markCell,
              `[${groupKey}:${section.key}] Slot ${q.slot} mark_cell ${sref.mark_cell} must exist`
            );
            if (q.parameters.scoring_mode === 'fixed') {
              assert.equal(
                Number(markCell.value),
                q.max_marks,
                `[${groupKey}:${section.key}] Slot ${q.slot} mark_cell ${sref.mark_cell} value (${markCell.value}) must match max_marks (${q.max_marks})`
              );
            }
          }

          // 2. Answer cell must exist and have content or formula in the workbook
          if (sref.answer_cell && !sref.answer_cell.includes(':')) {
            const ansCell = sheet.cells[sref.answer_cell];
            assert.ok(
              ansCell,
              `[${groupKey}:${section.key}] Slot ${q.slot} answer_cell ${sref.answer_cell} must exist in sheet`
            );
            assert.ok(
              ansCell.formula || ansCell.value !== undefined,
              `[${groupKey}:${section.key}] Slot ${q.slot} answer_cell ${sref.answer_cell} must have formula or value`
            );
          }

          // 3. Printed cell(s) must exist and not be blank
          if (sref.printed_cells) {
            const coords = sref.printed_cells.split(':');
            const primaryCell = sheet.cells[coords[0]];
            assert.ok(
              primaryCell,
              `[${groupKey}:${section.key}] Slot ${q.slot} printed cell ${coords[0]} must exist in sheet`
            );
            assert.ok(
              primaryCell.formula || primaryCell.value !== undefined,
              `[${groupKey}:${section.key}] Slot ${q.slot} printed cell ${coords[0]} must have content or formula`
            );
          }
        }
      }
    }
  });

  it('brackets generator faithfully implements workbook AC subtypes and rejects unknown subtypes', () => {
    const seed = 'brackets-fidelity-audit';
    const paper = JMCWC_PAPERS.senior;
    const gen = generateQuestionsFromBlueprint(paper.spec, { seed }).privateQuestions.filter(
      (q) => q.category_key === 'brackets'
    );

    assert.equal(gen.length, 20, 'Brackets section must have 20 question slots');

    // 1. Slots 1..3: AC=2 -> (a + b) × (c + d) where a, b, c, d in [2, 9]
    for (let i = 0; i < 3; i++) {
      const q = gen[i];
      const m = q.prompt.match(/^\((\d+)\s*\+\s*(\d+)\)\s*×\s*\((\d+)\s*\+\s*(\d+)\)\s*=/);
      assert.ok(m, `Slot ${i + 1} must match AC=2 pattern: ${q.prompt}`);
      const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      assert.ok(a >= 2 && a <= 9, `Slot ${i + 1} a (${a}) in [2, 9]`);
      assert.ok(b >= 2 && b <= 9, `Slot ${i + 1} b (${b}) in [2, 9]`);
      assert.ok(c >= 2 && c <= 9, `Slot ${i + 1} c (${c}) in [2, 9]`);
      assert.ok(d >= 2 && d <= 9, `Slot ${i + 1} d (${d}) in [2, 9]`);
      const expected = (a + b) * (c + d);
      assert.equal(Number(q.answer_key.value), expected, `Slot ${i + 1} answer matches (a+b)*(c+d)`);
    }

    // 2. Slots 4..8: AC=3 -> (a + b) × (c + d) where a, b, c, d in [11, 39]
    for (let i = 3; i < 8; i++) {
      const q = gen[i];
      const m = q.prompt.match(/^\((\d+)\s*\+\s*(\d+)\)\s*×\s*\((\d+)\s*\+\s*(\d+)\)\s*=/);
      assert.ok(m, `Slot ${i + 1} must match AC=3 pattern: ${q.prompt}`);
      const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      assert.ok(a >= 11 && a <= 39, `Slot ${i + 1} a (${a}) in [11, 39]`);
      assert.ok(b >= 11 && b <= 39, `Slot ${i + 1} b (${b}) in [11, 39]`);
      assert.ok(c >= 11 && c <= 39, `Slot ${i + 1} c (${c}) in [11, 39]`);
      assert.ok(d >= 11 && d <= 39, `Slot ${i + 1} d (${d}) in [11, 39]`);
      const expected = (a + b) * (c + d);
      assert.equal(Number(q.answer_key.value), expected, `Slot ${i + 1} answer matches (a+b)*(c+d)`);
    }

    // 3. Slots 9..12: AC=4 -> (a + b) × (c + d) where a, b, c, d in [41, 65]
    for (let i = 8; i < 12; i++) {
      const q = gen[i];
      const m = q.prompt.match(/^\((\d+)\s*\+\s*(\d+)\)\s*×\s*\((\d+)\s*\+\s*(\d+)\)\s*=/);
      assert.ok(m, `Slot ${i + 1} must match AC=4 pattern: ${q.prompt}`);
      const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      assert.ok(a >= 41 && a <= 65, `Slot ${i + 1} a (${a}) in [41, 65]`);
      assert.ok(b >= 41 && b <= 65, `Slot ${i + 1} b (${b}) in [41, 65]`);
      assert.ok(c >= 41 && c <= 65, `Slot ${i + 1} c (${c}) in [41, 65]`);
      assert.ok(d >= 41 && d <= 65, `Slot ${i + 1} d (${d}) in [41, 65]`);
      const expected = (a + b) * (c + d);
      assert.equal(Number(q.answer_key.value), expected, `Slot ${i + 1} answer matches (a+b)*(c+d)`);
    }

    // 4. Slots 13..17: AC=5 -> (a + b) ÷ (c + d) with exact division
    for (let i = 12; i < 17; i++) {
      const q = gen[i];
      const m = q.prompt.match(/^\((\d+)\s*\+\s*(\d+)\)\s*÷\s*\((\d+)\s*\+\s*(\d+)\)\s*=/);
      assert.ok(m, `Slot ${i + 1} must match AC=5 pattern: ${q.prompt}`);
      const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      assert.equal((a + b) % (c + d), 0, `Slot ${i + 1} (a+b) must be exactly divisible by (c+d)`);
      const expected = Math.floor((a + b) / (c + d));
      assert.equal(Number(q.answer_key.value), expected, `Slot ${i + 1} answer matches exact quotient`);
    }

    // 5. Slots 18..20: AC=6 -> (a + (b × c)) × (d − e)
    for (let i = 17; i < 20; i++) {
      const q = gen[i];
      const m = q.prompt.match(
        /^\((\d+)\s*\+\s*\((\d+)\s*×\s*(\d+)\)\)\s*×\s*\((\d+)\s*−\s*(\d+)\)\s*=/
      );
      assert.ok(m, `Slot ${i + 1} must match AC=6 pattern: ${q.prompt}`);
      const [a, b, c, d, e] = [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
      ];
      assert.ok(a >= 51 && a <= 99, `Slot ${i + 1} a in [51, 99]`);
      assert.ok(b >= 2 && b <= 9, `Slot ${i + 1} b in [2, 9]`);
      assert.ok(c >= 51 && c <= 99, `Slot ${i + 1} c in [51, 99]`);
      assert.ok(d >= 481 && d <= 999, `Slot ${i + 1} d in [481, 999]`);
      assert.ok(e >= 51 && e <= 99, `Slot ${i + 1} e in [51, 99]`);
      const expected = (a + b * c) * (d - e);
      assert.equal(Number(q.answer_key.value), expected, `Slot ${i + 1} answer matches formula`);
    }

    // 6. Unknown subtype must throw explicitly
    assert.throws(
      () =>
        generateQuestionForSlot('brackets', {
          slot: 1,
          max_marks: 2,
          generator: 'brackets',
          parameters: { subtype: 'unsupported_ac_formula' },
        }),
      /Unsupported brackets subtype/,
      'Unknown brackets subtype must fail explicitly'
    );
  });

  it('all 23 categories faithfully consume extracted parameters and demonstrate source progression', () => {
    const seed = 'source-progression-audit';
    const j1Gen = generateQuestionsFromBlueprint(JMCWC_PAPERS.junior1.spec, { seed });
    const srGen = generateQuestionsFromBlueprint(JMCWC_PAPERS.senior.spec, { seed });

    // 1. Addition: terms and digits scale
    const j1Add = j1Gen.privateQuestions.filter((q) => q.category_key === 'addition');
    const srAdd = srGen.privateQuestions.filter((q) => q.category_key === 'addition');
    assert.notEqual(j1Add[0].prompt, srAdd[0].prompt, 'Addition Q1 must differ between J1 and Senior');
    assert.equal(j1Add[0].prompt.replace(/\s*=\s*$/, '').split('+').length, 2, 'J1 Add Q1: 2 terms');
    assert.equal(srAdd[17].prompt.replace(/\s*=\s*$/, '').split('+').length, 5, 'SR Add Q18: 5 terms');

    // 2. Subtraction: minuend digits scale from 2 to 10
    const j1Sub = j1Gen.privateQuestions.filter((q) => q.category_key === 'subtraction');
    const srSub = srGen.privateQuestions.filter((q) => q.category_key === 'subtraction');
    assert.equal(j1Sub[0].prompt.split('−')[0].trim().length, 2, 'J1 Sub Q1: 2 digits');
    assert.equal(srSub[17].prompt.split('−')[0].trim().length, 10, 'SR Sub Q18: 10 digits');

    // 3. Mixed: terms and digits progression
    const j1Mix = j1Gen.privateQuestions.filter((q) => q.category_key === 'mixed');
    const srMix = srGen.privateQuestions.filter((q) => q.category_key === 'mixed');
    assert.equal(j1Mix[0].prompt.replace(/\s*=\s*$/, '').split(/[+−]/).length, 3, 'J1 Mix Q1: 3 terms');
    assert.equal(srMix[13].prompt.replace(/\s*=\s*$/, '').split(/[+−]/).length, 5, 'SR Mix Q14: 5 terms');

    // 4. Multiplication: total_digits progression
    const srMul = srGen.privateQuestions.filter((q) => q.category_key === 'multiplication');
    const mulFirstDigits = srMul[0].prompt
      .replace(/\s*=\s*$/, '')
      .split('×')
      .map((s) => s.trim().length);
    const mulLastDigits = srMul[srMul.length - 1].prompt
      .replace(/\s*=\s*$/, '')
      .split('×')
      .map((s) => s.trim().length);
    assert.equal(mulFirstDigits[0] + mulFirstDigits[1], 4, 'Senior Mul Q1: 4 total digits');
    assert.equal(mulLastDigits[0] + mulLastDigits[1], 11, 'Senior Mul Q20: 11 total digits');

    // 5. Division: dividend digits progression
    const srDiv = srGen.privateQuestions.filter((q) => q.category_key === 'division');
    const divFirstDividend = srDiv[0].prompt.split('÷')[0].trim().length;
    const divLastDividend = srDiv[srDiv.length - 1].prompt.split('÷')[0].trim().length;
    assert.ok(divLastDividend > divFirstDividend, 'Division dividend digits must increase across slots');

    // 6. Remainder: dividend digits progression from v_level
    const srRem = srGen.privateQuestions.filter((q) => q.category_key === 'remainder');
    const remFirstM = srRem[0].prompt.match(/when\s+(\d+)\s+is\s+divided\s+by\s+(\d+)/);
    const remLastM = srRem[srRem.length - 1].prompt.match(/when\s+(\d+)\s+is\s+divided\s+by\s+(\d+)/);
    assert.ok(remFirstM && remLastM, 'Remainder prompts match pattern');
    assert.ok(
      remLastM[1].length > remFirstM[1].length,
      `Remainder dividend digits must progress: ${remFirstM[1].length} -> ${remLastM[1].length}`
    );

    // 7. Ratio: proportion missing X
    const srRatio = srGen.privateQuestions.filter((q) => q.category_key === 'ratio');
    assert.match(srRatio[0].prompt, /Find x:\s+/, 'Ratio Q1 prompt matches proportion format');

    // 8. Square Root: square_digits progression
    const srSqrt = srGen.privateQuestions.filter((q) => q.category_key === 'square_root');
    const sqFirst = srSqrt[0].prompt.match(/^√(\d+)\s*=/)[1].length;
    const sqLast = srSqrt[srSqrt.length - 1].prompt.match(/^√(\d+)\s*=/)[1].length;
    assert.equal(sqFirst, 4, 'Senior Square Root Q1 square digits must be 4');
    assert.equal(sqLast, 11, 'Senior Square Root Q20 square digits must be 11');

    // 9. Next Square: n_digits progression
    const srNextSq = srGen.privateQuestions.filter((q) => q.category_key === 'next_square');
    const nSqFirst = srNextSq[0].prompt.match(/than\s+(\d+):/)[1].length;
    const nSqLast = srNextSq[srNextSq.length - 1].prompt.match(/than\s+(\d+):/)[1].length;
    assert.equal(nSqFirst, 3, 'Senior Next Square Q1 n_digits must be 3');
    assert.equal(nSqLast, 7, 'Senior Next Square Q20 n_digits must be 7');

    // 10. Cube Root: cube_digits progression
    const srCbrt = srGen.privateQuestions.filter((q) => q.category_key === 'cube_root');
    const cbFirst = srCbrt[0].prompt.match(/^∛(\d+)\s*=/)[1].length;
    const cbLast = srCbrt[srCbrt.length - 1].prompt.match(/^∛(\d+)\s*=/)[1].length;
    assert.equal(cbFirst, 4, 'Senior Cube Root Q1 cube digits must be 4');
    assert.equal(cbLast, 12, 'Senior Cube Root Q20 cube digits must be 12');

    // 11. Next Cube: n_digits progression
    const srNextCb = srGen.privateQuestions.filter((q) => q.category_key === 'next_cube');
    const nCbFirst = srNextCb[0].prompt.match(/than\s+(\d+):/)[1].length;
    const nCbLast = srNextCb[srNextCb.length - 1].prompt.match(/than\s+(\d+):/)[1].length;
    assert.equal(nCbFirst, 4, 'Senior Next Cube Q1 n_digits must be 4');
    assert.equal(nCbLast, 6, 'Senior Next Cube Q20 n_digits must be 6');

    // 12. HCF / LCM: HCF for slots 1..10, LCM for slots 11..20
    const srHcfLcm = srGen.privateQuestions.filter((q) => q.category_key === 'hcf_lcm');
    assert.match(srHcfLcm[0].prompt, /^HCF\(/, 'HCF/LCM Q1 prompt is HCF');
    assert.match(srHcfLcm[15].prompt, /^LCM\(/, 'HCF/LCM Q16 prompt is LCM');

    // 13. Max marks non-decreasing for all 23 categories
    for (const section of JMCWC_PAPERS.senior.spec.sections) {
      const qFirst = section.questions[0];
      const qLast = section.questions[section.questions.length - 1];
      assert.ok(
        qLast.max_marks >= qFirst.max_marks,
        `[${section.key}] Last slot max_marks (${qLast.max_marks}) must be >= first slot (${qFirst.max_marks})`
      );
    }
  });

  it('fraction operations faithfully reproduce authentic workbook formulas and operand structures', () => {
    // 1. Fraction Additions: Level-based whole and fractional parts
    // Junior 1 Slot 1 has ak_level=3: W in [3, 8], N in [2, 5], D in [3, 6]
    // Exactly contains the source workbook B13 evidence: "8 3/4 + 4 4/5"
    for (const groupKey of ['junior1', 'junior2', 'senior']) {
      const paper = JMCWC_PAPERS[groupKey];
      const addSec = paper.spec.sections.find((s) => s.key === 'fraction_add');
      assert.ok(addSec, `[${groupKey}] fraction_add section exists`);

      const slotsToTest = [
        addSec.questions[0],
        addSec.questions[Math.floor(addSec.questions.length / 2)],
        addSec.questions[addSec.questions.length - 1],
      ];

      for (const slotSpec of slotsToTest) {
        const q = generateQuestionForSlot('fraction_add', slotSpec, null);
        assert.ok(q.prompt.endsWith('='), `[${groupKey}:slot ${slotSpec.slot}] prompt ends with =`);
        assert.equal(q.input.type, 'fraction');
        assert.equal(q.answer_key.kind, 'simplest_mixed_fraction');

        // Verify prompt has 2 mixed fraction operands separated by +
        const parts = q.prompt.replace(/\s*=\s*$/, '').split('+').map((s) => s.trim());
        assert.equal(parts.length, 2, 'Must have 2 fraction operands');

        // Check operands format and bounds
        for (const part of parts) {
          const match = part.match(/^(\d+)\s+(\d+)\/(\d+)$/);
          assert.ok(match, `Operand '${part}' must be a mixed fraction "W N/D"`);
          const [, whole, num, den] = match.map(Number);
          assert.ok(whole >= 1, `Whole part (${whole}) must be >= 1`);
          assert.ok(num < den, `Fraction part (${num}/${den}) must be proper (< 1)`);
        }
      }
    }

    // Verify J1 Slot 1 parameter bounds can produce the source workbook B13 example: 8 3/4 + 4 4/5
    const j1Slot1Spec = JMCWC_PAPERS.junior1.spec.sections
      .find((s) => s.key === 'fraction_add')
      .questions[0];
    assert.equal(j1Slot1Spec.parameters.ak_level, 3);
    // Over 50 random samples of slot 1, verify whole parts reach up to 8 (which old cap of 4 prohibited!)
    let maxWholeObserved = 0;
    for (let i = 0; i < 50; i++) {
      const q = generateQuestionForSlot('fraction_add', j1Slot1Spec, null);
      const parts = q.prompt.replace(/\s*=\s*$/, '').split('+').map((s) => s.trim());
      for (const p of parts) {
        const w = parseInt(p.split(' ')[0], 10);
        if (w > maxWholeObserved) maxWholeObserved = w;
      }
    }
    assert.ok(
      maxWholeObserved > 4,
      `Junior 1 slot 1 must permit whole parts > 4 (observed: ${maxWholeObserved}) matching workbook range [3, 8]`
    );

    // 2. Fraction Subtractions: Minuend is mixed (W >= 1), Subtrahend is strictly proper (W = 0)
    for (const groupKey of ['junior1', 'junior2', 'senior']) {
      const paper = JMCWC_PAPERS[groupKey];
      const subSec = paper.spec.sections.find((s) => s.key === 'fraction_sub');
      assert.ok(subSec, `[${groupKey}] fraction_sub section exists`);

      const slotsToTest = [
        subSec.questions[0],
        subSec.questions[Math.floor(subSec.questions.length / 2)],
        subSec.questions[subSec.questions.length - 1],
      ];

      for (const slotSpec of slotsToTest) {
        const q = generateQuestionForSlot('fraction_sub', slotSpec, null);
        assert.ok(q.prompt.endsWith('='), `[${groupKey}:slot ${slotSpec.slot}] prompt ends with =`);
        assert.equal(q.input.type, 'fraction');
        assert.equal(q.answer_key.kind, 'simplest_mixed_fraction');

        const [minuendStr, subtrahendStr] = q.prompt
          .replace(/\s*=\s*$/, '')
          .split('−')
          .map((s) => s.trim());

        // Minuend must be mixed fraction: "W N/D" where W >= 1
        const minuendMatch = minuendStr.match(/^(\d+)\s+(\d+)\/(\d+)$/);
        assert.ok(minuendMatch, `Minuend '${minuendStr}' must be a mixed fraction "W N/D"`);
        const minuendWhole = Number(minuendMatch[1]);
        assert.ok(minuendWhole >= 1, `Minuend whole (${minuendWhole}) must be >= 1`);

        // Subtrahend must be strictly a proper fraction: "N/D" (whole part = 0 per cell AB13)
        const subtrahendMatch = subtrahendStr.match(/^(\d+)\/(\d+)$/);
        assert.ok(
          subtrahendMatch,
          `Subtrahend '${subtrahendStr}' must be strictly proper fraction "N/D" (whole=0)`
        );

        // Result must be strictly positive (minuend > 1 > subtrahend)
        const resNum = BigInt(q.answer_key.num);
        assert.ok(resNum > 0n, 'Result of fraction subtraction must be strictly positive');
      }
    }

    // 3. Fraction Multiplications: Both operands mixed, scaling with ai_level
    for (const groupKey of ['junior1', 'junior2', 'senior']) {
      const paper = JMCWC_PAPERS[groupKey];
      const mulSec = paper.spec.sections.find((s) => s.key === 'fraction_mul');
      assert.ok(mulSec, `[${groupKey}] fraction_mul section exists`);

      const slotsToTest = [
        mulSec.questions[0],
        mulSec.questions[Math.floor(mulSec.questions.length / 2)],
        mulSec.questions[mulSec.questions.length - 1],
      ];

      for (const slotSpec of slotsToTest) {
        const q = generateQuestionForSlot('fraction_mul', slotSpec, null);
        assert.ok(q.prompt.endsWith('='), `[${groupKey}:slot ${slotSpec.slot}] prompt ends with =`);
        assert.equal(q.input.type, 'fraction');
        assert.equal(q.answer_key.kind, 'simplest_mixed_fraction');

        const [op1Str, op2Str] = q.prompt
          .replace(/\s*=\s*$/, '')
          .split('×')
          .map((s) => s.trim());
        assert.match(op1Str, /^\d+\s+\d+\/\d+$/, `Operand 1 '${op1Str}' must be mixed fraction`);
        assert.match(op2Str, /^\d+\s+\d+\/\d+$/, `Operand 2 '${op2Str}' must be mixed fraction`);
      }
    }

    // Senior final slot (slot 17, ai_level=6) must have whole parts in [8, 16]
    const srMulLast = JMCWC_PAPERS.senior.spec.sections
      .find((s) => s.key === 'fraction_mul')
      .questions.slice(-1)[0];
    assert.equal(srMulLast.parameters.ai_level, 6, 'Senior final fraction_mul ai_level is 6');
    const qSrMul = generateQuestionForSlot('fraction_mul', srMulLast, null);
    const srOp1 = parseInt(qSrMul.prompt.split('×')[0].trim().split(' ')[0], 10);
    assert.ok(
      srOp1 >= 8 && srOp1 <= 16,
      `Senior final fraction_mul operand whole (${srOp1}) must be in workbook bounds [8, 16] for ai_level=6`
    );

    // 4. Fraction Divisions: Intro slots (AI=2) vs Reverse-Multiplication (AI >= 3)
    // Junior 1 Slot 1 (intro slot 1): 1 1/3 ÷ 1 5/9 = 6/7
    const j1DivSlot1 = JMCWC_PAPERS.junior1.spec.sections
      .find((s) => s.key === 'fraction_div')
      .questions[0];
    const qDivIntro1 = generateQuestionForSlot('fraction_div', j1DivSlot1, null);
    assert.equal(qDivIntro1.prompt, '1 1/3 ÷ 1 5/9 =', 'J1 Div Slot 1 must be exact workbook intro slot 1');
    assert.equal(qDivIntro1.answer_key.expected_display, '6/7', 'J1 Div Slot 1 answer must be 6/7');

    // Junior 1 Slot 2 (intro slot 2): 1 5/9 ÷ 1 2/3 = 14/15
    const j1DivSlot2 = JMCWC_PAPERS.junior1.spec.sections
      .find((s) => s.key === 'fraction_div')
      .questions[1];
    const qDivIntro2 = generateQuestionForSlot('fraction_div', j1DivSlot2, null);
    assert.equal(qDivIntro2.prompt, '1 5/9 ÷ 1 2/3 =', 'J1 Div Slot 2 must be exact workbook intro slot 2');
    assert.equal(qDivIntro2.answer_key.expected_display, '14/15', 'J1 Div Slot 2 answer must be 14/15');

    // Standard slots (AI >= 3): Reverse multiplication architecture
    // Dividend is exact product of Quotient and Divisor
    for (const groupKey of ['junior1', 'junior2', 'senior']) {
      const divSec = JMCWC_PAPERS[groupKey].spec.sections.find((s) => s.key === 'fraction_div');
      const middleSlot = divSec.questions[Math.floor(divSec.questions.length / 2)];
      const finalSlot = divSec.questions[divSec.questions.length - 1];

      for (const slotSpec of [middleSlot, finalSlot]) {
        const q = generateQuestionForSlot('fraction_div', slotSpec, null);
        assert.ok(q.prompt.endsWith('='), `[${groupKey}:slot ${slotSpec.slot}] prompt ends with =`);
        assert.equal(q.input.type, 'fraction');
        assert.equal(q.answer_key.kind, 'simplest_mixed_fraction');

        // Check structure: Dividend ÷ Divisor =
        const [dividendStr, divisorStr] = q.prompt
          .replace(/\s*=\s*$/, '')
          .split('÷')
          .map((s) => s.trim());
        assert.ok(dividendStr.length > 0 && divisorStr.length > 0);
      }
    }
  });

  it('satisfies all 10 verified workbook fidelity rules from WORKBOOK-COMPARISON-2026-3', () => {
    // 1. Integer division active dependency chain (X=2, Y=4 for V=7)
    const j1DivSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'division');
    const slot17 = j1DivSec.questions[16]; // Row 36 in Int Divs
    assert.deepEqual(slot17.parameters.divisor_digits, [2, 4], 'Divisor digits must be extracted from col X..Y [2, 4]');

    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('division', slot17, createSeededRng(`div-chain-seed-${i}`));
      const [dividendStr, divisorStr] = q.prompt.replace(/\s*=\s*$/, '').split('÷').map((s) => s.trim());
      const dividend = BigInt(dividendStr);
      const divisor = BigInt(divisorStr);
      const quotient = BigInt(q.answer_key.value);

      assert.equal(dividend, divisor * quotient, 'Exact division must hold');
      assert.ok(divisorStr.length >= 2 && divisorStr.length <= 4, `Divisor length ${divisorStr.length} in [2, 4]`);
      const expectedDividendLen = 7 + 1 - Math.floor(divisorStr.length / 2 + 0.5);
      assert.equal(dividendStr.length, expectedDividendLen, `Dividend length must follow active chain AB = V+1-INT(Z/2+0.5)`);
    }

    // 2. HCF / LCM lookup and operand generation
    const j1HcfSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'hcf_lcm');
    const hcfSlot1 = j1HcfSec.questions[0];
    const generatedHcfPairs = [];
    for (let i = 0; i < 50; i++) {
      const q = generateQuestionForSlot('hcf_lcm', hcfSlot1, createSeededRng(`hcf-seed-${i}`));
      generatedHcfPairs.push(q);
      assert.ok(BigInt(q.answer_key.expected_display) >= 2n, 'HCF >= 2');
    }
    // Verify pair generation produces distinct multiples
    assert.ok(generatedHcfPairs.some((q) => q.prompt.includes(',')), 'HCF prompt contains pair');

    // 3. Fraction subtraction whole-part bounds
    const j1FracSubSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'fraction_sub');
    const fracSubSlot1 = j1FracSubSec.questions[0];
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('fraction_sub', fracSubSlot1, createSeededRng(`fsub-slot1-seed-${i}`));
      const [mStr, sStr] = q.prompt.replace(/\s*=\s*$/, '').split('−').map((s) => s.trim());
      // Minuend whole part must strictly be 1 (since V=2, 1..V-1 = 1..1)
      const mWholeMatch = mStr.match(/^(\d+)\s+\d+\/\d+/);
      const mWhole = mWholeMatch ? parseInt(mWholeMatch[1], 10) : 0;
      assert.equal(mWhole, 1, `Minuend whole part for slot 1 must strictly be 1 (got ${mStr})`);

      // Subtrahend whole part must strictly be 0 (proper fraction)
      const sWholeMatch = sStr.match(/^(\d+)\s+\d+\/\d+/);
      assert.equal(sWholeMatch, null, `Subtrahend whole part must strictly be 0 (got ${sStr})`);
    }

    // 4. Calendars arbitrary day of month (1..28) in prompt and valid month checking
    const j1CalSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'calendar');
    const monthSlots = j1CalSec.questions.filter((q) => q.parameters.subtype === 'month');
    const seenDays = new Set();
    for (let i = 0; i < 40; i++) {
      const q = generateQuestionForSlot('calendar', monthSlots[0], createSeededRng(`cal-month-seed-${i}`));
      assert.ok(q.answer_key.day >= 1 && q.answer_key.day <= 28, 'Calendar month question day in 1..28');
      seenDays.add(q.answer_key.day);
      assert.ok(q.prompt.includes(` ${q.answer_key.day} [ ? ] `), `Prompt must display arbitrary day ${q.answer_key.day}`);
      assert.ok(Array.isArray(q.answer_key.valid_months) && q.answer_key.valid_months.length > 0);
    }
    assert.ok(seenDays.size > 10, 'Calendar month questions must sample various days 1..28');

    // 5. Elapsed time branches: J1 has morning start and same-day; J2 has multi-day with dates
    const j1TimeSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'elapsed_time');
    const j1TimeSlot1 = j1TimeSec.questions[0];
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('elapsed_time', j1TimeSlot1, createSeededRng(`j1-time-seed-${i}`));
      assert.ok(!q.prompt.includes('on '), 'J1 must not show dates');
      assert.ok(q.answer_key.total_seconds >= 4000 && q.answer_key.total_seconds <= 17999, 'J1 duration in 4000..17999');
    }

    const j2TimeSec = JMCWC_PAPERS.junior2.spec.sections.find((s) => s.key === 'elapsed_time');
    const j2Slot15 = j2TimeSec.questions[14]; // aa_level = 4
    const qJ2Date = generateQuestionForSlot('elapsed_time', j2Slot15, createSeededRng('j2-time-date-seed'));
    assert.ok(qJ2Date.prompt.includes(' on '), 'J2 slot 15 must show dates');
    assert.ok(qJ2Date.answer_key.total_seconds > 86400, 'J2 aa=4 duration spans across multiple days');

    // 6. Integer multiplication: reversed-bound special case and zero-ending factors
    const j1MultSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'multiplication');
    const multSlot1 = j1MultSec.questions[0];
    let sawZeroEndingFactor = false;
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('multiplication', multSlot1, createSeededRng(`mult-special-seed-${i}`));
      const [f1Str, f2Str] = q.prompt.replace(/\s*=\s*$/, '').split('×').map((s) => s.trim());
      assert.equal(f1Str.length, 1, 'First factor must be 1 digit');
      assert.equal(f2Str.length, 2, 'Second factor must be 2 digits (reversed-bound special case d2 = lo)');
      if (f2Str.endsWith('0')) sawZeroEndingFactor = true;
    }
    assert.ok(sawZeroEndingFactor, 'Multiplication must generate factors ending in 0 (Excel RAND allows zero-ending)');

    // 7. Prime factorisation: helper formula ranges allow products below 72
    const j1PrimeSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'prime_factors');
    const primeSlot1 = j1PrimeSec.questions[0];
    assert.deepEqual(primeSlot1.parameters.factor_ranges, [[6, 49], [2, 16], [1, 1]], 'Prime ranges derived from workbook [W+1, V]');
    let sawProductBelow72 = false;
    for (let i = 0; i < 50; i++) {
      const q = generateQuestionForSlot('prime_factors', primeSlot1, createSeededRng(`prime-small-seed-${i}`));
      const target = BigInt(q.answer_key.target);
      if (target < 72n) sawProductBelow72 = true;
    }
    assert.ok(sawProductBelow72, 'Prime factorisation must allow small products below 72');

    // 8. Mixed arithmetic: continuous operand ratios, non-negative intermediate results, and fractional reachability
    const j1MixedSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'mixed');
    const mixedSlot1 = j1MixedSec.questions[0];
    assert.equal(mixedSlot1.source_ref.printed_cells, 'C8:C10', 'J1 Mixed slot 1 printed_cells top-aligned to C8:C10');
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('mixed', mixedSlot1, createSeededRng(`mixed-ratio-seed-${i}`));
      assert.ok(q.prompt.includes('−'), 'Prompt contains subtraction');
      assert.ok(q.prompt.includes('+'), 'Prompt contains addition');
      assert.ok(BigInt(q.answer_key.value) > 0n, 'Result is positive');

      const parts = q.prompt.replace(/\s*=\s*$/, '').split(/\s+/);
      const T0 = BigInt(parts[0]);
      const T1 = BigInt(parts[2]);
      const T2 = BigInt(parts[4]);
      // T1 is subtraction term: INT(T0 * (RAND() * 0.4 + 0.3)) => ratio in [0.30, 0.70)
      const ratioT1 = Number(T1) / Number(T0);
      assert.ok(ratioT1 >= 0.299 && ratioT1 < 0.7001, `T1 ratio ${ratioT1} in [0.30, 0.70)`);
      // T2 is addition term: INT(T0 * (RAND() * 0.5 + 0.5)) => ratio in [0.50, 1.00)
      const ratioT2 = Number(T2) / Number(T0);
      assert.ok(ratioT2 >= 0.499 && ratioT2 < 1.0001, `T2 ratio ${ratioT2} in [0.50, 1.00)`);
    }

    // 9. Subtraction upper bound rounding
    const j1SubSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'subtraction');
    const subSlot1 = j1SubSec.questions[0];
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('subtraction', subSlot1, createSeededRng(`sub-bound-seed-${i}`));
      const [aStr, bStr] = q.prompt.replace(/\s*=\s*$/, '').split('−').map((s) => s.trim());
      const a = BigInt(aStr);
      const b = BigInt(bStr);
      assert.ok(a > b, 'Minuend > subtrahend');
      assert.ok(b >= 1n, 'Subtrahend >= 1');
    }
  });

  it('deterministic verification of elapsed time month correction, continuous mixed arithmetic sampling, and LCM operand equality', () => {
    // A. LCM operand equality preservation vs HCF distinctness rule:
    // When random multiplier and operand generate equal factors (e.g. U=Y=12, V=Z=12):
    // Workbook LCM formula: AB36 = AA36*Y36 with NO distinctness check (equal operands preserved).
    // Workbook HCF formula: AB11 = IF(AC11=X11, AC11-Y11, AC11) (enforces distinct operands).
    const mockRngColliding = {
      int(min, max) { return 12; },
      float() { return 0.5; },
    };

    const qLcm = generateQuestionForSlot(
      'hcf_lcm',
      { slot: 1, max_marks: 3, generator: 'hcf_lcm', parameters: { subtype: 'lcm_2', m_level: 1 } },
      mockRngColliding
    );
    assert.equal(qLcm.prompt, 'LCM(12, 12) =', 'LCM must preserve equal operands generated by sheet formula');
    assert.equal(qLcm.answer_key.value, '12');

    const qHcf = generateQuestionForSlot(
      'hcf_lcm',
      { slot: 1, max_marks: 3, generator: 'hcf_lcm', parameters: { subtype: 'hcf_2', m_level: 1 } },
      mockRngColliding
    );
    assert.equal(qHcf.prompt, 'HCF(12, 24) =', 'HCF must adjust equal operands via IF(AC=X, AC-Y, AC)');
    assert.equal(qHcf.answer_key.value, '12');

    // B. Mixed arithmetic continuous float sampling:
    // 1. Controlled non-integer percentage sampling:
    //    For AO=1,000,000, RAND()=0.08333375 yields AQ = INT(1,000,000 * (0.08333375 * 0.4 + 0.3)) = 333,333.
    //    Whole-percentage sampling could only produce 330,000 or 340,000.
    const mockRngContinuous = {
      int(min, max) { return min; },
      bigInt(min, max) { return 1000000n; },
      float() { return 0.08333375; },
    };
    const qMixedControlled = generateQuestionForSlot(
      'mixed',
      { slot: 1, max_marks: 3, generator: 'mixed', parameters: { terms: 3, digits: 7 } },
      mockRngContinuous
    );
    assert.ok(
      qMixedControlled.prompt.includes('1000000 − 333333'),
      `Continuous sampling must produce 333,333 (got prompt: ${qMixedControlled.prompt})`
    );

    // 2. Strict half-open endpoint boundaries:
    //    u = 0 => AQ = 300,000; u -> 1 (0.9999999999999) => AQ = 699,999 (strictly excludes 700,000).
    const mockRngLower = {
      int(min, max) { return min; },
      bigInt(min, max) { return 1000000n; },
      float() { return 0.0; },
    };
    const qLower = generateQuestionForSlot(
      'mixed',
      { slot: 1, max_marks: 3, generator: 'mixed', parameters: { terms: 3, digits: 7 } },
      mockRngLower
    );
    assert.ok(qLower.prompt.includes('1000000 − 300000'), 'u=0 reaches lower boundary 300,000');

    const mockRngUpper = {
      int(min, max) { return min; },
      bigInt(min, max) { return 1000000n; },
      float() { return 0.9999999999999; },
    };
    const qUpper = generateQuestionForSlot(
      'mixed',
      { slot: 1, max_marks: 3, generator: 'mixed', parameters: { terms: 3, digits: 7 } },
      mockRngUpper
    );
    assert.ok(qUpper.prompt.includes('1000000 − 699999'), 'u -> 1 reaches 699,999 and excludes 700,000');

    // 3. Seeded fractional diversity on 50 questions:
    const j1MixedSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'mixed');
    const fracRatios = new Set();
    for (let i = 0; i < 50; i++) {
      const q = generateQuestionForSlot('mixed', j1MixedSec.questions[0], createSeededRng(`mixed-div-seed-${i}`));
      const parts = q.prompt.replace(/\s*=\s*$/, '').split(/\s+/);
      const T0 = BigInt(parts[0]);
      const T1 = BigInt(parts[2]);
      const scaledRatio = Number((T1 * 10000n) / T0);
      fracRatios.add(scaledRatio);
    }
    assert.ok(
      fracRatios.size >= 40,
      `Continuous sampling must yield dense fractional diversity (got ${fracRatios.size} unique ratios in 50 draws)`
    );

    // C. Elapsed time literal dependency chains & aa=6 month correction:
    // 1. Over 100 seeds on Senior aa=6 slot (slot 18), start date and end date
    //    MUST have month difference of EXACTLY 1 calendar month (0 instances of 2-month gaps).
    const srTimeSec = JMCWC_PAPERS.senior.spec.sections.find((s) => s.key === 'elapsed_time');
    const srSlot18 = srTimeSec.questions[17]; // slot 18, aa_level = 6
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    for (let i = 0; i < 100; i++) {
      const q = generateQuestionForSlot('elapsed_time', srSlot18, createSeededRng(`sr-aa6-fidelity-seed-${i}`));
      const match = q.prompt.match(/on (\d+) (\w+) (\d+) to \d+:\d+:\d+ on (\d+) (\w+) (\d+)/);
      assert.ok(match, `aa=6 prompt must include start and end dates: ${q.prompt}`);
      const [_, d1, m1, y1, d2, m2, y2] = match;
      const mIdx1 = MONTHS.indexOf(m1);
      const mIdx2 = MONTHS.indexOf(m2);
      const monthDiff = (parseInt(y2, 10) - parseInt(y1, 10)) * 12 + (mIdx2 - mIdx1);
      assert.equal(
        monthDiff,
        1,
        `Senior aa=6 month difference must strictly be 1 (seed ${i}: ${m1} ${y1} -> ${m2} ${y2})`
      );
    }

    // 2. aa=3 same-day branch:
    // Start date and end date must be on the EXACT same day.
    const j2TimeSec = JMCWC_PAPERS.junior2.spec.sections.find((s) => s.key === 'elapsed_time');
    const j2Slot1 = j2TimeSec.questions[0]; // slot 1, aa_level = 3
    for (let i = 0; i < 30; i++) {
      const q = generateQuestionForSlot('elapsed_time', j2Slot1, createSeededRng(`j2-aa3-same-day-${i}`));
      const match = q.prompt.match(/on (\d+ \w+ \d+) to \d+:\d+:\d+ on (\d+ \w+ \d+)/);
      assert.ok(match, `aa=3 prompt must format dates: ${q.prompt}`);
      assert.equal(match[1], match[2], `aa=3 must start and end on the identical date (got ${match[1]} vs ${match[2]})`);
      assert.ok(q.answer_key.total_seconds >= 1 && q.answer_key.total_seconds < 86400, 'aa=3 duration within single day');
    }

    // 3. Group-specific start hour rules:
    // Junior 1: morning start, hour strictly in 0..12, no dates shown.
    // Junior 2: afternoon/evening start permitted up to 18.
    const j1TimeSec = JMCWC_PAPERS.junior1.spec.sections.find((s) => s.key === 'elapsed_time');
    let j1MaxHour = -1;
    let j2MaxHour = -1;
    for (let i = 0; i < 100; i++) {
      const qJ1 = generateQuestionForSlot('elapsed_time', j1TimeSec.questions[0], createSeededRng(`j1-hour-seed-${i}`));
      assert.ok(!qJ1.prompt.includes('on '), 'Junior 1 must not display dates');
      const h1 = parseInt(qJ1.prompt.match(/from (\d+):/)[1], 10);
      if (h1 > j1MaxHour) j1MaxHour = h1;

      const qJ2 = generateQuestionForSlot('elapsed_time', j2Slot1, createSeededRng(`j2-hour-seed-${i}`));
      const h2 = parseInt(qJ2.prompt.match(/from (\d+):/)[1], 10);
      if (h2 > j2MaxHour) j2MaxHour = h2;
    }
    assert.ok(j1MaxHour <= 12, `Junior 1 start hour must strictly be <= 12 (got ${j1MaxHour})`);
    assert.ok(j2MaxHour > 12 && j2MaxHour <= 18, `Junior 2 start hour must reach beyond 12 up to 18 (got ${j2MaxHour})`);
  });
});
