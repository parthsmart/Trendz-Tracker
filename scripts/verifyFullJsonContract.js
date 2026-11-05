import assert from 'node:assert/strict';
import { JMCWC_PAPERS, validatePaperBlueprint } from '../api/_jmcwcBlueprints.js';
import { generateQuestionForSlot } from '../api/_jmcwcGenerate.js';
import { JMCWC_CATEGORY_KEYS, createSeededRng } from '../api/_jmcwcMath.js';

let totalSlotsValidated = 0;
let totalQuestionsValidated = 0;

for (const groupKey of ['junior1', 'junior2', 'senior']) {
  const paper = JMCWC_PAPERS[groupKey];
  const validation = validatePaperBlueprint(paper);
  assert.equal(validation.valid, true, `Blueprint for ${groupKey} must be structurally valid`);
  assert.equal(validation.canPublish, true, `Blueprint for ${groupKey} must be publishable`);

  let groupSlotCount = 0;
  for (const section of paper.spec.sections) {
    assert.ok(JMCWC_CATEGORY_KEYS.includes(section.key), `Invalid section key: ${section.key}`);
    assert.ok(Array.isArray(section.questions), `Section questions must be array`);

    for (const slotObj of section.questions) {
      groupSlotCount++;
      totalSlotsValidated++;

      // Check every published blueprint slot contains: slot, max_marks, generator, parameters
      assert.ok('slot' in slotObj, `Missing slot property in ${groupKey} ${section.key}`);
      assert.ok(Number.isInteger(slotObj.slot) && slotObj.slot >= 1, `Invalid slot integer: ${slotObj.slot}`);
      assert.ok('max_marks' in slotObj, `Missing max_marks property in ${groupKey} ${section.key} slot ${slotObj.slot}`);
      assert.ok(typeof slotObj.max_marks === 'number' && slotObj.max_marks > 0, `Invalid max_marks: ${slotObj.max_marks}`);
      assert.ok('generator' in slotObj, `Missing generator property in ${groupKey} ${section.key} slot ${slotObj.slot}`);
      assert.ok(typeof slotObj.generator === 'string' && slotObj.generator.trim().length > 0, `Invalid generator string`);
      assert.ok('parameters' in slotObj, `Missing parameters in ${groupKey} ${section.key} slot ${slotObj.slot}`);
      assert.ok(typeof slotObj.parameters === 'object' && slotObj.parameters !== null, `Parameters must be object`);

      // Generate question and check full private question contract: id, category_key, slot, max_marks, prompt, input, answer_key
      const rng = createSeededRng(`val-${groupKey}-${section.key}-${slotObj.slot}`);
      const q = generateQuestionForSlot(section.key, slotObj, rng);
      totalQuestionsValidated++;

      assert.ok('id' in q, `Question missing id in ${groupKey} ${section.key} slot ${slotObj.slot}`);
      assert.ok(typeof q.id === 'string' && q.id.length > 0, `Question id must be non-empty string`);
      assert.ok('category_key' in q, `Question missing category_key in ${q.id}`);
      assert.equal(q.category_key, section.key, `Question category_key mismatch`);
      assert.ok('slot' in q, `Question missing slot in ${q.id}`);
      assert.equal(q.slot, slotObj.slot, `Question slot mismatch`);
      assert.ok('max_marks' in q, `Question missing max_marks in ${q.id}`);
      assert.ok(typeof q.max_marks === 'number' && q.max_marks > 0, `Question max_marks must be positive number`);
      assert.equal('scoring_mode' in slotObj, false, `Slot ${slotObj.slot} must not declare slot-level scoring_mode`);
      if (slotObj.parameters.scoring_mode === 'dynamic') {
        const [minM, maxM] = slotObj.parameters.mark_range;
        assert.ok(
          q.max_marks >= minM && q.max_marks <= maxM,
          `Dynamic question ${q.id} max_marks ${q.max_marks} outside allowed mark_range [${minM}, ${maxM}]`
        );
      } else {
        assert.equal(q.max_marks, slotObj.max_marks, `Fixed question ${q.id} max_marks mismatch`);
      }
      assert.ok('prompt' in q, `Question missing prompt in ${q.id}`);
      assert.ok(typeof q.prompt === 'string' && q.prompt.length > 0, `Question prompt must be non-empty string`);
      assert.ok('input' in q, `Question missing input in ${q.id}`);
      assert.ok(typeof q.input === 'object' && q.input !== null && 'type' in q.input, `Question input must have type`);
      assert.ok('answer_key' in q, `Question missing answer_key in ${q.id}`);
      assert.ok(typeof q.answer_key === 'object' && q.answer_key !== null && 'kind' in q.answer_key, `Question answer_key must have kind`);
    }
  }

  assert.equal(groupSlotCount, paper.spec.total_questions, `Slot count mismatch for ${groupKey}`);
  console.log(`Validated all ${groupSlotCount} slots and generated questions for ${groupKey}`);
}

console.log(`\nSUCCESS: 100% of all ${totalSlotsValidated} slots and ${totalQuestionsValidated} generated questions meet the full database JSON contract!`);
