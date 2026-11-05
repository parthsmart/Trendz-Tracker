import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import { generateQuestionsFromBlueprint } from '../api/_jmcwcGenerate.js';

const seed = 'source-fidelity-check';
const results = {};

for (const group of ['junior1', 'junior2', 'senior']) {
  const paper = JMCWC_PAPERS[group];
  const { privateQuestions } = generateQuestionsFromBlueprint(paper.spec, seed);
  results[group] = {};
  for (const q of privateQuestions) {
    if (!results[group][q.category_key]) results[group][q.category_key] = [];
    results[group][q.category_key].push(q);
  }
}

const catKeys = Object.keys(results.junior1);
console.log('Comparing categories across junior1, junior2, senior with seed "' + seed + '":\n');

for (const k of catKeys) {
  const j1Qs = results.junior1[k] || [];
  const j2Qs = results.junior2[k] || [];
  const srQs = results.senior[k] || [];

  const j1First = j1Qs[0]?.prompt;
  const j2First = j2Qs[0]?.prompt;
  const srFirst = srQs[0]?.prompt;

  const j1Last = j1Qs[j1Qs.length - 1]?.prompt;
  const j2Last = j2Qs[j2Qs.length - 1]?.prompt;
  const srLast = srQs[srQs.length - 1]?.prompt;

  const firstIdentical = (j1First === j2First && j2First === srFirst);
  const lastIdentical = (j1Last === j2Last && j2Last === srLast);

  console.log(`[${k}] (counts: j1=${j1Qs.length}, j2=${j2Qs.length}, sr=${srQs.length})`);
  if (firstIdentical || lastIdentical) {
    console.log(`  WARNING: IDENTICAL GENERATION ACROSS GROUPS!`);
    console.log(`    j1 First: ${j1First} | Last: ${j1Last}`);
    console.log(`    j2 First: ${j2First} | Last: ${j2Last}`);
    console.log(`    sr First: ${srFirst} | Last: ${srLast}`);
  } else {
    console.log(`    j1: [1] ${j1First}  -->  [${j1Qs.length}] ${j1Last}`);
    console.log(`    j2: [1] ${j2First}  -->  [${j2Qs.length}] ${j2Last}`);
    console.log(`    sr: [1] ${srFirst}  -->  [${srQs.length}] ${srLast}`);
  }
}
