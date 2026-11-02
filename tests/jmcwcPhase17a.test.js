import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addRational,
  computeExactSqrtScaled,
  createSeededRng,
  dayOfWeekGregorian,
  divRational,
  evaluateDecimalRounding,
  factorizeBigInt,
  findSumOfSquaresDecomposition,
  formatMixedFraction,
  formatPrimeFactorization,
  gcdBigInt,
  icbrtBigInt,
  isLeapYear,
  isPrimeBigInt,
  isqrtBigInt,
  JMCWC_CATEGORY_KEYS,
  lcmBigInt,
  makeRational,
  mulRational,
  nextCubeBigInt,
  nextSquareBigInt,
  parseSingleMonthInput,
  parseStudentFraction,
  parseWeekdayInput,
  roundBigIntToSigFigs,
  subRational,
} from '../api/_jmcwcMath.js';

import { grade, gradeAttempt } from '../api/_jmcwcGrade.js';
import {
  generateQuestionForSlot,
  generateQuestionsFromBlueprint,
  toPublicQuestion,
} from '../api/_jmcwcGenerate.js';
import {
  JMCWC_CATEGORY_REGISTRY,
  JMCWC_DRAFT_PAPERS,
  validatePaperBlueprint,
} from '../api/_jmcwcBlueprints.js';
import { parseXlsxBuffer } from '../scripts/inspectJmcwcWorkbooks.js';
import zlib from 'node:zlib';

function buildMinimalZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(rawBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localHeaders.push(local, compressed);
    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

test('Phase 17a — Zero-dependency .xlsx OpenXML cell & broken formula inspector', () => {
  const zipBuf = buildMinimalZip([
    {
      name: 'xl/workbook.xml',
      content: `<workbook><sheets><sheet name="Int Mults" sheetId="1" r:id="rId1"/><sheet name="Sheet1" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      content: `<sst><si><t>Question 1</t></si></sst>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<worksheet><sheetData><row r="7"><c r="A7" t="s"><v>0</v></c><c r="H7" t="e"><f>RANDBETWEEN(10,#REF!)</f><v>#REF!</v></c></row></sheetData></worksheet>`,
    },
  ]);

  const parsed = parseXlsxBuffer(zipBuf);
  assert.equal(parsed.sheets.length, 2);
  assert.equal(parsed.sheets[0].name, 'Int Mults');
  assert.equal(parsed.sheets[0].state, 'visible');
  assert.equal(parsed.sheets[1].state, 'hidden');
  assert.equal(parsed.sheets[0].cells.A7.value, 'Question 1');
  assert.equal(parsed.sheets[0].brokenCells.length, 1);
  assert.equal(parsed.sheets[0].brokenCells[0].ref, 'H7');
  assert.equal(parsed.sheets[0].brokenCells[0].formula, 'RANDBETWEEN(10,#REF!)');
});


test('Phase 17a — Exact integer arithmetic, roots, primes, and next-square/cube boundaries', () => {
  // Large BigInt GCD & LCM
  assert.equal(gcdBigInt(252n, 105n), 21n);
  assert.equal(lcmBigInt(252n, 105n), 1260n);

  // Primality & prime factorisation
  assert.equal(isPrimeBigInt(2n), true);
  assert.equal(isPrimeBigInt(97n), true);
  assert.equal(isPrimeBigInt(1n), false);
  assert.equal(isPrimeBigInt(221n), false); // 13 * 17
  assert.equal(isPrimeBigInt(104729n), true);

  const factors360 = factorizeBigInt(360n);
  assert.deepEqual(factors360, [
    { prime: 2n, exp: 3 },
    { prime: 3n, exp: 2 },
    { prime: 5n, exp: 1 },
  ]);
  assert.equal(formatPrimeFactorization(factors360), '2^3 × 3^2 × 5');
  assert.equal(formatPrimeFactorization(factors360, { expanded: true }), '2 × 2 × 2 × 3 × 3 × 5');

  // Exact & inexact integer square roots
  assert.deepEqual(isqrtBigInt(15129n), { root: 123n, exact: true, remainder: 0n });
  assert.deepEqual(isqrtBigInt(567n), { root: 23n, exact: false, remainder: 38n });

  // Exact & inexact integer cube roots
  assert.deepEqual(icbrtBigInt(103823n), { root: 47n, exact: true, remainder: 0n });
  assert.deepEqual(icbrtBigInt(-103823n), { root: -47n, exact: true, remainder: 0n });
  assert.deepEqual(icbrtBigInt(1000n), { root: 10n, exact: true, remainder: 0n });

  // Next square & next cube boundaries
  assert.deepEqual(nextSquareBigInt(99n), { root: 10n, square: 100n, diff: 1n });
  assert.deepEqual(nextSquareBigInt(100n, { strictGreater: true }), {
    root: 11n,
    square: 121n,
    diff: 21n,
  });
  assert.deepEqual(nextSquareBigInt(100n, { strictGreater: false }), {
    root: 10n,
    square: 100n,
    diff: 0n,
  });

  assert.deepEqual(nextCubeBigInt(124n), { root: 5n, cube: 125n, diff: 1n });
  assert.deepEqual(nextCubeBigInt(125n, { strictGreater: true }), {
    root: 6n,
    cube: 216n,
    diff: 91n,
  });
});

test('Phase 17a — Rational arithmetic and simplest mixed fraction formatting/grading', () => {
  const a = makeRational(7n, 6n); // 1 1/6
  const b = makeRational(5n, 4n); // 1 1/4
  const sum = addRational(a, b); // 29/12 = 2 5/12
  assert.deepEqual(sum, { num: 29n, den: 12n });
  assert.equal(formatMixedFraction(sum), '2 5/12');

  const diff = subRational(b, a); // 1/12
  assert.equal(formatMixedFraction(diff), '1/12');

  const prod = mulRational(makeRational(6n, 7n), makeRational(14n, 9n)); // 4/3 = 1 1/3
  assert.equal(formatMixedFraction(prod), '1 1/3');

  const quot = divRational(makeRational(9n, 4n), makeRational(3n, 8n)); // 6
  assert.equal(formatMixedFraction(quot), '6');

  // Parse student fraction checks
  assert.equal(parseStudentFraction('2 5/12').isSimplestMixed, true);
  assert.equal(parseStudentFraction('29/12').isSimplestMixed, false); // improper
  assert.equal(parseStudentFraction('2 10/24').isSimplestMixed, false); // unreduced fractional part
  assert.equal(parseStudentFraction('6/8').isSimplestMixed, false); // unreduced proper fraction

  const qFrac = {
    id: 'fraction_add_s1',
    category_key: 'fraction_add',
    slot: 1,
    max_marks: 2,
    prompt: '1 1/6 + 1 1/4 =',
    input: { type: 'fraction' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: '29',
      den: '12',
      expected_display: '2 5/12',
    },
  };

  assert.equal(grade(qFrac, '2 5/12').verdict, 'correct');
  assert.equal(grade(qFrac, '2 5/12').award, 2);
  // Improper fraction rejected when simplest mixed form is required
  assert.equal(grade(qFrac, '29/12').verdict, 'wrong');
  assert.equal(grade(qFrac, '29/12').award, 0);
  // Unreduced mixed fraction rejected
  assert.equal(grade(qFrac, '2 10/24').verdict, 'wrong');
});

test('Phase 17a — Decimal & significant-figure rounding: sqrt(567) to 1 d.p. and exact-answer safeguard', () => {
  // sqrt(567) = 23.811761799581316...
  const highScaled567 = computeExactSqrtScaled(567n, 1n, 12);
  const qSqrt567 = {
    id: 'inexact_square_root_s1',
    category_key: 'inexact_square_root',
    slot: 1,
    max_marks: 2,
    prompt: '√567 (to 1 decimal place) =',
    input: { type: 'decimal', decimals: 1 },
    answer_key: {
      kind: 'rounded_decimal',
      radicand: '567',
      scaled_floor: highScaled567.scaledFloor.toString(),
      scale: highScaled567.scale,
      exact: highScaled567.exact,
      sign: 1,
      target_decimals: 1,
      expected_display: '23.8',
    },
  };

  // 23.8 -> full marks (2)
  const r23_8 = grade(qSqrt567, '23.8');
  assert.equal(r23_8.verdict, 'correct');
  assert.equal(r23_8.award, 2);

  // 23.81 -> half marks (1): excess precision that validly rounds sqrt(567) to 2 d.p.
  const r23_81 = grade(qSqrt567, '23.81');
  assert.equal(r23_81.verdict, 'partial');
  assert.equal(r23_81.award, 1);

  // 23.9 -> half marks (1): ceiling / rounded wrong way at 1 d.p.
  const r23_9 = grade(qSqrt567, '23.9');
  assert.equal(r23_9.verdict, 'partial');
  assert.equal(r23_9.award, 1);

  // 23.7 -> zero marks (0)
  const r23_7 = grade(qSqrt567, '23.7');
  assert.equal(r23_7.verdict, 'wrong');
  assert.equal(r23_7.award, 0);

  // 23.79 -> zero marks (0): excess precision that does NOT match sqrt(567) at 2 d.p.
  const r23_79 = grade(qSqrt567, '23.79');
  assert.equal(r23_79.verdict, 'wrong');
  assert.equal(r23_79.award, 0);

  // Exact answer at target precision does NOT gain an alternative half-mark neighbour:
  // e.g. sqrt(6.25) = 2.5 exactly (radicand 25/4)
  const exactScaled = computeExactSqrtScaled(25n, 4n, 12);
  assert.equal(exactScaled.exact, true);
  assert.equal(evaluateDecimalRounding('2.5', exactScaled, 1).verdict, 'correct');
  assert.equal(evaluateDecimalRounding('2.6', exactScaled, 1).verdict, 'wrong');
  assert.equal(evaluateDecimalRounding('2.4', exactScaled, 1).verdict, 'wrong');

  // Significant-figure rounding check
  const sfRound = roundBigIntToSigFigs(148320n, 2);
  assert.equal(sfRound.nearest, 150000n);
  assert.equal(sfRound.other, 140000n);
});

test('Phase 17a — Prime factorisation grading: order-independent, repeated & exponent notation, composite rejection', () => {
  const qPrime = {
    id: 'prime_factors_s1',
    category_key: 'prime_factors',
    slot: 1,
    max_marks: 2,
    prompt: 'Prime factorisation of 360:',
    input: { type: 'text' },
    answer_key: {
      kind: 'prime_factorization',
      target: '360',
      expected_display: '2^3 × 3^2 × 5',
    },
  };

  // Expanded in any order with various separators
  assert.equal(grade(qPrime, '2 × 2 × 2 × 3 × 3 × 5').verdict, 'correct');
  assert.equal(grade(qPrime, '5 * 3 * 2 * 3 * 2 * 2').verdict, 'correct');
  assert.equal(grade(qPrime, '2 . 2 . 2 . 3 . 3 . 5').verdict, 'correct');
  assert.equal(grade(qPrime, '2, 2, 2, 3, 3, 5').verdict, 'correct');
  assert.equal(grade(qPrime, '2 2 2 3 3 5').verdict, 'correct');

  // Exponent and superscript notations in any order
  assert.equal(grade(qPrime, '2^3 * 3^2 * 5').verdict, 'correct');
  assert.equal(grade(qPrime, '5 × 3² × 2³').verdict, 'correct');
  assert.equal(grade(qPrime, '2**3 * 3**2 * 5').verdict, 'correct');

  // Reject composite factors even if product is 360
  assert.equal(grade(qPrime, '8 × 9 × 5').verdict, 'wrong');
  assert.equal(grade(qPrime, '4 × 2 × 3^2 × 5').verdict, 'wrong');
  // Reject 1 as a factor
  assert.equal(grade(qPrime, '1 × 2^3 × 3^2 × 5').verdict, 'wrong');
  // Reject wrong product
  assert.equal(grade(qPrime, '2^2 × 3^2 × 5').verdict, 'wrong');
});

test('Phase 17a — Sums of squares grading: 2-4 nonzero positive bases, squared notation, zero-padding & pre-squared rejection', () => {
  // 38 = 5^2 + 3^2 + 2^2 = 25 + 9 + 4 (also 6^2 + 1^2 + 1^2 = 36 + 1 + 1)
  const qSumSq = {
    id: 'sum_squares_s1',
    category_key: 'sum_squares',
    slot: 1,
    max_marks: 3,
    prompt: 'Express 38 as the sum of 2 to 4 nonzero positive integer squares:',
    input: { type: 'sum_squares', min_count: 2, max_count: 4 },
    answer_key: {
      kind: 'sum_of_squares',
      target: '38',
      min_count: 2,
      max_count: 4,
      example_bases: ['5', '3', '2'],
      expected_display: '5² + 3² + 2²',
    },
  };

  // Plain bases in any order
  assert.equal(grade(qSumSq, '5, 3, 2').verdict, 'correct');
  assert.equal(grade(qSumSq, '2 5 3').verdict, 'correct');
  // Alternative valid decomposition (with repeated bases: 6^2 + 1^2 + 1^2 = 38)
  assert.equal(grade(qSumSq, '6, 1, 1').verdict, 'correct');
  // Explicit squared-base notation
  assert.equal(grade(qSumSq, '5^2 + 3^2 + 2^2').verdict, 'correct');
  assert.equal(grade(qSumSq, '5² + 3² + 2²').verdict, 'correct');
  // Multi-box array with empty 4th box is accepted
  assert.equal(grade(qSumSq, ['5', '3', '2', '']).verdict, 'correct');

  // Reject 0 padding!
  assert.equal(grade(qSumSq, '5, 3, 2, 0').verdict, 'wrong');
  assert.equal(grade(qSumSq, '5^2 + 3^2 + 2^2 + 0^2').verdict, 'wrong');
  assert.equal(grade(qSumSq, ['5', '3', '2', '0']).verdict, 'wrong');

  // Reject pre-squared values entered as bases (25 + 9 + 4 = 38, but 25^2 + 9^2 + 4^2 != 38)
  assert.equal(grade(qSumSq, '25, 9, 4').verdict, 'wrong');

  // Reject negative bases
  assert.equal(grade(qSumSq, '-5, 3, 2').verdict, 'wrong');
});

test('Phase 17a — Calendar grading: English & German weekdays, single valid month, and leap years', () => {
  // Leap year checks
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2100), false);

  // 29 Feb 2024 was a Thursday (4)
  assert.equal(dayOfWeekGregorian(2024, 2, 29), 4);

  const qCalDow = {
    id: 'calendar_s1',
    category_key: 'calendar',
    slot: 1,
    max_marks: 2,
    prompt: 'What day of the week is 29 February 2024?',
    input: { type: 'text' },
    answer_key: {
      kind: 'calendar',
      subtype: 'weekday',
      weekday_index: 4,
      expected_display: 'Thursday',
    },
  };

  assert.equal(grade(qCalDow, 'Thursday').verdict, 'correct');
  assert.equal(grade(qCalDow, 'Thu').verdict, 'correct');
  assert.equal(grade(qCalDow, 'Donnerstag').verdict, 'correct');
  assert.equal(grade(qCalDow, 'Don').verdict, 'correct');
  // 2-letter abbreviation rejected per Rule 12 ("full name of the day/month or a three-letter abbreviation")
  assert.equal(grade(qCalDow, 'Do').verdict, 'wrong');
  assert.equal(grade(qCalDow, 'Friday').verdict, 'wrong');
  // Numeric weekday code rejected
  assert.equal(grade(qCalDow, '4').verdict, 'wrong');

  // Month starting on weekday (e.g. in 2026, February, March, and November all start on Sunday)
  const qCalMonth = {
    id: 'calendar_s2',
    category_key: 'calendar',
    slot: 2,
    max_marks: 2,
    prompt: 'Name a month in 2026 that starts on a Sunday:',
    input: { type: 'text' },
    answer_key: {
      kind: 'calendar',
      subtype: 'month',
      year: 2026,
      weekday_index: 0,
      valid_months: [2, 3, 11],
      expected_display: 'February / March / November',
    },
  };

  assert.equal(grade(qCalMonth, 'February').verdict, 'correct');
  assert.equal(grade(qCalMonth, 'Mar').verdict, 'correct');
  assert.equal(grade(qCalMonth, 'März').verdict, 'correct');
  assert.equal(grade(qCalMonth, 'November').verdict, 'correct');
  assert.equal(grade(qCalMonth, 'Nov').verdict, 'correct');
  // Multiple months entered at once must be rejected
  assert.equal(grade(qCalMonth, 'February, March').verdict, 'wrong');
  assert.equal(grade(qCalMonth, 'January').verdict, 'wrong');
});

