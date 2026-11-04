import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import * as math from '../api/_jmcwcMath.js';
import fs from 'node:fs';

const genFile = fs.readFileSync('api/_jmcwcGenerate.js', 'utf8');

console.log('Auditing parameters and subtypes across all 23 categories...\n');

// Map generator function names
const genFnNames = {
  addition: 'genAddition',
  subtraction: 'genSubtraction',
  mixed: 'genMixed',
  multiplication: 'genMultiplication',
  division: 'genDivision',
  brackets: 'genBrackets',
  prime_factors: 'genPrimeFactors',
  hcf_lcm: 'genHcfLcm',
  fraction_add: 'genFractionAdd',
  fraction_sub: 'genFractionSub',
  fraction_mul: 'genFractionMul',
  fraction_div: 'genFractionDiv',
  approximation: 'genApproximation',
  remainder: 'genRemainder',
  ratio: 'genRatio',
  square_root: 'genSquareRoot',
  inexact_square_root: 'genInexactSquareRoot',
  next_square: 'genNextSquare',
  cube_root: 'genCubeRoot',
  next_cube: 'genNextCube',
  calendar: 'genCalendar',
  elapsed_time: 'genElapsedTime',
  sum_squares: 'genSumSquares',
};

for (const [catKey, fnName] of Object.entries(genFnNames)) {
  console.log(`==================== [${catKey}] -> ${fnName} ====================`);
  // Collect all unique parameter keys and subtypes from all papers (j1, j2, senior)
  const paramKeys = new Set();
  const subtypes = new Set();
  for (const group of ['junior1', 'junior2', 'senior']) {
    const sec = JMCWC_PAPERS[group].spec.sections.find(s => s.key === catKey);
    if (!sec) continue;
    for (const q of sec.questions) {
      if (q.parameters) {
        for (const k of Object.keys(q.parameters)) paramKeys.add(k);
        if (q.parameters.subtype) subtypes.add(q.parameters.subtype);
      }
    }
  }

  // Extract generator function body
  const fnRegex = new RegExp(`function ${fnName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)(?:\\nfunction |\\nexport |$)`);
  const match = genFile.match(fnRegex);
  const fnBody = match ? match[1] : '';

  console.log(`Extracted parameter keys:`, Array.from(paramKeys).join(', '));
  console.log(`Blueprint subtypes:`, Array.from(subtypes).join(', ') || '(none)');

  // Check which parameter keys are NOT referenced in fnBody
  const ignored = [];
  for (const k of paramKeys) {
    if (k === 'scoring_mode' || k === 'mark_rule' || k === 'mark_range') continue;
    if (!fnBody.includes(k) && !fnBody.includes(`params.${k}`) && !fnBody.includes(`params?.${k}`)) {
      ignored.push(k);
    }
  }
  if (ignored.length > 0) {
    console.log(`  POTENTIALLY IGNORED IN ${fnName}:`, ignored.join(', '));
  } else {
    console.log(`  All extracted parameters referenced.`);
  }

  // Check subtypes handling
  if (subtypes.size > 0) {
    const unhandledSubtypes = [];
    for (const st of subtypes) {
      if (!fnBody.includes(`'${st}'`) && !fnBody.includes(`"${st}"`)) {
        unhandledSubtypes.push(st);
      }
    }
    if (unhandledSubtypes.length > 0) {
      console.log(`  UNHANDLED SUBTYPES IN ${fnName}:`, unhandledSubtypes.join(', '));
    } else {
      console.log(`  All subtypes explicitly handled.`);
    }
  }
}