test('Phase 17a — Verbatim examples from JMCWC Rules 2025.pdf (Rules 8, 10, 11, 13, 14, 15)', () => {
  // Rule 8: Digit-counting marks ("1234|56|78", "12345678", "12,345,678")
  const qRule8 = {
    id: 'addition_r8',
    category_key: 'addition',
    slot: 1,
    max_marks: 2,
    prompt: '10000000 + 2345678 =',
    input: { type: 'integer' },
    answer_key: {
      kind: 'exact_integer',
      value: '12345678',
      expected_display: '12345678',
    },
  };
  assert.equal(grade(qRule8, '1234|56|78').verdict, 'correct');
  assert.equal(grade(qRule8, '12345678').verdict, 'correct');
  assert.equal(grade(qRule8, '12,345,678').verdict, 'correct');

  // Rule 11: "1 3/7 is correct, but not 10/7 or 1 30/70"
  const qRule11 = {
    id: 'fraction_add_r11',
    category_key: 'fraction_add',
    slot: 1,
    max_marks: 2,
    prompt: '5/7 + 5/7 =',
    input: { type: 'fraction' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: '10',
      den: '7',
      expected_display: '1 3/7',
    },
  };
  assert.equal(grade(qRule11, '1 3/7').verdict, 'correct');
  assert.equal(grade(qRule11, '10/7').verdict, 'wrong');
  assert.equal(grade(qRule11, '1 30/70').verdict, 'wrong');

  // Rule 13: Prime factors of 40 ("5, 2, 2, 2", "5 × 2 × 2²", "2³, 5")
  const qRule13 = {
    id: 'prime_factors_r13',
    category_key: 'prime_factors',
    slot: 1,
    max_marks: 2,
    prompt: 'Prime factorisation of 40:',
    input: { type: 'text' },
    answer_key: {
      kind: 'prime_factorization',
      target: '40',
      expected_display: '2^3 × 5',
    },
  };
  assert.equal(grade(qRule13, '5, 2, 2, 2').verdict, 'correct');
  assert.equal(grade(qRule13, '5 × 2 × 2²').verdict, 'correct');
  assert.equal(grade(qRule13, '2³, 5').verdict, 'correct');

  // Rule 14: Sum of squares to 150
  // Correct: "10, 5, 5" or "12² + 2² + 1² + 1²"
  // Too many squares: "10, 4, 4, 3, 3"
  // Unacceptable formats: "100, 25, 25" or "144 + 4 + 1 + 1"
  const qRule14 = {
    id: 'sum_squares_r14',
    category_key: 'sum_squares',
    slot: 1,
    max_marks: 3,
    prompt: 'Express 150 as the sum of 2 to 4 nonzero positive integer squares:',
    input: { type: 'sum_squares', min_count: 2, max_count: 4 },
    answer_key: {
      kind: 'sum_of_squares',
      target: '150',
      min_count: 2,
      max_count: 4,
      example_bases: ['10', '5', '5'],
      expected_display: '10² + 5² + 5²',
    },
  };
  assert.equal(grade(qRule14, '10, 5, 5').verdict, 'correct');
  assert.equal(grade(qRule14, '12² + 2² + 1² + 1²').verdict, 'correct');
  assert.equal(grade(qRule14, '10, 4, 4, 3, 3').verdict, 'wrong');
  assert.equal(grade(qRule14, '100, 25, 25').verdict, 'wrong');
  assert.equal(grade(qRule14, '144 + 4 + 1 + 1').verdict, 'wrong');
});

test('Phase 17a — Missing-digit, blank/skipped, elapsed time, and malicious input handling', () => {
  const qMissing = {
    id: 'addition_s2',
    category_key: 'addition',
    slot: 2,
    max_marks: 2,
    prompt: 'Find the missing digit (?): 4?7 + 235 = 722',
    input: { type: 'text' },
    answer_key: {
      kind: 'exact_integer',
      value: '8',
      missing_digit: '8',
      full_number: '487',
      expected_display: '8 (full number: 487)',
    },
  };

  // Both the missing digit alone ('8') and the full number ('487') are accepted
  assert.equal(grade(qMissing, '8').verdict, 'correct');
  assert.equal(grade(qMissing, '487').verdict, 'correct');
  assert.equal(grade(qMissing, '7').verdict, 'wrong');

  // Blank / whitespace answers are graded as 'skipped' with 0 award
  assert.equal(grade(qMissing, '').verdict, 'skipped');
  assert.equal(grade(qMissing, '   ').verdict, 'skipped');
  assert.equal(grade(qMissing, null).verdict, 'skipped');

  // Malicious / injection / oversized inputs are safely rejected as 'wrong'
  assert.equal(grade(qMissing, 'process.exit(1)').verdict, 'wrong');
  assert.equal(grade(qMissing, '1; DROP TABLE jmcwc_scores;--').verdict, 'wrong');
  assert.equal(grade(qMissing, '9'.repeat(500)).verdict, 'wrong');
  assert.equal(grade(qMissing, '8\x00').verdict, 'wrong');

  // Elapsed time checks
  const qTime = {
    id: 'elapsed_time_s1',
    category_key: 'elapsed_time',
    slot: 1,
    max_marks: 2,
    prompt: 'Time elapsed from 09:40 to 13:15:',
    input: { type: 'elapsed_time', format: 'hours_minutes' },
    answer_key: {
      kind: 'elapsed_time',
      format: 'hours_minutes',
      total_minutes: 215,
      hours: 3,
      minutes: 35,
      expected_display: '3h 35m',
    },
  };
  assert.equal(grade(qTime, '3:35').verdict, 'correct');
  assert.equal(grade(qTime, '3h 35m').verdict, 'correct');
  assert.equal(grade(qTime, ['3', '35']).verdict, 'correct');
  assert.equal(grade(qTime, { hours: '3', minutes: '35' }).verdict, 'correct');
  assert.equal(grade(qTime, '215').verdict, 'wrong'); // when hours_minutes is required
});

test('Phase 17a — Deterministic seeded generation across all 23 categories & public payload security', () => {
  assert.equal(JMCWC_CATEGORY_KEYS.length, 23);
  assert.equal(JMCWC_CATEGORY_REGISTRY.length, 23);

  for (const groupKey of ['junior1', 'junior2', 'senior']) {
    const paper = JMCWC_DRAFT_PAPERS[groupKey];
    const validation = validatePaperBlueprint(paper);
    assert.equal(validation.valid, true, `Blueprint for ${groupKey} must be structurally valid`);
    // Fully source-verified and publishable
    assert.equal(validation.canPublish, true);
    assert.equal(paper.published, true);
    assert.equal(paper.spec.source_verified, true);

    // Deterministic seeded generation: same seed produces identical questions
    const run1 = generateQuestionsFromBlueprint(paper.spec, {
      mode: 'flat',
      seed: `test-seed-${groupKey}`,
    });
    const run2 = generateQuestionsFromBlueprint(paper.spec, {
      mode: 'flat',
      seed: `test-seed-${groupKey}`,
    });
    assert.deepEqual(run1.privateQuestions, run2.privateQuestions);

    // Every one of the 23 categories is represented
    const generatedCats = new Set(run1.privateQuestions.map((q) => q.category_key));
    assert.equal(generatedCats.size, 23);

    // Public questions never leak answer_key or seed
    for (const pubQ of run1.publicQuestions) {
      assert.equal(Object.prototype.hasOwnProperty.call(pubQ, 'answer_key'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(pubQ, 'seed'), false);
    }

    // Self-consistency check: every generated question's canonical expected answer grades as 'correct' with full marks!
    const perfectAnswers = {};
    for (const privQ of run1.privateQuestions) {
      const ak = privQ.answer_key;
      if (ak.kind === 'integer_pair') {
        perfectAnswers[privQ.id] = ak.values;
      } else if (ak.kind === 'ratio' && Array.isArray(ak.terms)) {
        perfectAnswers[privQ.id] = ak.terms.join(' : ');
      } else if (ak.kind === 'sum_of_squares') {
        perfectAnswers[privQ.id] = ak.example_bases.join(', ');
      } else if (ak.kind === 'calendar' && ak.subtype === 'month') {
        perfectAnswers[privQ.id] = ak.expected_display.split(' / ')[0];
      } else if (ak.kind === 'calendar' && ak.subtype === 'year') {
        perfectAnswers[privQ.id] = String(ak.valid_years[0]);
      } else if (ak.missing_digit !== undefined) {
        perfectAnswers[privQ.id] = String(ak.missing_digit);
      } else {
        perfectAnswers[privQ.id] = String(ak.expected_display);
      }
    }

    const summary = gradeAttempt(run1.privateQuestions, perfectAnswers);
    assert.equal(summary.correct, run1.privateQuestions.length);
    assert.equal(summary.wrong, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.marks, summary.max_marks);
  }
});

test('Phase 17a — Source-verified paper topology, slot counts, cached totals & first/middle/final slot coverage', () => {
  const expectedTotals = {
    junior1: { questions: 440, cachedMarks: 2310, file: 'JMCWC-2026-Simulator-Juniors-1.xlsx' },
    junior2: { questions: 445, cachedMarks: 2469, file: 'JMCWC-2026-Simulator-Juniors-2.xlsx' },
    senior:  { questions: 446, cachedMarks: 2595, file: 'JMCWC-2026-Simulator-Seniors.xlsx' },
  };

  for (const [groupKey, meta] of Object.entries(expectedTotals)) {
    const paper = JMCWC_DRAFT_PAPERS[groupKey];
    assert.equal(paper.group_key, groupKey);
    assert.equal(paper.version, '2026.1');
    assert.equal(paper.spec.source_workbook, meta.file);
    assert.equal(paper.spec.total_questions, meta.questions);
    assert.equal(paper.spec.total_cached_marks, meta.cachedMarks);
    assert.equal(paper.spec.sections.length, 23);

    let actualTotalQuestions = 0;
    let actualCachedMarks = 0;

    for (const sec of paper.spec.sections) {
      assert.ok(sec.questions.length > 0, `Section ${sec.key} in ${groupKey} must have questions`);
      actualTotalQuestions += sec.questions.length;
      actualCachedMarks += sec.expectedTotal;

      // Sample first (slot 1), middle (slot Math.ceil(len/2)), and final (slot len)
      const len = sec.questions.length;
      const testIndices = [0, Math.floor(len / 2), len - 1];

      for (const idx of testIndices) {
        const slotObj = sec.questions[idx];
        assert.equal(slotObj.slot, idx + 1);
        assert.ok(slotObj.max_marks > 0);
        assert.ok(slotObj.generator);
        assert.ok(slotObj.source_ref);
        assert.equal(slotObj.source_ref.workbook, meta.file);
        assert.equal(slotObj.source_ref.sheet, sec.workbook_sheet);

        // Generate sample question for this slot and verify mathematical validity
        const rng = createSeededRng(`sample-${groupKey}-${sec.key}-${slotObj.slot}`);
        const genQ = generateQuestionForSlot(sec.key, slotObj, rng);
        assert.equal(genQ.category_key, sec.key);
        assert.equal(genQ.slot, slotObj.slot);
        assert.ok(genQ.prompt.length > 0);
        assert.ok(genQ.answer_key);

        // Verify public projection strips private keys
        const pubQ = toPublicQuestion(genQ);
        assert.equal(pubQ.id, genQ.id);
        assert.equal(pubQ.slot, genQ.slot);
        assert.equal(pubQ.max_marks, genQ.max_marks);
        assert.equal(Object.prototype.hasOwnProperty.call(pubQ, 'answer_key'), false);
      }
    }

    assert.equal(actualTotalQuestions, meta.questions, `Total question count for ${groupKey} must match`);
    assert.equal(actualCachedMarks, meta.cachedMarks, `Total cached marks for ${groupKey} must match`);
  }

  // Verify the 4 forensic repair areas in all blueprints
  for (const groupKey of ['junior1', 'junior2', 'senior']) {
    const spec = JMCWC_DRAFT_PAPERS[groupKey].spec;
    const multSec = spec.sections.find((s) => s.key === 'multiplication');
    assert.equal(multSec.questions.length, 20, 'Multiplication must have exactly 20 active slots');

    const bracketsSec = spec.sections.find((s) => s.key === 'brackets');
    assert.equal(bracketsSec.questions.length, 20, 'Brackets must have exactly 20 active slots');
    assert.ok(bracketsSec.questions[19].source_ref.repair_note, 'Brackets slot 20 must have repair note');

    const fracMulSec = spec.sections.find((s) => s.key === 'fraction_mul');
    assert.equal(fracMulSec.questions.length, 17, 'Fraction multiplication must have exactly 17 printed slots');
    assert.ok(fracMulSec.questions[16].source_ref.repair_note, 'Fraction mul slot 17 must have repair note');

    const cubeRootSec = spec.sections.find((s) => s.key === 'cube_root');
    assert.equal(cubeRootSec.questions.length, 23, 'Cube roots must have exactly 23 slots');
    assert.ok(cubeRootSec.questions[22].source_ref.repair_note, 'Cube roots slot 23 must have repair note');
  }
});

