/**
 * Trendz Tracker — Phase 17a: JMCWC Simulator Server-Only Question Generator (api/_jmcwcGenerate.js)
 *
 * Generates private JMCWC questions from versioned blueprint slots and strips private
 * answer keys before sending public question payloads to the browser.
 *
 * Contract:
 * - Private question: { id, category_key, slot, max_marks, prompt, input, answer_key }
 * - Public question:  { id, category_key, slot, max_marks, prompt, input }
 */

import {
  absBigInt,
  addRational,
  computeExactRationalScaled,
  computeExactSqrtScaled,
  createCryptoRng,
  createSeededRng,
  dayOfWeekGregorian,
  daysInMonth,
  divRational,
  factorizeBigInt,
  findSumOfSquaresDecomposition,
  formatMixedFraction,
  formatPrimeFactorization,
  formatScaledUnits,
  gcdBigInt,
  gcdManyBigInt,
  icbrtBigInt,
  isLeapYear,
  isPrimeBigInt,
  isqrtBigInt,
  JMCWC_CATEGORY_KEYS,
  lcmBigInt,
  lcmManyBigInt,
  makeRational,
  MONTH_NAMES_EN,
  mulRational,
  nextCubeBigInt,
  nextSquareBigInt,
  pow10BigInt,
  roundBigIntToSigFigs,
  roundScaledAtDecimals,
  subRational,
  WEEKDAY_NAMES_EN,
} from './_jmcwcMath.js';

/**
 * Faithful workbook-derived dynamic scoring rules.
 * Strictly registered pure functions — NO eval or Function is used.
 */
export const DYNAMIC_SCORING_RULES = Object.freeze({
  /**
   * Int Mults: BD23 = INT(BD22^0.75 + 0.35) where BD22 = INT(BD20+1) * INT(BD21+1)
   * Factors d1 and d2 base-10 digit lengths.
   */
  multiplication_digits_product: (factors) => {
    const d1 = String(factors[0]).replace(/^-/, '').length;
    const d2 = String(factors[1]).replace(/^-/, '').length;
    return Math.floor(Math.pow(d1 * d2, 0.75) + 0.35);
  },

  /**
   * Primes: G{dispR} = INT(CA{genR} * 1.2)
   * CA is looked up in composite target ranges ($Q$16..$R$27).
   */
  prime_factors_target_scale: (target) => {
    const n = Number(target);
    let ca = 9;
    if (n < 400) ca = 3;
    else if (n < 650) ca = 3;
    else if (n < 1000) ca = 4;
    else if (n < 1500) ca = 4;
    else if (n < 2000) ca = 5;
    else if (n < 3500) ca = 5;
    else if (n < 7000) ca = 6;
    else if (n < 10000) ca = 6;
    else if (n < 15000) ca = 7;
    else if (n < 25000) ca = 7;
    else if (n < 40000) ca = 8;
    return Math.floor(ca * 1.2);
  },

  /**
   * Approximations: (BU + BU^2)/2 + 1 where BU is digit count of rounded integer product/quotient.
   */
  approximation_product_digits: (intVal) => {
    const d = String(BigInt(intVal) < 0n ? -BigInt(intVal) : BigInt(intVal)).length;
    return Math.floor((d + d * d) / 2 + 1);
  },

  /**
   * Sums of Squares (Junior 1): G{r} = L{r} + M{r} - 2
   * L is count of squares in generator's decomposition, M is target digits.
   */
  sum_squares_j1_decomposition: (target, basesCount) => {
    const m = String(target).replace(/^-/, '').length;
    const l = Number(basesCount);
    return l + m - 2;
  },

  /**
   * Sums of Squares (Junior 2): G{r} = AJ{r} + J{r} (J=0)
   * AJ = target < 100 ? 2 : target < 400 ? 3 : target < 1000 ? 4 : target > 10000 ? 10 : 6
   */
  sum_squares_j2_target: (target) => {
    const n = Number(target);
    if (n < 100) return 2;
    if (n < 400) return 3;
    if (n < 1000) return 4;
    if (n > 10000) return 10;
    return 6;
  },

  /**
   * Sums of Squares (Senior): G{r} = AJ{r} + J{r} (J=0)
   * AJ = target < 100 ? 2 : target < 400 ? 3 : target < 1000 ? 4 : target < 2000 ? 5 : target > 10000 ? 10 : 6
   */
  sum_squares_sr_target: (target) => {
    const n = Number(target);
    if (n < 100) return 2;
    if (n < 400) return 3;
    if (n < 1000) return 4;
    if (n < 2000) return 5;
    if (n > 10000) return 10;
    return 6;
  },
});

/**
 * Strip `answer_key` and any internal marking fields from a private question object.
 * Never returns `answer_key` or RNG seed data.
 */
export function toPublicQuestion(privateQuestion) {
  if (!privateQuestion || typeof privateQuestion !== 'object') {
    throw new Error('Invalid question object');
  }
  return {
    id: String(privateQuestion.id),
    category_key: String(privateQuestion.category_key),
    slot: Number(privateQuestion.slot),
    max_marks: Number(privateQuestion.max_marks),
    prompt: String(privateQuestion.prompt),
    input: structuredClone(privateQuestion.input),
  };
}

export function toPublicQuestions(privateQuestions) {
  if (!Array.isArray(privateQuestions)) {
    throw new Error('privateQuestions must be an array');
  }
  return privateQuestions.map(toPublicQuestion);
}

/**
 * Helper to generate a random BigInt with a specified number of base-10 digits (or [minDigits, maxDigits]).
 */
function randomBigIntByDigits(rng, minDigits, maxDigits = minDigits, { nonZeroLast = false } = {}) {
  const d = rng.int(minDigits, maxDigits);
  if (d <= 0) return 0n;
  const lo = d === 1 ? 1n : pow10BigInt(d - 1);
  const hi = pow10BigInt(d) - 1n;
  let val = rng.bigInt(lo, hi);
  if (nonZeroLast && val % 10n === 0n) {
    val += BigInt(rng.int(1, 9));
  }
  return val;
}

/**
 * Replace one digit in a positive integer string with `?` for missing-digit subtypes.
 */
function maskSingleDigit(rng, numberBigInt, { avoidLeading = false } = {}) {
  const fullStr = absBigInt(numberBigInt).toString();
  const minIdx = avoidLeading && fullStr.length > 1 ? 1 : 0;
  const idx = rng.int(minIdx, fullStr.length - 1);
  const missingDigit = fullStr[idx];
  const maskedStr = `${fullStr.slice(0, idx)}?${fullStr.slice(idx + 1)}`;
  return {
    fullStr: numberBigInt < 0n ? `-${fullStr}` : fullStr,
    maskedStr: numberBigInt < 0n ? `-${maskedStr}` : maskedStr,
    missingDigit,
  };
}

// ============================================================================
// Category Slot Generators (All 23 Categories & Subtypes)
// ============================================================================

function genAddition(rng, params = {}) {
  const subtype = params.subtype || 'standard';
  const termsCount = Math.max(2, Number(params.terms ?? (params.count ?? 2)));
  let digits = Number(params.digits ?? params.length ?? 0);
  if (!digits) {
    if (params.level) {
      digits = Math.max(2, Number(params.level) + 3 - termsCount);
    } else if (params.total_digits) {
      digits = Math.max(2, Math.floor(Number(params.total_digits) / termsCount));
    } else {
      digits = 3;
    }
  }

  const terms = Array.from({ length: termsCount }, () =>
    randomBigIntByDigits(rng, digits, digits)
  );
  const sum = terms.reduce((acc, v) => acc + v, 0n);

  if (subtype === 'missing_digit') {
    const targetIdx = rng.int(0, terms.length - 1);
    const masked = maskSingleDigit(rng, terms[targetIdx], { avoidLeading: true });
    const displayTerms = terms.map((t, i) => (i === targetIdx ? masked.maskedStr : t.toString()));
    return {
      prompt: `Find the missing digit (?): ${displayTerms.join(' + ')} = ${sum.toString()}`,
      input: { type: 'text', placeholder: 'Missing digit (or full number)', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: masked.missingDigit,
        missing_digit: masked.missingDigit,
        full_number: masked.fullStr,
        expected_display: `${masked.missingDigit} (full number: ${masked.fullStr})`,
        explanation: `${terms.map((t) => t.toString()).join(' + ')} = ${sum.toString()}, so ? = ${masked.missingDigit}.`,
      },
    };
  }

  return {
    prompt: `${terms.map((t) => t.toString()).join(' + ')} =`,
    input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: sum.toString(),
      expected_display: sum.toString(),
      explanation: `${terms.map((t) => t.toString()).join(' + ')} = ${sum.toString()}.`,
    },
  };
}

function genSubtraction(rng, params = {}) {
  const subtype = params.subtype || 'standard';
  const d1 = Array.isArray(params.minuend_digits)
    ? params.minuend_digits
    : [Number(params.minuend_digits ?? params.digits ?? 4), Number(params.minuend_digits ?? params.digits ?? 4)];

  let a = randomBigIntByDigits(rng, d1[0], d1[1]);
  let b;
  if (params.subtrahend_max_ratio) {
    const ratioBig = BigInt(Math.floor(Number(params.subtrahend_max_ratio) * 100));
    const maxSub = (a * ratioBig) / 100n;
    b = maxSub > 1n ? rng.bigInt(1n, maxSub) : 1n;
  } else if (params.subtrahend_digits) {
    const d2 = Array.isArray(params.subtrahend_digits) ? params.subtrahend_digits : [params.subtrahend_digits, params.subtrahend_digits];
    b = randomBigIntByDigits(rng, d2[0], d2[1]);
  } else {
    // Excel formula: AD = INT(RAND()*AB*0.8)+1.
    // If a % 5 === 0, 0.8 * a is integer, max is 0.8 * a. Otherwise, max is floor(0.8 * a) + 1.
    const maxSub = (a * 4n) / 5n + (a % 5n === 0n ? 0n : 1n);
    b = maxSub > 1n ? rng.bigInt(1n, maxSub) : 1n;
  }

  if (!params.allow_negative && a < b) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  if (a === b) a += 1n;
  const diff = a - b;

  if (subtype === 'missing_digit') {
    const masked = maskSingleDigit(rng, b, { avoidLeading: true });
    return {
      prompt: `Find the missing digit (?): ${a.toString()} − ${masked.maskedStr} = ${diff.toString()}`,
      input: { type: 'text', placeholder: 'Missing digit (or full number)', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: masked.missingDigit,
        missing_digit: masked.missingDigit,
        full_number: masked.fullStr,
        expected_display: `${masked.missingDigit} (full number: ${masked.fullStr})`,
        explanation: `${a.toString()} − ${b.toString()} = ${diff.toString()}, so ? = ${masked.missingDigit}.`,
      },
    };
  }

  return {
    prompt: `${a.toString()} − ${b.toString()} =`,
    input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: diff.toString(),
      expected_display: diff.toString(),
      explanation: `${a.toString()} − ${b.toString()} = ${diff.toString()}.`,
    },
  };
}

/**
 * Sample a continuous fractional multiplier from the workbook formula:
 *   INT(base * (RAND() * spanFrac + minFrac))
 * RAND() draws an IEEE 754 53-bit continuous float in [0, 1).
 * Preserves reachable results (e.g. 333,333 from 1,000,000) and strict half-open endpoints.
 */
function sampleContinuousMixedOperand(rng, base, minFrac, spanFrac) {
  const u = typeof rng?.float === 'function' ? rng.float() : (typeof rng?.next === 'function' ? rng.next() : Math.random());
  const frac = minFrac + spanFrac * u;
  if (base < 9007199254740991n) {
    return BigInt(Math.floor(Number(base) * frac));
  }
  const SCALE = 1000000000000000n; // 10^15
  const fracScaled = BigInt(Math.floor(frac * 1e15));
  return (base * fracScaled) / SCALE;
}

function genMixed(rng, params = {}) {
  const termsCount = Math.max(3, Number(params.terms ?? (params.count ?? 3)));
  let d = Number(params.digits ?? params.length ?? 0);
  if (!d) {
    if (params.level) {
      d = Math.max(2, Number(params.level));
    } else if (params.total_digits) {
      d = Math.max(2, Math.floor(Number(params.total_digits) / termsCount));
    } else {
      d = 3;
    }
  }

  // Workbook formula (e.g. Junior 1 row 8):
  // AO: initial full-width random operand of d digits
  // AQ (-): INT(AO * (RAND() * 0.4 + 0.3)) -> continuous float in [0.3, 0.7) of AO
  // AS (+): INT(AO * (RAND() * 0.5 + 0.5)) -> continuous float in [0.5, 1.0) of AO
  // AU (-): INT(AO * (RAND() * 0.4 + 0.3)) -> continuous float in [0.3, 0.7) of AO
  // AW (+): random d-digit integer
  const AO = randomBigIntByDigits(rng, d, d);
  const terms = [AO];
  const ops = [];
  let running = AO;

  for (let i = 1; i < termsCount; i++) {
    let t;
    let op;
    if (i === 1) {
      op = '-';
      t = sampleContinuousMixedOperand(rng, AO, 0.3, 0.4);
      if (t < 1n) t = 1n;
      if (t >= running) t = running > 1n ? running - 1n : 1n;
    } else if (i === 2) {
      op = '+';
      t = sampleContinuousMixedOperand(rng, AO, 0.5, 0.5);
      if (t < 1n) t = 1n;
    } else if (i === 3) {
      op = '-';
      t = sampleContinuousMixedOperand(rng, AO, 0.3, 0.4);
      if (t < 1n) t = 1n;
      if (t >= running) t = running > 1n ? running - 1n : 1n;
    } else {
      op = i % 2 === 1 ? '-' : '+';
      t = randomBigIntByDigits(rng, d, d);
      if (op === '-' && t >= running) {
        t = (running * 6n) / 10n;
        if (t < 1n) {
          t = 1n;
          op = '+';
        }
      }
    }
    ops.push(op);
    terms.push(t);
    running = op === '+' ? running + t : running - t;
  }

  let expr = terms[0].toString();
  for (let i = 1; i < terms.length; i++) {
    expr += ` ${ops[i - 1] === '-' ? '−' : '+'} ${terms[i].toString()}`;
  }

  return {
    prompt: `${expr} =`,
    input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: running.toString(),
      expected_display: running.toString(),
      explanation: `${expr} = ${running.toString()}.`,
    },
  };
}

function genMultiplication(rng, params = {}) {
  const subtype = params.subtype || 'standard';
  let factors;
  if (params.total_digits && Array.isArray(params.d2_range)) {
    const lo = params.d2_range[0];
    const hi = params.d2_range[1];
    let d2;
    // Source formula: AA = INT(RAND()*(Z+1-Y)+Y). When Z+1-Y <= 0 (e.g. Y=2, Z=1), d2 is strictly Y.
    if (hi + 1 - lo <= 0) {
      d2 = lo;
    } else {
      const minD = Math.min(lo, hi);
      const maxD = Math.max(lo, hi);
      d2 = rng.int(minD, maxD);
    }
    const d1 = params.total_digits - d2;
    // Excel formulas allow factors ending in zero (e.g. 7 × 30)
    const f1 = randomBigIntByDigits(rng, d1, d1, { nonZeroLast: false });
    const f2 = randomBigIntByDigits(rng, d2, d2, { nonZeroLast: false });
    factors = [f1, f2];
  } else {
    const factorDigits = Array.isArray(params.factor_digits) ? params.factor_digits : [2, 2];
    factors = factorDigits.map((d) => {
      if (Array.isArray(d)) return randomBigIntByDigits(rng, d[0], d[1], { nonZeroLast: false });
      return randomBigIntByDigits(rng, Number(d), Number(d), { nonZeroLast: false });
    });
  }
  const prod = factors.reduce((acc, v) => acc * v, 1n);

  const scoring_data = {
    factors: [factors[0].toString(), factors[1].toString()],
  };

  if (subtype === 'missing_digit') {
    const masked = maskSingleDigit(rng, prod, { avoidLeading: true });
    return {
      prompt: `Find the missing digit (?): ${factors.map((f) => f.toString()).join(' × ')} = ${masked.maskedStr}`,
      input: { type: 'text', placeholder: 'Missing digit (or full number)', mode: 'numeric' },
      scoring_data,
      answer_key: {
        kind: 'exact_integer',
        value: masked.missingDigit,
        missing_digit: masked.missingDigit,
        full_number: masked.fullStr,
        expected_display: `${masked.missingDigit} (full number: ${masked.fullStr})`,
        explanation: `${factors.map((f) => f.toString()).join(' × ')} = ${prod.toString()}, so ? = ${masked.missingDigit}.`,
      },
    };
  }

  return {
    prompt: `${factors.map((f) => f.toString()).join(' × ')} =`,
    input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
    scoring_data,
    answer_key: {
      kind: 'exact_integer',
      value: prod.toString(),
      expected_display: prod.toString(),
      explanation: `${factors.map((f) => f.toString()).join(' × ')} = ${prod.toString()}.`,
    },
  };
}

function genDivision(rng, params = {}) {
  const subtype = params.subtype || 'exact';
  const vLevel = Number(params.v_level || 3);
  let minDivDigits;
  let maxDivDigits;

  if (Array.isArray(params.divisor_digits)) {
    minDivDigits = Number(params.divisor_digits[0]);
    maxDivDigits = Number(params.divisor_digits[1]);
  } else if (params.divisor_digits !== undefined && params.divisor_digits !== null) {
    minDivDigits = Number(params.divisor_digits);
    maxDivDigits = Number(params.divisor_digits);
  } else {
    // Excel formula: X = IF(V=2,1,IF(V>12,2*V-23,2)), Y = INT(V/1.5)
    minDivDigits = vLevel === 2 ? 1 : (vLevel > 12 ? 2 * vLevel - 23 : 2);
    maxDivDigits = Math.floor(vLevel / 1.5);
  }

  // Divisor digits Z sampled from [minDivDigits, maxDivDigits]
  const loZ = Math.min(minDivDigits, maxDivDigits);
  const hiZ = Math.max(minDivDigits, maxDivDigits);
  const Z = (hiZ >= loZ) ? rng.int(loZ, hiZ) : loZ;

  // Active dependency chain: target dividend digits AB = V + 1 - INT(Z/2 + 0.5)
  const AB = (params.dividend_digits && !params.v_level)
    ? Number(params.dividend_digits)
    : Math.max(Z, vLevel + 1 - Math.floor(Z / 2 + 0.5));

  // Divisor AF: if Z === 1 then INT(8*RAND()+2) (2..9), else Z digits
  let divisor = (Z === 1)
    ? BigInt(rng.int(2, 9))
    : randomBigIntByDigits(rng, Z, Z, { nonZeroLast: false });
  if (divisor < 2n) divisor = 2n;

  // Target dividend AH: AB digits
  const targetDividend = randomBigIntByDigits(rng, AB, AB, { nonZeroLast: false });
  let quotient = targetDividend / divisor;
  if (quotient < 1n) quotient = 1n;

  // Exact division construction from workbook:
  let dividend = quotient * divisor;
  if (dividend.toString().length < AB) {
    dividend += divisor;
    quotient = dividend / divisor;
  }

  if (subtype === 'missing_digit') {
    const masked = maskSingleDigit(rng, dividend, { avoidLeading: true });
    return {
      prompt: `Find the missing digit (?): ${masked.maskedStr} ÷ ${divisor.toString()} = ${quotient.toString()}`,
      input: { type: 'text', placeholder: 'Missing digit (or full number)', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: masked.missingDigit,
        missing_digit: masked.missingDigit,
        full_number: masked.fullStr,
        expected_display: `${masked.missingDigit} (full number: ${masked.fullStr})`,
        explanation: `${divisor.toString()} × ${quotient.toString()} = ${dividend.toString()}, so ? = ${masked.missingDigit}.`,
      },
    };
  }

  return {
    prompt: `${dividend.toString()} ÷ ${divisor.toString()} =`,
    input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: quotient.toString(),
      expected_display: quotient.toString(),
      explanation: `${dividend.toString()} ÷ ${divisor.toString()} = ${quotient.toString()}.`,
    },
  };
}

function genBrackets(rng, params = {}) {
  const subtype = params.subtype || 'distributive_add';
  const digits = Number(params.digits ?? 2);

  // Authentic JMCWC Simulator Brackets subtypes (from 06_Brackets workbook):
  if (subtype === 'ac_2') {
    // Row 5..9 in workbook: (a + b) × (c + d) where a, b, c, d in [2, 9]
    const a = BigInt(rng.int(2, 9));
    const b = BigInt(rng.int(2, 9));
    const c = BigInt(rng.int(2, 9));
    const d = BigInt(rng.int(2, 9));
    const val = (a + b) * (c + d);
    return {
      prompt: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) = ${(a + b).toString()} × ${(c + d).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_3') {
    // Row 11..19 in workbook: (a + b) × (c + d) where a, b, c, d in [11, 39]
    const a = BigInt(rng.int(11, 39));
    const b = BigInt(rng.int(11, 39));
    const c = BigInt(rng.int(11, 39));
    const d = BigInt(rng.int(11, 39));
    const val = (a + b) * (c + d);
    return {
      prompt: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) = ${(a + b).toString()} × ${(c + d).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_4') {
    // Row 21..27 in workbook: (a + b) × (c + d) where a, b, c, d in [41, 65]
    const a = BigInt(rng.int(41, 65));
    const b = BigInt(rng.int(41, 65));
    const c = BigInt(rng.int(41, 65));
    const d = BigInt(rng.int(41, 65));
    const val = (a + b) * (c + d);
    return {
      prompt: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()}) × (${c.toString()} + ${d.toString()}) = ${(a + b).toString()} × ${(c + d).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_5') {
    // Row 29..37 in workbook: (a + b) ÷ (c + d)
    // c, d in [35, 64]; raw dividend parts in [111, 999] constructed so (a + b) % (c + d) === 0
    const cp = rng.int(111, 999);
    const cq = rng.int(111, 999);
    const cr = rng.int(35, 64);
    const cs = rng.int(35, 64);
    const ct = cp + cq;
    const cu = cr + cs;
    const cv = Math.floor(ct / cu) + 1;
    const cw = cv * cu;
    const cx = cw - cp > 999 ? cw - cp - cu : cw - cp;
    const cy = cx + cp === cw ? cv : cv - 1;
    const a = BigInt(cp);
    const b = BigInt(cx);
    const c = BigInt(cr);
    const d = BigInt(cs);
    const val = BigInt(cy);
    return {
      prompt: `(${a.toString()} + ${b.toString()}) ÷ (${c.toString()} + ${d.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()}) ÷ (${c.toString()} + ${d.toString()}) = ${(a + b).toString()} ÷ ${(c + d).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_6') {
    // Row 39..43 in workbook: (a + (b × c)) × (d − e)
    // a in [51, 99], b in [2, 9], c in [51, 99], d in [481, 999], e in [51, 99]
    const a = BigInt(rng.int(51, 99));
    const b = BigInt(rng.int(2, 9));
    const c = BigInt(rng.int(51, 99));
    const d = BigInt(rng.int(481, 999));
    const e = BigInt(rng.int(51, 99));
    const val = (a + b * c) * (d - e);
    return {
      prompt: `(${a.toString()} + (${b.toString()} × ${c.toString()})) × (${d.toString()} − ${e.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + (${b.toString()} × ${c.toString()})) × (${d.toString()} − ${e.toString()}) = ${(a + b * c).toString()} × ${(d - e).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_7') {
    // ((a − b) ÷ c) × (d + e)
    const es = rng.int(2, 9);
    const et = rng.int(11, 99);
    const eu = rng.int(125, 999);
    const ev = rng.int(125, 999);
    const ey = rng.int(125, 999);
    const ew = ey - es;
    const ex = Math.floor(ew / et);
    const er = ex * et + es;
    const eq = er > 999 ? er - et : er < 125 ? er + et : er;
    const a = BigInt(eq);
    const b = BigInt(es);
    const c = BigInt(et);
    const d = BigInt(eu);
    const e = BigInt(ev);
    const val = ((a - b) / c) * (d + e);
    return {
      prompt: `((${a.toString()} − ${b.toString()}) ÷ ${c.toString()}) × (${d.toString()} + ${e.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `((${a.toString()} − ${b.toString()}) ÷ ${c.toString()}) × (${d.toString()} + ${e.toString()}) = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'ac_8') {
    // ((a − b) ÷ c) × (d + e) with larger operands
    const fv = rng.int(11, 99);
    const fw = rng.int(11, 99);
    const fx = rng.int(1111, 9999);
    const fy = rng.int(125, 999);
    const fu = rng.int(125, 999);
    const fz = fu - fv;
    const ga = Math.floor(fz / fw);
    const gb = ga * fw + fv;
    const gd = gb > 999 ? gb - fw : gb < 125 ? gb + fw : gb;
    const a = BigInt(gd);
    const b = BigInt(fv);
    const c = BigInt(fw);
    const d = BigInt(fx);
    const e = BigInt(fy);
    const val = ((a - b) / c) * (d + e);
    return {
      prompt: `((${a.toString()} − ${b.toString()}) ÷ ${c.toString()}) × (${d.toString()} + ${e.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `((${a.toString()} − ${b.toString()}) ÷ ${c.toString()}) × (${d.toString()} + ${e.toString()}) = ${val.toString()}.`,
      },
    };
  }

  // Legacy unit test subtypes:
  if (subtype === 'difference_of_squares') {
    const a = randomBigIntByDigits(rng, digits, digits);
    const b = BigInt(rng.int(2, 25));
    const left = a + b;
    const right = a - b;
    const val = left * right;
    return {
      prompt: `(${a.toString()} + ${b.toString()}) × (${a.toString()} − ${b.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()})(${a.toString()} − ${b.toString()}) = ${a.toString()}² − ${b.toString()}² = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'sum_of_products') {
    const k = randomBigIntByDigits(rng, digits, digits);
    const a = randomBigIntByDigits(rng, digits, digits);
    const b = randomBigIntByDigits(rng, digits, digits);
    const val = k * (a + b);
    return {
      prompt: `${k.toString()} × (${a.toString()} + ${b.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `${k.toString()} × (${a.toString()} + ${b.toString()}) = ${k.toString()} × ${(a + b).toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'nested_brackets') {
    const a = BigInt(rng.int(12, 45));
    const b = BigInt(rng.int(5, 25));
    const c = BigInt(rng.int(3, 15));
    const d = BigInt(rng.int(4, 19));
    const val = (a + b) * c - d;
    return {
      prompt: `[ (${a.toString()} + ${b.toString()}) × ${c.toString()} ] − ${d.toString()} =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${a.toString()} + ${b.toString()}) × ${c.toString()} − ${d.toString()} = ${(a + b).toString()} × ${c.toString()} − ${d.toString()} = ${val.toString()}.`,
      },
    };
  }

  if (subtype === 'distributive_add') {
    const a = randomBigIntByDigits(rng, digits, digits);
    const b = randomBigIntByDigits(rng, digits, digits);
    const c = randomBigIntByDigits(rng, digits, digits);
    const d = BigInt(rng.int(1, Number(c > 20n ? 19n : c - 1n)));
    const val = (a + b) * (c - d);
    return {
      prompt: `(${a.toString()} + ${b.toString()}) × (${c.toString()} − ${d.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: val.toString(),
        expected_display: val.toString(),
        explanation: `(${(a + b).toString()}) × (${(c - d).toString()}) = ${val.toString()}.`,
      },
    };
  }

  // Explicit failure on any unknown subtype — zero silent generic fallbacks!
  throw new Error(`Unsupported brackets subtype: ${subtype}`);
}

function genPrimeFactors(rng, params = {}) {
  let target = 1n;
  if (Array.isArray(params.factor_ranges)) {
    for (const r of params.factor_ranges) {
      if (Array.isArray(r) && (r[0] > 1 || r[1] > 1)) {
        const lo = Math.min(r[0], r[1]);
        const hi = Math.max(r[0], r[1]);
        target *= BigInt(rng.int(lo, hi));
      }
    }
  } else {
    const primesPool = Array.isArray(params.primes_pool)
      ? params.primes_pool.map((p) => BigInt(p))
      : [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];
    const minFactors = Number(params.min_factors ?? 3);
    const maxFactors = Number(params.max_factors ?? 5);
    const count = rng.int(minFactors, maxFactors);

    for (let i = 0; i < count; i++) {
      target *= rng.pick(primesPool);
    }
  }

  const factors = factorizeBigInt(target);
  const formatted = formatPrimeFactorization(factors);
  const scoring_data = {
    target: target.toString(),
  };

  return {
    prompt: `Prime factorisation of ${target.toString()}:`,
    input: {
      type: 'text',
      placeholder: 'e.g. 2^2 × 3 × 5 or 2 × 2 × 3 × 5',
      mode: 'text',
    },
    scoring_data,
    answer_key: {
      kind: 'prime_factorization',
      target: target.toString(),
      factors: factors.map((f) => ({ prime: f.prime.toString(), exp: f.exp })),
      expected_display: formatted,
      explanation: `${target.toString()} = ${formatted}.`,
    },
  };
}

// Authentic HCF & LCM lookup tables from workbook sheet 08_HCF_LCM (D63:I71 for HCF and D93:I101 for LCM)
const HCF_LOOKUP = [
  null,
  { minOp: 21, maxOp: 252, minFac: 2, maxFac: 12 },      // M = 1
  { minOp: 61, maxOp: 732, minFac: 5, maxFac: 16 },      // M = 2
  { minOp: 101, maxOp: 1212, minFac: 6, maxFac: 24 },    // M = 3
  { minOp: 301, maxOp: 3612, minFac: 8, maxFac: 42 },    // M = 4
  { minOp: 601, maxOp: 7212, minFac: 12, maxFac: 64 },   // M = 5
  { minOp: 1001, maxOp: 12012, minFac: 15, maxFac: 96 }, // M = 6
  { minOp: 5001, maxOp: 60012, minFac: 20, maxFac: 145 },// M = 7
  { minOp: 10001, maxOp: 120012, minFac: 27, maxFac: 203 },// M = 8
  { minOp: 35001, maxOp: 420012, minFac: 34, maxFac: 252 },// M = 9
];

const LCM_LOOKUP = [
  null,
  { minOp: 21, maxOp: 252, minFac: 10, maxFac: 21 },     // M = 1
  { minOp: 61, maxOp: 732, minFac: 30, maxFac: 61 },     // M = 2
  { minOp: 81, maxOp: 972, minFac: 40, maxFac: 81 },     // M = 3
  { minOp: 125, maxOp: 1500, minFac: 62, maxFac: 125 },  // M = 4
  { minOp: 201, maxOp: 2412, minFac: 100, maxFac: 201 }, // M = 5
  { minOp: 301, maxOp: 3612, minFac: 150, maxFac: 301 }, // M = 6
  { minOp: 501, maxOp: 6012, minFac: 250, maxFac: 501 },  // M = 7
  { minOp: 751, maxOp: 9012, minFac: 375, maxFac: 751 },  // M = 8
  { minOp: 999, maxOp: 11988, minFac: 499, maxFac: 999 }, // M = 9
];

function genHcfLcm(rng, params = {}) {
  const subtype = params.subtype || 'hcf_2';
  const isLcm = subtype === 'lcm_2' || subtype === 'lcm_3' || params.mode === 'lcm';
  const mLevel = Math.min(9, Math.max(1, Number(params.m_level ?? (params.u_level ? Math.min(9, Math.ceil(params.u_level / 12)) : 1))));

  if (subtype === 'hcf_2' || subtype === 'lcm_2') {
    const table = isLcm ? LCM_LOOKUP : HCF_LOOKUP;
    const entry = table[mLevel] || table[1];

    let a, b;
    if (!isLcm) {
      // Workbook HCF generation rules:
      // U11 = INT(RAND()*(T11+1))+P11 (multiplier in minFac..maxFac)
      // V11 = INT(RAND()*(S11+1))+N11 (operand in minOp..maxOp)
      // W11 = INT(V11/U11), X11 = W11*U11
      // Y11 = U11
      // Z11 = INT(RAND()*(S11+1))+N11
      // AA11 = INT(Z11/Y11), AC11 = AA11*Y11
      // AB11 = IF(AC11=X11, AC11-Y11, AC11)
      const U = rng.int(entry.minFac, entry.maxFac);
      const V = rng.int(entry.minOp, entry.maxOp);
      const W = Math.floor(V / U);
      const X = Math.max(U, W * U);
      const Y = U;
      const Z = rng.int(entry.minOp, entry.maxOp);
      const AA = Math.floor(Z / Y);
      let AC = Math.max(Y, AA * Y);
      let AB = (AC === X) ? AC - Y : AC;
      if (AB <= 0) AB = AC + Y;
      a = BigInt(X);
      b = BigInt(AB);
    } else {
      // Workbook LCM generation rules:
      // U36 = INT(RAND()*(T36+1))+P36
      // V36 = INT(RAND()*(S36+1))+N36, W36 = INT(V36/U36), X36 = W36*U36
      // Y36 = INT(RAND()*(T36+1))+P36 (independent draw!)
      // Z36 = INT(RAND()*(S36+1))+N36, AA36 = INT(Z36/Y36), AB36 = AA36*Y36
      const U = rng.int(entry.minFac, entry.maxFac);
      const V = rng.int(entry.minOp, entry.maxOp);
      const W = Math.floor(V / U);
      const X = Math.max(U, W * U);
      const Y = rng.int(entry.minFac, entry.maxFac);
      const Z = rng.int(entry.minOp, entry.maxOp);
      const AA = Math.floor(Z / Y);
      const AB = Math.max(Y, AA * Y);
      // Workbook LCM: AB36 = AA36*Y36 with NO distinctness check (unlike HCF).
      // Equal operands are preserved when generated by the source formula.
      a = BigInt(X);
      b = BigInt(AB);
    }

    const ans = isLcm ? lcmBigInt(a, b) : gcdBigInt(a, b);
    const opName = isLcm ? 'LCM' : 'HCF';

    return {
      prompt: `${opName}(${a.toString()}, ${b.toString()}) =`,
      input: { type: 'integer', placeholder: `Enter ${opName}`, mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: ans.toString(),
        expected_display: ans.toString(),
        explanation: `${opName} of ${a.toString()} and ${b.toString()} is ${ans.toString()}.`,
      },
    };
  }

  // Fallback for custom or multi-term variants:
  const minGcd = Number(params.min_gcd ?? (params.u_level ? Math.max(2, Math.floor(params.u_level / 2)) : 4));
  const maxGcd = Number(params.max_gcd ?? (params.u_level ? Math.max(minGcd, params.u_level) : 24));
  const baseGcd = BigInt(rng.int(minGcd, maxGcd));
  const coprimeTriples = [
    [2n, 3n, 5n],
    [3n, 4n, 7n],
    [2n, 5n, 7n],
    [3n, 5n, 8n],
    [4n, 7n, 9n],
    [5n, 6n, 11n],
  ];
  const mults = rng.pick(coprimeTriples);

  if (subtype === 'lcm_2') {
    const a = baseGcd * mults[0];
    const b = baseGcd * mults[1];
    const l = lcmBigInt(a, b);
    return {
      prompt: `LCM(${a.toString()}, ${b.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter LCM', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: l.toString(),
        expected_display: l.toString(),
        explanation: `LCM of ${a.toString()} and ${b.toString()} is ${l.toString()}.`,
      },
    };
  }

  if (subtype === 'hcf_3') {
    const a = baseGcd * mults[0];
    const b = baseGcd * mults[1];
    const c = baseGcd * mults[2];
    const g = gcdManyBigInt([a, b, c]);
    return {
      prompt: `HCF(${a.toString()}, ${b.toString()}, ${c.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter HCF', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: g.toString(),
        expected_display: g.toString(),
        explanation: `HCF of ${a.toString()}, ${b.toString()}, ${c.toString()} is ${g.toString()}.`,
      },
    };
  }

  if (subtype === 'lcm_3') {
    const a = baseGcd * mults[0];
    const b = baseGcd * mults[1];
    const c = baseGcd * mults[2];
    const l = lcmManyBigInt([a, b, c]);
    return {
      prompt: `LCM(${a.toString()}, ${b.toString()}, ${c.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter LCM', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: l.toString(),
        expected_display: l.toString(),
        explanation: `LCM of ${a.toString()}, ${b.toString()}, ${c.toString()} is ${l.toString()}.`,
      },
    };
  }

  if (subtype === 'both_hcf_lcm') {
    const a = baseGcd * mults[0];
    const b = baseGcd * mults[1];
    const g = gcdBigInt(a, b);
    const l = lcmBigInt(a, b);
    return {
      prompt: `Find the HCF and LCM of ${a.toString()} and ${b.toString()}:`,
      input: {
        type: 'pair',
        fields: ['HCF', 'LCM'],
        placeholder: 'HCF, LCM',
      },
      answer_key: {
        kind: 'integer_pair',
        values: [g.toString(), l.toString()],
        expected_display: `HCF = ${g.toString()}, LCM = ${l.toString()}`,
        explanation: `For ${a.toString()} and ${b.toString()}, HCF = ${g.toString()} and LCM = ${l.toString()}.`,
      },
    };
  }

  if (subtype === 'hcf_2') {
    const a = baseGcd * mults[0];
    const b = baseGcd * mults[1];
    const g = gcdBigInt(a, b);
    return {
      prompt: `HCF(${a.toString()}, ${b.toString()}) =`,
      input: { type: 'integer', placeholder: 'Enter HCF', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: g.toString(),
        expected_display: g.toString(),
        explanation: `HCF of ${a.toString()} and ${b.toString()} is ${g.toString()}.`,
      },
    };
  }

  throw new Error(`Unsupported hcf_lcm subtype: ${subtype}`);
}

function generateWorkbookMixedFraction(rng, { minWhole, maxWhole, minNum, maxNum, minDen, maxDen }) {
  const whole = BigInt(rng.int(minWhole, maxWhole));
  const rawNum = rng.int(minNum, maxNum);
  const denFloor = Math.max(minDen, rawNum + 1);
  const denCeil = Math.max(maxDen, denFloor);
  const rawDen = rng.int(denFloor, denCeil);
  const g = gcdBigInt(BigInt(rawNum), BigInt(rawDen));
  const num = BigInt(rawNum) / g;
  const den = BigInt(rawDen) / g;
  const rat = makeRational(whole * den + num, den);
  return {
    whole,
    num,
    den,
    rat,
    display: formatMixedFraction(rat),
  };
}

const AK_ADD_LOOKUP = [
  null,
  { minW: 1, maxW: 3, minN: 1, maxN: 2, minD: 2, maxD: 3 }, // S = 1
  { minW: 2, maxW: 5, minN: 1, maxN: 4, minD: 2, maxD: 5 }, // S = 2
  { minW: 3, maxW: 8, minN: 2, maxN: 5, minD: 3, maxD: 6 }, // S = 3
  { minW: 5, maxW: 13, minN: 2, maxN: 7, minD: 3, maxD: 8 }, // S = 4
  { minW: 7, maxW: 20, minN: 3, maxN: 11, minD: 4, maxD: 12 }, // S = 5
  { minW: 10, maxW: 35, minN: 4, maxN: 19, minD: 5, maxD: 20 }, // S >= 6
];

function genFractionAdd(rng, params = {}) {
  const level = Math.min(6, Math.max(1, Number(params.ak_level ?? 3)));
  const bounds = AK_ADD_LOOKUP[level];
  const termsCount = Math.max(2, Number(params.terms ?? 2));
  const operands = Array.from({ length: termsCount }, () =>
    generateWorkbookMixedFraction(rng, {
      minWhole: bounds.minW,
      maxWhole: bounds.maxW,
      minNum: bounds.minN,
      maxNum: bounds.maxN,
      minDen: bounds.minD,
      maxDen: bounds.maxD,
    })
  );

  const res = operands.reduce((acc, f) => addRational(acc, f.rat), makeRational(0n, 1n));
  const expectedStr = formatMixedFraction(res);
  const promptStr = operands.map((f) => f.display).join(' + ') + ' =';

  return {
    prompt: promptStr,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 2 3/4' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${operands.map((f) => f.display).join(' + ')} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

const R_SUB_LOOKUP = [
  null,
  null,
  { minW1: 1, maxW1: 1, minN: 5, maxN: 9, minD: 6, maxD: 10 },    // R = 2 (V=2: 1..1)
  { minW1: 1, maxW1: 2, minN: 7, maxN: 19, minD: 8, maxD: 20 },   // R = 3 (V=3: 1..2)
  { minW1: 1, maxW1: 4, minN: 9, maxN: 29, minD: 10, maxD: 30 },  // R = 4 (V=5: 1..4)
  { minW1: 1, maxW1: 8, minN: 14, maxN: 44, minD: 15, maxD: 45 }, // R = 5 (V=9: 1..8)
  { minW1: 1, maxW1: 19, minN: 19, maxN: 54, minD: 20, maxD: 55 },// R = 6 (V=20: 1..19)
  { minW1: 1, maxW1: 34, minN: 24, maxN: 69, minD: 25, maxD: 70 },// R = 7 (V=35: 1..34)
  { minW1: 1, maxW1: 59, minN: 29, maxN: 84, minD: 30, maxD: 85 },// R = 8 (V=60: 1..59)
  { minW1: 1, maxW1: 99, minN: 34, maxN: 99, minD: 35, maxD: 100 },// R = 9 (V=100: 1..99)
  { minW1: 1, maxW1: 149, minN: 39, maxN: 124, minD: 40, maxD: 125 },// R >= 10 (V=150: 1..149)
];

function genFractionSub(rng, params = {}) {
  const level = Math.min(10, Math.max(2, Number(params.r_level ?? 2)));
  const bounds = R_SUB_LOOKUP[level];

  // Minuend: mixed fraction with whole in [minW1, maxW1]
  const f1 = generateWorkbookMixedFraction(rng, {
    minWhole: bounds.minW1,
    maxWhole: bounds.maxW1,
    minNum: bounds.minN,
    maxNum: bounds.maxN,
    minDen: bounds.minD,
    maxDen: bounds.maxD,
  });

  // Subtrahend: proper fraction (whole is strictly 0 per workbook cell AB13)
  const f2 = generateWorkbookMixedFraction(rng, {
    minWhole: 0,
    maxWhole: 0,
    minNum: bounds.minN,
    maxNum: bounds.maxN,
    minDen: bounds.minD,
    maxDen: bounds.maxD,
  });

  const res = subRational(f1.rat, f2.rat);
  const expectedStr = formatMixedFraction(res);

  return {
    prompt: `${f1.display} − ${f2.display} =`,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 1 2/5' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${f1.display} − ${f2.display} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

const AI_MUL_LOOKUP = [
  null,
  null,
  { minW: 1, maxW: 2, minN: 1, maxN: 2, minD: 2, maxD: 3 }, // AI = 2
  { minW: 1, maxW: 3, minN: 1, maxN: 4, minD: 2, maxD: 5 }, // AI = 3
  { minW: 2, maxW: 5, minN: 4, maxN: 8, minD: 5, maxD: 9 }, // AI = 4
  { minW: 4, maxW: 10, minN: 8, maxN: 11, minD: 9, maxD: 12 }, // AI = 5
  { minW: 8, maxW: 16, minN: 11, maxN: 15, minD: 12, maxD: 16 }, // AI = 6
  { minW: 15, maxW: 28, minN: 15, maxN: 19, minD: 16, maxD: 20 }, // AI = 7
  { minW: 25, maxW: 40, minN: 19, maxN: 24, minD: 20, maxD: 25 }, // AI = 8
  { minW: 35, maxW: 60, minN: 24, maxN: 39, minD: 25, maxD: 40 }, // AI = 9
  { minW: 55, maxW: 80, minN: 39, maxN: 59, minD: 40, maxD: 60 }, // AI = 10
  { minW: 75, maxW: 100, minN: 59, maxN: 79, minD: 60, maxD: 80 }, // AI >= 11
];

function genFractionMul(rng, params = {}) {
  const level = Math.min(11, Math.max(2, Number(params.ai_level ?? 2)));
  const bounds = AI_MUL_LOOKUP[level];
  const termsCount = Math.max(2, Number(params.terms ?? 2));
  const operands = Array.from({ length: termsCount }, () =>
    generateWorkbookMixedFraction(rng, {
      minWhole: bounds.minW,
      maxWhole: bounds.maxW,
      minNum: bounds.minN,
      maxNum: bounds.maxN,
      minDen: bounds.minD,
      maxDen: bounds.maxD,
    })
  );

  const res = operands.reduce((acc, f) => mulRational(acc, f.rat), makeRational(1n, 1n));
  const expectedStr = formatMixedFraction(res);
  const promptStr = operands.map((f) => f.display).join(' × ') + ' =';

  return {
    prompt: promptStr,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 2 1/3' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${operands.map((f) => f.display).join(' × ')} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

const AI_DIV_LOOKUP = [
  null,
  null,
  null,
  { minW: 1, maxW: 2, minN: 1, maxN: 4, minD: 2, maxD: 5 }, // AI = 3
  { minW: 1, maxW: 3, minN: 3, maxN: 6, minD: 4, maxD: 7 }, // AI = 4
  { minW: 2, maxW: 5, minN: 4, maxN: 7, minD: 5, maxD: 8 }, // AI = 5
  { minW: 3, maxW: 9, minN: 7, maxN: 11, minD: 8, maxD: 12 }, // AI = 6
  { minW: 5, maxW: 14, minN: 10, maxN: 17, minD: 11, maxD: 18 }, // AI = 7
  { minW: 10, maxW: 20, minN: 15, maxN: 24, minD: 16, maxD: 25 }, // AI = 8
  { minW: 15, maxW: 30, minN: 24, maxN: 39, minD: 25, maxD: 40 }, // AI = 9
  { minW: 25, maxW: 40, minN: 40, maxN: 59, minD: 41, maxD: 60 }, // AI = 10
  { minW: 35, maxW: 60, minN: 60, maxN: 79, minD: 61, maxD: 80 }, // AI = 11
  { minW: 55, maxW: 75, minN: 80, maxN: 99, minD: 81, maxD: 100 }, // AI >= 12
];

function genFractionDiv(rng, params = {}) {
  const rawLevel = Number(params.ai_level ?? 2);

  // Junior 1 & 2 Intro slots (AI = 2):
  // Workbook rows 13 and 14 contain exact fixed division introductory examples
  if (rawLevel === 2) {
    const slotChoice = params.slot === 2 ? 2 : (params.slot === 1 ? 1 : rng.pick([1, 2]));
    if (slotChoice === 1) {
      // Slot 1: 1 1/3 ÷ 1 5/9 = 6/7
      const f1 = makeRational(4n, 3n);
      const f2 = makeRational(14n, 9n);
      const res = makeRational(6n, 7n);
      const f1Display = '1 1/3';
      const f2Display = '1 5/9';
      const expectedStr = '6/7';
      return {
        prompt: `${f1Display} ÷ ${f2Display} =`,
        input: { type: 'fraction', placeholder: 'e.g. 3/4 or 1 1/2' },
        answer_key: {
          kind: 'simplest_mixed_fraction',
          num: res.num.toString(),
          den: res.den.toString(),
          expected_display: expectedStr,
          explanation: `${f1Display} ÷ ${f2Display} = ${expectedStr} in simplest mixed form.`,
        },
      };
    } else {
      // Slot 2: 1 5/9 ÷ 1 2/3 = 14/15
      const f1 = makeRational(14n, 9n);
      const f2 = makeRational(5n, 3n);
      const res = makeRational(14n, 15n);
      const f1Display = '1 5/9';
      const f2Display = '1 2/3';
      const expectedStr = '14/15';
      return {
        prompt: `${f1Display} ÷ ${f2Display} =`,
        input: { type: 'fraction', placeholder: 'e.g. 3/4 or 1 1/2' },
        answer_key: {
          kind: 'simplest_mixed_fraction',
          num: res.num.toString(),
          den: res.den.toString(),
          expected_display: expectedStr,
          explanation: `${f1Display} ÷ ${f2Display} = ${expectedStr} in simplest mixed form.`,
        },
      };
    }
  }

  const level = Math.min(12, Math.max(3, rawLevel));
  const bounds = AI_DIV_LOOKUP[level];

  // Authentic reverse-multiplication architecture from workbook 12_Fraction_Divisions:
  // Generates Quotient Q and Divisor F2 from the level lookup table.
  // Then Dividend F1 = Q * F2.
  // Division is F1 ÷ F2 = Q.
  const quotient = generateWorkbookMixedFraction(rng, {
    minWhole: bounds.minW,
    maxWhole: bounds.maxW,
    minNum: bounds.minN,
    maxNum: bounds.maxN,
    minDen: bounds.minD,
    maxDen: bounds.maxD,
  });

  const divisor = generateWorkbookMixedFraction(rng, {
    minWhole: bounds.minW,
    maxWhole: bounds.maxW,
    minNum: bounds.minN,
    maxNum: bounds.maxN,
    minDen: bounds.minD,
    maxDen: bounds.maxD,
  });

  const dividendRat = mulRational(quotient.rat, divisor.rat);
  const dividendDisplay = formatMixedFraction(dividendRat);
  const divisorDisplay = divisor.display;
  const expectedStr = quotient.display;

  return {
    prompt: `${dividendDisplay} ÷ ${divisorDisplay} =`,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 1 1/2' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: quotient.rat.num.toString(),
      den: quotient.rat.den.toString(),
      expected_display: expectedStr,
      explanation: `${dividendDisplay} ÷ ${divisorDisplay} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

function formatWorkbookDecimal(intVal, decPlaces) {
  const s = formatScaledUnits(BigInt(intVal), decPlaces, 1);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function formatWorkbook4SigFigs(valFloat) {
  // Workbook cells BR..CI (mul) and CC..CV (div):
  // Scaled by 10^10, BT = INT(LOG(scaled))+1, BU = BT - 4, BV = INT(scaled / 10^BU + 0.5)
  const scaled = valFloat * 10000000000;
  const bt = Math.floor(Math.log10(scaled)) + 1;
  const bu = bt - 4;
  const bv = Math.floor(scaled / Math.pow(10, bu) + 0.5);
  const bw = String(bv);
  let cg;
  if (bu === 7) cg = `${bw.slice(0, 1)}.${bw.slice(1, 4)}`;
  else if (bu === 8) cg = `${bw.slice(0, 2)}.${bw.slice(2, 4)}`;
  else if (bu === 9) cg = `${bw.slice(0, 3)}.${bw.slice(3, 4)}`;
  else if (bu === 10) cg = bw;
  else if (bu < 7) {
    // e.g. 0.xxxx when bu === 6
    const zeros = '0'.repeat(Math.max(0, 6 - bu));
    cg = `0.${zeros}${bw}`;
  } else {
    cg = `${bw}0`;
  }
  const ch = bu < 12 ? '' : '0'.repeat(Math.min(4, bu - 11));
  return `${cg}${ch}`;
}

function genApproximation(rng, params = {}) {
  const subtype = params.subtype || 'sig_figs_product';
  const sigFigs = Number(params.sig_figs ?? (subtype.includes('4') ? 4 : 2));

  if (subtype === 'nearest_int_mul') {
    // Exact workbook cells R8..R18 in 15_Approximations:
    const V = Number(params.strength ?? 3);
    const W = Number(params.shift_w ?? 0);
    const Z = V > 10 ? V - 8 : 2;
    const AA = V === 3 ? 2 : Math.floor(V / 2);
    const AB = rng.int(Z, AA) + 3;
    const AC_prev = V === 3 ? 2 : V - AB;
    const AC = AC_prev === 0 ? 1 : AC_prev;
    const AD = AB > 5 ? 3 : AB > 2 ? 2 : 1;
    const AE = rng.int(0, AD - 1) + 2;
    const AG = rng.int(0, AE - 1) + 1;
    const AH = Math.round((V === 3 ? 39 : 9 * Math.pow(10, AB - 1) - 1) * 10);
    const AI = Math.round(Math.pow(10, AB - 1) + 1);
    const AJ = rng.int(0, Math.max(0, AH - 1)) + AI;
    const AL = Math.round((V === 3 ? 39 : V === 4 ? 49 : 9 * Math.pow(10, AC - 1) - 1) * 1000);
    const AM = Math.ceil(V === 4 ? 51 : Math.pow(10, AC - 1) + 1);
    const AN = rng.int(0, Math.max(0, AL - 1)) + AM;
    const BN = AJ % 10 === 0 ? AJ + rng.int(1, 9) : AJ;
    const BO = AN % 10 === 0 ? AN + rng.int(1, 9) : AN;
    const Y = Math.log10(AN * AJ) - AE - AG;
    const X = Y < 4 ? 0 : Math.floor(Y - 3);
    const shiftAO = AG + X + W;
    const akStr = formatWorkbookDecimal(BN, AE);
    const aoStr = formatWorkbookDecimal(BO, shiftAO);
    const totalDec = AE + shiftAO;
    const denom = 10n ** BigInt(totalDec);
    const prodInt = BigInt(BN) * BigInt(BO);
    const brInt = (prodInt + denom / 2n) / denom;
    const expectedStr = brInt.toString();

    return {
      prompt: `Approximate ${akStr} × ${aoStr} to the nearest integer:`,
      input: { type: 'integer', placeholder: 'Nearest integer', mode: 'numeric' },
      scoring_data: { int_val: expectedStr },
      answer_key: {
        kind: 'exact_integer',
        value: expectedStr,
        expected_display: expectedStr,
        explanation: `${akStr} × ${aoStr} ≈ ${expectedStr} (nearest integer).`,
      },
    };
  }

  if (subtype === 'sig_figs_4_mul') {
    // Exact workbook cells R25..R31 in 15_Approximations:
    const V = Number(params.strength ?? 5);
    const Z = V > 10 ? V - 8 : 2;
    const AA = V === 3 ? 2 : Math.floor(V / 2);
    const AB = rng.int(Z, AA);
    const AC = V === 3 ? 2 : V - AB;
    const AD = AB > 5 ? 3 : AB > 2 ? 2 : 1;
    const AE = rng.int(0, AD - 1) + 4;
    const AG = rng.int(0, AE - 1) + 1;
    const AH = Math.round((V === 3 ? 39 : 9 * Math.pow(10, AB - 1) - 1) * 1000);
    const AI = Math.round(Math.pow(10, AB - 1) + 1);
    const AJ = rng.int(0, Math.max(0, AH - 1)) + AI;
    const AL = Math.round((V === 3 ? 39 : V === 4 ? 49 : 9 * Math.pow(10, AC - 1) - 1) * 1000);
    const AM = Math.ceil(V === 4 ? 51 : Math.pow(10, AC - 1) + 1);
    const AN = rng.int(0, Math.max(0, AL - 1)) + AM;
    const BN = AJ % 10 === 0 ? AJ + rng.int(1, 9) : AJ;
    const BO = AN % 10 === 0 ? AN + rng.int(1, 9) : AN;
    const akStr = formatWorkbookDecimal(BN, AE);
    const aoStr = formatWorkbookDecimal(BO, AG);
    const bqFloat = (BN / Math.pow(10, AE)) * (BO / Math.pow(10, AG));
    const expectedStr = formatWorkbook4SigFigs(bqFloat);

    return {
      prompt: `Approximate ${akStr} × ${aoStr} to 4 significant figures:`,
      input: { type: 'decimal', placeholder: 'To 4 sig figs' },
      answer_key: {
        kind: 'exact_decimal',
        value: expectedStr,
        expected_display: expectedStr,
        explanation: `${akStr} × ${aoStr} ≈ ${expectedStr} (4 s.f.).`,
      },
    };
  }

  if (subtype === 'nearest_int_div') {
    // Exact workbook cells R38..R48 in 15_Approximations:
    const O = Number(params.strength ?? 2);
    const U = O === 2 ? 1 : O > 12 ? 2 * O - 23 : 2;
    const V = Math.floor(O / 1.5);
    const W = rng.int(Math.min(U, V), Math.max(U, V));
    const X = O + 1 - Math.floor(W / 2 + 0.5);
    const Y = X;
    const Z = W;
    const AC = Z > 1 ? rng.int(Math.pow(10, Z - 1), Math.pow(10, Z) - 1) : rng.int(2, 9);
    const AE = rng.int(Math.pow(10, Y - 1), Math.pow(10, Y) - 1);
    const AF = Math.floor(AE / AC + 0.5);
    const AK = Math.floor(Math.log10(AF) + 1);
    const AL = AK > 4 ? AK - 4 : 0;
    const AN = AC * Math.pow(10, AL);
    const AO = AL > 0 ? rng.int(0, Math.pow(10, AL) - 1) : 0;
    const AP = AO + AN;
    const AR = Math.floor(AE / AP + 0.5);
    const expectedStr = String(AR);

    return {
      prompt: `Approximate ${AE} ÷ ${AP} to the nearest integer:`,
      input: { type: 'integer', placeholder: 'Nearest integer', mode: 'numeric' },
      scoring_data: { int_val: expectedStr },
      answer_key: {
        kind: 'exact_integer',
        value: expectedStr,
        expected_display: expectedStr,
        explanation: `${AE} ÷ ${AP} ≈ ${expectedStr} (nearest integer).`,
      },
    };
  }

  if (subtype === 'sig_figs_4_div') {
    // Exact workbook cells R53..R59 in 15_Approximations:
    const S = Number(params.strength ?? 5);
    const AB = Math.max(2, Math.floor(S / 2 - 1), S - 7);
    const AC = Math.min(7, Math.floor(S / 2 + 0.5));
    const AD = rng.int(Math.min(AB, AC), Math.max(AB, AC));
    const AE = S - AD;
    const AF = AD > 4 ? 3 : AD > 2 ? 2 : 1;
    const AG = AE > 4 ? 3 : AE > 2 ? 2 : 1;
    const AH = rng.int(1, AF);
    const AI = rng.int(1, AG);
    const AW = rng.int(Math.pow(10, AD - 1), Math.pow(10, AD) - 1);
    const AX = rng.int(Math.pow(10, AE - 1), Math.pow(10, AE) - 1);
    const AJ = AW % 10 === 0 ? AW + rng.int(1, 9) : AW;
    const AK = AX % 10 === 0 ? AX + rng.int(1, 9) : AX;
    const AL = AJ * AK;
    const minAV = Math.max(10, Math.floor(0.2 * AL));
    const maxAV = Math.max(minAV, AL - 1);
    const AV = rng.int(minAV, maxAV);
    const AN = AH + AI;
    const bxStr = formatWorkbookDecimal(AV, AN);
    const asStr = formatWorkbookDecimal(AJ, AH);
    const cbFloat = Number(bxStr) / Number(asStr);
    const expectedStr = formatWorkbook4SigFigs(cbFloat);

    return {
      prompt: `Approximate ${bxStr} ÷ ${asStr} to 4 significant figures:`,
      input: { type: 'decimal', placeholder: 'To 4 sig figs' },
      answer_key: {
        kind: 'exact_decimal',
        value: expectedStr,
        expected_display: expectedStr,
        explanation: `${bxStr} ÷ ${asStr} ≈ ${expectedStr} (4 s.f.).`,
      },
    };
  }

  if (subtype === 'decimal_quotient') {
    const targetDecimals = Number(params.target_decimals ?? 1);
    const den = BigInt(rng.int(7, 97));
    const num = BigInt(rng.int(200, 9500));
    const highScaled = computeExactRationalScaled(num, den, 12);
    const rounded = roundScaledAtDecimals(highScaled, targetDecimals);
    const expectedStr = formatScaledUnits(rounded.nearestUnits, targetDecimals, rounded.sign);
    return {
      prompt: `Approximate ${num.toString()} ÷ ${den.toString()} to ${targetDecimals} decimal place${targetDecimals === 1 ? '' : 's'}:`,
      input: { type: 'decimal', decimals: targetDecimals, placeholder: `To ${targetDecimals} d.p.` },
      answer_key: {
        kind: 'rounded_decimal',
        scaled_floor: highScaled.scaledFloor.toString(),
        scale: highScaled.scale,
        exact: highScaled.exact,
        sign: highScaled.sign,
        target_decimals: targetDecimals,
        expected_display: expectedStr,
        explanation: `${num.toString()} ÷ ${den.toString()} ≈ ${expectedStr} (${targetDecimals} d.p.).`,
      },
    };
  }

  // Fallback generic multiplication approximation (for standalone unit test helpers)
  const a = randomBigIntByDigits(rng, 3, 4, { nonZeroLast: true });
  const b = randomBigIntByDigits(rng, 3, 3, { nonZeroLast: true });
  const exactProd = a * b;

  const rounded = roundBigIntToSigFigs(exactProd, sigFigs);

  if (params.tolerance_pct !== undefined) {
    const pct = BigInt(Math.max(1, Math.round(Number(params.tolerance_pct))));
    const deltaFull = (exactProd * pct) / 100n;
    const deltaHalf = deltaFull * 2n;
    return {
      prompt: `Estimate ${a.toString()} × ${b.toString()} (within ${pct.toString()}%):`,
      input: { type: 'integer', placeholder: 'Enter integer estimate', mode: 'numeric' },
      answer_key: {
        kind: 'approximation',
        value: exactProd.toString(),
        full_min: (exactProd - deltaFull).toString(),
        full_max: (exactProd + deltaFull).toString(),
        half_min: (exactProd - deltaHalf).toString(),
        half_max: (exactProd + deltaHalf).toString(),
        expected_display: `${exactProd.toString()} (±${pct.toString()}%: ${(exactProd - deltaFull).toString()} to ${(exactProd + deltaFull).toString()})`,
        explanation: `Exact product is ${exactProd.toString()}.`,
      },
    };
  }

  return {
    prompt: `Approximate ${a.toString()} × ${b.toString()} to ${sigFigs} significant figures:`,
    input: { type: 'integer', placeholder: `To ${sigFigs} sig. figs.`, mode: 'numeric' },
    answer_key: {
      kind: 'approximation',
      exact_integer: exactProd.toString(),
      sig_figs: sigFigs,
      value: rounded.nearest.toString(),
      expected_display: rounded.nearest.toString(),
      explanation: `${a.toString()} × ${b.toString()} = ${exactProd.toString()} ≈ ${rounded.nearest.toString()} (${sigFigs} s.f.).`,
    },
  };
}

function genRemainder(rng, params = {}) {
  let dividend;
  let divisor;

  if (params.v_level) {
    const v = Number(params.v_level);
    const range = Array.isArray(params.divisor_digits_range)
      ? params.divisor_digits_range
      : [Math.floor(v / 2) + 1, v === 3 ? 2 : v === 4 ? 3 : v > 15 ? 14 : v - 2];
    const y = rng.int(Math.min(range[0], range[1]), Math.max(range[0], range[1]));
    const z = Math.max(1, v - y);
    dividend = randomBigIntByDigits(rng, y, y);
    divisor = randomBigIntByDigits(rng, z, z);
    if (divisor < 3n) divisor = 3n;
  } else {
    const dividendDigits = Array.isArray(params.dividend_digits) ? params.dividend_digits : [4, 5];
    const divisorMin = Number(params.divisor_min ?? 7);
    const divisorMax = Number(params.divisor_max ?? 97);
    dividend = randomBigIntByDigits(rng, dividendDigits[0], dividendDigits[1]);
    divisor = BigInt(rng.int(divisorMin, divisorMax));
  }
  const rem = dividend % divisor;

  return {
    prompt: `Remainder when ${dividend.toString()} is divided by ${divisor.toString()}:`,
    input: { type: 'integer', placeholder: '0 to divisor − 1', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: rem.toString(),
      expected_display: rem.toString(),
      explanation: `${dividend.toString()} = ${divisor.toString()} × ${(dividend / divisor).toString()} + ${rem.toString()}, so the remainder is ${rem.toString()}.`,
    },
  };
}

function genRatio(rng, params = {}) {
  const subtype = params.subtype || 'proportion_missing_x';

  if (subtype === 'proportion_missing_x') {
    const aMin = params.a_range?.[0] ?? 20;
    const aMax = params.a_range?.[1] ?? 49;
    const r1Min = params.r1_range?.[0] ?? 5;
    const r1Max = params.r1_range?.[1] ?? 20;
    const r2Min = params.r2_range?.[0] ?? 2;
    const r2Max = params.r2_range?.[1] ?? 10;

    const ax = BigInt(rng.int(aMin, aMax));
    const ay = BigInt(rng.int(r1Min, r1Max));
    const az = BigInt(rng.int(r2Min, r2Max));

    const t1 = ax;
    const t2 = ax * ay;
    const t3 = ax * az;
    const t4 = t2 * az;

    const pos = rng.int(1, 4);
    let prompt = '';
    let ans = 0n;
    if (pos === 1) {
      prompt = `Find x: x : ${t2.toString()} = ${t3.toString()} : ${t4.toString()}`;
      ans = t1;
    } else if (pos === 2) {
      prompt = `Find x: ${t1.toString()} : x = ${t3.toString()} : ${t4.toString()}`;
      ans = t2;
    } else if (pos === 3) {
      prompt = `Find x: ${t1.toString()} : ${t2.toString()} = x : ${t4.toString()}`;
      ans = t3;
    } else {
      prompt = `Find x: ${t1.toString()} : ${t2.toString()} = ${t3.toString()} : x`;
      ans = t4;
    }

    return {
      prompt,
      input: { type: 'integer', placeholder: 'Enter x', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: ans.toString(),
        expected_display: ans.toString(),
        explanation: `In the proportion ${t1.toString()} : ${t2.toString()} = ${t3.toString()} : ${t4.toString()}, x = ${ans.toString()}.`,
      },
    };
  }

  const baseA = BigInt(rng.int(params.a_range?.[0] ?? 2, params.a_range?.[1] ?? 15));
  let baseB = BigInt(rng.int(2, 15));
  while (gcdBigInt(baseA, baseB) !== 1n) {
    baseB += 1n;
  }
  const scale = BigInt(rng.int(params.r1_range?.[0] ?? 3, params.r1_range?.[1] ?? 18));

  if (subtype === 'simplify') {
    const rawA = baseA * scale;
    const rawB = baseB * scale;
    return {
      prompt: `Simplify the ratio ${rawA.toString()} : ${rawB.toString()}:`,
      input: { type: 'ratio', fields: 2, placeholder: 'a : b' },
      answer_key: {
        kind: 'ratio',
        terms: [baseA.toString(), baseB.toString()],
        expected_display: `${baseA.toString()} : ${baseB.toString()}`,
        explanation: `Dividing both terms by ${scale.toString()} gives ${baseA.toString()} : ${baseB.toString()}.`,
      },
    };
  }

  if (subtype === 'missing_term') {
    const c = baseA * scale;
    const d = baseB * scale;
    return {
      prompt: `Find ? in the ratio ${baseA.toString()} : ${baseB.toString()} = ${c.toString()} : ?`,
      input: { type: 'integer', placeholder: 'Enter missing term', mode: 'numeric' },
      answer_key: {
        kind: 'ratio',
        value: d.toString(),
        expected_display: d.toString(),
        explanation: `${baseA.toString()} × ${scale.toString()} = ${c.toString()}, so ${baseB.toString()} × ${scale.toString()} = ${d.toString()}.`,
      },
    };
  }

  throw new Error(`Unsupported ratio subtype: ${subtype}`);
}

function genSquareRoot(rng, params = {}) {
  let root;
  let sq;

  if (params.square_digits) {
    const sqDigits = Number(params.square_digits);
    const w = randomBigIntByDigits(rng, sqDigits, sqDigits);
    let x = isqrtBigInt(w).root;
    let s = x * x;
    if (s.toString().length < sqDigits) {
      x += 1n;
      s = x * x;
    }
    root = x;
    sq = s;
  } else {
    const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 3];
    root = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
    sq = root * root;
  }

  return {
    prompt: `√${sq.toString()} =`,
    input: { type: 'integer', placeholder: 'Enter exact integer root', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: root.toString(),
      expected_display: root.toString(),
      explanation: `${root.toString()}² = ${sq.toString()}, so √${sq.toString()} = ${root.toString()}.`,
    },
  };
}

function genInexactSquareRoot(rng, params = {}) {
  const targetDecimals = Number(params.target_decimals ?? 1);
  const minRad = Number(params.min_radicand ?? 50);
  const maxRad = Number(params.max_radicand ?? 9999);
  const n = BigInt(rng.int(minRad, maxRad));

  const highScaled = computeExactSqrtScaled(n, 1n, 12);
  const rounded = roundScaledAtDecimals(highScaled, targetDecimals);
  const expectedStr = formatScaledUnits(rounded.nearestUnits, targetDecimals, 1);

  return {
    prompt: `√${n.toString()} (to ${targetDecimals} decimal place${targetDecimals === 1 ? '' : 's'}) =`,
    input: {
      type: 'decimal',
      decimals: targetDecimals,
      placeholder: `To ${targetDecimals} d.p.`,
    },
    answer_key: {
      kind: 'rounded_decimal',
      radicand: n.toString(),
      scaled_floor: highScaled.scaledFloor.toString(),
      scale: highScaled.scale,
      exact: highScaled.exact,
      sign: 1,
      target_decimals: targetDecimals,
      expected_display: expectedStr,
      explanation: `√${n.toString()} ≈ ${expectedStr} (rounded to ${targetDecimals} d.p.).`,
    },
  };
}

function genNextSquare(rng, params = {}) {
  const subtype = params.subtype || 'next_square_value';
  let n;

  if (params.v_power !== undefined && params.v_power !== null) {
    const v = BigInt(params.v_power);
    const minN = 10n ** v;
    const maxN = 10n ** (v + 1n) - 2n;
    n = rng.bigInt(minN, maxN);
  } else if (params.n_digits) {
    const nDigits = Number(params.n_digits);
    n = randomBigIntByDigits(rng, nDigits, nDigits);
  } else {
    const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 3];
    const baseRoot = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
    const baseSq = baseRoot * baseRoot;
    const nextSqVal = (baseRoot + 1n) * (baseRoot + 1n);
    const span = nextSqVal - baseSq;
    const offset = span > 0n ? rng.bigInt(0n, span - 1n) : 0n;
    n = baseSq + offset;
  }
  const ns = nextSquareBigInt(n, { strictGreater: true });

  if (subtype === 'difference_to_next_square') {
    return {
      prompt: `What must be added to ${n.toString()} to reach the next perfect square?`,
      input: { type: 'integer', placeholder: 'Enter difference', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: ns.diff.toString(),
        expected_display: ns.diff.toString(),
        explanation: `The next perfect square after ${n.toString()} is ${ns.root.toString()}² = ${ns.square.toString()}, and ${ns.square.toString()} − ${n.toString()} = ${ns.diff.toString()}.`,
      },
    };
  }

  if (subtype === 'next_square_value') {
    return {
      prompt: `Next perfect square strictly greater than ${n.toString()}:`,
      input: { type: 'integer', placeholder: 'Enter next square', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: ns.square.toString(),
        expected_display: ns.square.toString(),
        explanation: `The next perfect square strictly greater than ${n.toString()} is ${ns.root.toString()}² = ${ns.square.toString()}.`,
      },
    };
  }

  throw new Error(`Unsupported next_square subtype: ${subtype}`);
}

function genCubeRoot(rng, params = {}) {
  let root;
  let cb;

  if (params.cube_digits) {
    const cbDigits = Number(params.cube_digits);
    const w = randomBigIntByDigits(rng, cbDigits, cbDigits);
    let x = icbrtBigInt(w).root;
    let c = x * x * x;
    if (c.toString().length < cbDigits) {
      x += 1n;
      c = x * x * x;
    }
    root = x;
    cb = c;
  } else {
    const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 2];
    root = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
    cb = root * root * root;
  }

  return {
    prompt: `∛${cb.toString()} =`,
    input: { type: 'integer', placeholder: 'Enter exact integer cube root', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: root.toString(),
      expected_display: root.toString(),
      explanation: `${root.toString()}³ = ${cb.toString()}, so ∛${cb.toString()} = ${root.toString()}.`,
    },
  };
}

function genNextCube(rng, params = {}) {
  const subtype = params.subtype || 'next_cube_value';
  let n;

  if (params.v_power !== undefined && params.v_power !== null) {
    const v = BigInt(params.v_power);
    const minN = 10n ** v;
    const maxN = 10n ** (v + 1n) - 2n;
    n = rng.bigInt(minN, maxN);
  } else if (params.n_digits) {
    const nDigits = Number(params.n_digits);
    n = randomBigIntByDigits(rng, nDigits, nDigits);
  } else {
    const minRoot = Number(params.min_root ?? 5);
    const maxRoot = Number(params.max_root ?? 45);
    const baseRoot = BigInt(rng.int(minRoot, maxRoot));
    const baseCb = baseRoot * baseRoot * baseRoot;
    const nextCbVal = (baseRoot + 1n) * (baseRoot + 1n) * (baseRoot + 1n);
    const span = nextCbVal - baseCb;
    const offset = span > 0n ? rng.bigInt(0n, span - 1n) : 0n;
    n = baseCb + offset;
  }
  const nc = nextCubeBigInt(n, { strictGreater: true });

  if (subtype === 'difference_to_next_cube') {
    return {
      prompt: `What must be added to ${n.toString()} to reach the next perfect cube?`,
      input: { type: 'integer', placeholder: 'Enter difference', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: nc.diff.toString(),
        expected_display: nc.diff.toString(),
        explanation: `The next perfect cube after ${n.toString()} is ${nc.root.toString()}³ = ${nc.cube.toString()}, and ${nc.cube.toString()} − ${n.toString()} = ${nc.diff.toString()}.`,
      },
    };
  }

  if (subtype === 'next_cube_value') {
    return {
      prompt: `Next perfect cube strictly greater than ${n.toString()}:`,
      input: { type: 'integer', placeholder: 'Enter next cube', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: nc.cube.toString(),
        expected_display: nc.cube.toString(),
        explanation: `The next perfect cube strictly greater than ${n.toString()} is ${nc.root.toString()}³ = ${nc.cube.toString()}.`,
      },
    };
  }

  throw new Error(`Unsupported next_cube subtype: ${subtype}`);
}

function genCalendar(rng, params = {}) {
  const subtype = params.subtype || 'weekday';
  const year = rng.int(params.year_min ?? 1600, params.year_max ?? 2099);

  if (subtype === 'year') {
    const startYear = rng.int(params.year_min ?? 1700, params.year_max ?? 2060);
    const windowYears = Number(params.window_years ?? 20);
    const endYear = startYear + windowYears;
    const targetMonth = rng.int(1, 12);
    const maxDay = Math.min(28, daysInMonth(startYear, targetMonth));
    const day = rng.int(1, maxDay);
    const targetDow = rng.int(0, 6);
    const validYears = [];
    for (let y = startYear; y <= endYear; y++) {
      if (dayOfWeekGregorian(y, targetMonth, day) === targetDow) {
        validYears.push(y);
      }
    }
    const expectedDisplay = validYears.join(', ');
    const dateLabel = `${day} ${MONTH_NAMES_EN[targetMonth - 1]}`;
    return {
      prompt: `Fill in a suitable year from ${startYear} - ${endYear} for which ${dateLabel} = ${WEEKDAY_NAMES_EN[targetDow]} (any one valid year):`,
      input: { type: 'text', placeholder: 'e.g. ' + (validYears[0] ?? startYear) },
      answer_key: {
        kind: 'calendar',
        subtype: 'year',
        start_year: startYear,
        end_year: endYear,
        month: targetMonth,
        day,
        weekday_index: targetDow,
        valid_years: validYears,
        expected_display: expectedDisplay,
        explanation: `Between ${startYear} and ${endYear}, ${dateLabel} falls on a ${WEEKDAY_NAMES_EN[targetDow]} in: ${expectedDisplay}.`,
      },
    };
  }

  if (subtype === 'month') {
    // Workbook row 52: AE52 = INT(RAND()*28+1), day is randomly selected from 1..28
    const day = rng.int(1, 28);
    const targetMonth = rng.int(1, 12);
    const targetDow = dayOfWeekGregorian(year, targetMonth, day);
    const validMonths = [];
    for (let m = 1; m <= 12; m++) {
      if (dayOfWeekGregorian(year, m, day) === targetDow) {
        validMonths.push(m);
      }
    }
    const expectedNames = validMonths.map((m) => MONTH_NAMES_EN[m - 1]).join(' / ');
    return {
      prompt: `Fill in an appropriate month: ${day} [ ? ] ${year} = ${WEEKDAY_NAMES_EN[targetDow]}`,
      input: { type: 'text', placeholder: 'e.g. March or Mar' },
      answer_key: {
        kind: 'calendar',
        subtype: 'month',
        year,
        day,
        weekday_index: targetDow,
        valid_months: validMonths,
        expected_display: expectedNames,
        explanation: `In ${year}, ${day} [ ? ] ${year} falls on a ${WEEKDAY_NAMES_EN[targetDow]} in: ${expectedNames}.`,
      },
    };
  }

  if (subtype === 'weekday') {
    const month = rng.int(1, 12);
    const maxDay = daysInMonth(year, month);
    const day = rng.int(1, maxDay);
    const dow = dayOfWeekGregorian(year, month, day);
    const dateLabel = `${day} ${MONTH_NAMES_EN[month - 1]} ${year}`;

    return {
      prompt: `What day of the week is ${dateLabel}?`,
      input: { type: 'text', placeholder: 'e.g. Monday or Mon' },
      answer_key: {
        kind: 'calendar',
        subtype: 'weekday',
        year,
        month,
        day,
        weekday_index: dow,
        expected_display: WEEKDAY_NAMES_EN[dow],
        explanation: `${dateLabel} (${isLeapYear(year) ? 'leap year' : 'common year'}) is a ${WEEKDAY_NAMES_EN[dow]}.`,
      },
    };
  }

  throw new Error(`Unsupported calendar subtype: ${subtype}`);
}

function excelSerialToUtcDate(serial) {
  // Excel 1900 date system: serial 25569 = 1970-01-01 00:00:00 UTC
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(utcMs);
}

function excelHour(serial) {
  return excelSerialToUtcDate(serial).getUTCHours();
}

function excelMonth(serial) {
  return excelSerialToUtcDate(serial).getUTCMonth() + 1;
}

function excelDay(serial) {
  return excelSerialToUtcDate(serial).getUTCDate();
}

function excelYear(serial) {
  return excelSerialToUtcDate(serial).getUTCFullYear();
}

function genElapsedTime(rng, params = {}) {
  const format = params.format || 'hours_minutes';

  if (format === 'seconds') {
    const isJunior1 = params.group === 'junior1' || !params.show_dates || params.min_seconds != null;
    const randFloat = () => (typeof rng?.float === 'function' ? rng.float() : (typeof rng?.next === 'function' ? rng.next() : Math.random()));

    const fmtClockSec = (h, m, s) => {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    };

    // Workbook start date/time generation chain:
    // AD = RAND() * 62683 + 367
    // AE = 86400 * AD, AF = INT(AE + 0.5), AG = AF / 86400
    // AH = HOUR(AG)
    // AI: Junior 1 morning start (hour <= 12): IF(AH > 12, AG - 0.5, AG)
    //     Junior 2 / Senior (hour <= 18):     IF(AH > 18, AG - 0.25, AG)
    // AJ = MONTH(AI), AK = IF(AJ > 6, AI - 90, AI)
    // AL = DAY(AK),   AM = IF(AL > 20, AK - 10, AK)
    const AD = randFloat() * 62683 + 367;
    const AE = 86400 * AD;
    const AF = Math.floor(AE + 0.5);
    const AG = AF / 86400;
    const AH = excelHour(AG);
    const AI = isJunior1 ? (AH > 12 ? AG - 0.5 : AG) : (AH > 18 ? AG - 0.25 : AG);
    const AJ = excelMonth(AI);
    const AK = AJ > 6 ? AI - 90 : AI;
    const AL = excelDay(AK);
    const AM = AL > 20 ? AK - 10 : AK;

    let BK;
    let durationSeconds;

    if (isJunior1) {
      // Junior 1: Same day duration CQ = INT(RAND() * (CP - CO + 1) + CO)
      // Workbook default bounds CO=4000, CP=17999 seconds (never crosses midnight)
      const minSec = params.min_seconds ?? 4000;
      const maxSec = params.max_seconds ?? 17999;
      durationSeconds = rng.int(minSec, maxSec);
      const CR = durationSeconds / 86400;
      BK = AM + CR;
    } else {
      // Junior 2 and Senior: literal dependency chains driven by aa_level
      const aa = Number(params.aa_level ?? 3);
      let BH;
      if (aa === 3) {
        // AO = RAND() * (INT(AM) + 1 - AM) + AM (same day)
        BH = randFloat() * (Math.floor(AM) + 1 - AM) + AM;
      } else if (aa === 4) {
        // AP = RAND() * 7 + 1 + AM (1 to 8 days later)
        BH = randFloat() * 7 + 1 + AM;
      } else if (aa === 6) {
        // Literal aa=6 month-correction chain:
        // AQ = RAND() * 30 + 30 + AM
        // AR = MONTH(AM), AS = MONTH(AQ), AT = AS - AR
        // AU = IF(AT > 1, AQ - 30, AQ)
        // AV = MONTH(AU)
        // AW = IF(AV = AR, AU + 10, AU)
        const AQ = randFloat() * 30 + 30 + AM;
        const AR = excelMonth(AM);
        const AS = excelMonth(AQ);
        const AT = AS - AR;
        const AU = AT > 1 ? AQ - 30 : AQ;
        const AV = excelMonth(AU);
        const AW = AV === AR ? AU + 10 : AU;
        BH = AW;
      } else if (aa === 8) {
        // AZ = RAND() * (300 - 31 * AX) + 70 - AY + AM
        const AX = excelMonth(AM);
        const AY = excelDay(AM);
        BH = randFloat() * (300 - 31 * AX) + 70 - AY + AM;
      } else if (aa === 10) {
        // BA = 31.5 * (AX + 1) + RAND() * 365 + AM
        // BB = YEAR(BA), BC = YEAR(AM), BD = BB - BC
        // BE = BA + 365 * (1 - BD)
        const AX = excelMonth(AM);
        const BA = 31.5 * (AX + 1) + randFloat() * 365 + AM;
        const BB = excelYear(BA);
        const BC = excelYear(AM);
        const BD = BB - BC;
        BH = BA + 365 * (1 - BD);
      } else {
        // aa > 10:
        // BF = 32 * (12 - AX) - AY + 365
        // BG = RAND() * 1826.25 + BF + AM
        const AX = excelMonth(AM);
        const AY = excelDay(AM);
        const BF = 32 * (12 - AX) - AY + 365;
        BH = randFloat() * 1826.25 + BF + AM;
      }

      // Exact rounding to seconds as in BI, BJ, BK, BL, BM, BN:
      const BI = 86400 * BH;
      const BJ = Math.floor(BI + 0.5);
      BK = BJ / 86400;
      const BL = BK - AM;
      const BM = 86400 * BL;
      durationSeconds = Math.max(1, Math.floor(BM + 0.5));
    }

    const startDate = excelSerialToUtcDate(AM);
    const endDate = excelSerialToUtcDate(BK);
    const startStr = fmtClockSec(startDate.getUTCHours(), startDate.getUTCMinutes(), startDate.getUTCSeconds());
    const endStr = fmtClockSec(endDate.getUTCHours(), endDate.getUTCMinutes(), endDate.getUTCSeconds());

    if (isJunior1 || !params.show_dates) {
      return {
        prompt: `Time elapsed from ${startStr} to ${endStr} (in seconds):`,
        input: {
          type: 'integer',
          placeholder: 'Total seconds',
          mode: 'numeric',
        },
        answer_key: {
          kind: 'elapsed_time',
          format: 'seconds',
          total_seconds: durationSeconds,
          expected_display: String(durationSeconds),
          explanation: `From ${startStr} to ${endStr} is ${durationSeconds} seconds.`,
        },
      };
    }

    const startDateStr = `${startDate.getUTCDate()} ${MONTH_NAMES_EN[startDate.getUTCMonth()]} ${startDate.getUTCFullYear()}`;
    const endDateStr = `${endDate.getUTCDate()} ${MONTH_NAMES_EN[endDate.getUTCMonth()]} ${endDate.getUTCFullYear()}`;

    return {
      prompt: `Time elapsed from ${startStr} on ${startDateStr} to ${endStr} on ${endDateStr} (in seconds):`,
      input: {
        type: 'integer',
        placeholder: 'Total seconds',
        mode: 'numeric',
      },
      answer_key: {
        kind: 'elapsed_time',
        format: 'seconds',
        total_seconds: durationSeconds,
        expected_display: String(durationSeconds),
        explanation: `From ${startStr} on ${startDateStr} to ${endStr} on ${endDateStr} is ${durationSeconds} seconds.`,
      },
    };
  }

  const startMinutes = rng.int(0, 20 * 60 + 59);
  const durationMinutes = rng.int(params.min_minutes ?? 35, params.max_minutes ?? 680);
  const endMinutes = (startMinutes + durationMinutes) % (24 * 60);
  const crossesMidnight = startMinutes + durationMinutes >= 24 * 60;

  const fmtClock = (totalM) => {
    const h = String(Math.floor(totalM / 60)).padStart(2, '0');
    const m = String(totalM % 60).padStart(2, '0');
    return `${h}:${m}`;
  };

  const startStr = fmtClock(startMinutes);
  const endStr = fmtClock(endMinutes);
  const h = Math.floor(durationMinutes / 60);
  const m = durationMinutes % 60;
  const expectedDisplay = format === 'minutes' ? `${durationMinutes} min` : `${h}h ${m}m`;

  return {
    prompt: `Time elapsed from ${startStr} to ${endStr}${crossesMidnight ? ' (next day)' : ''}:`,
    input: {
      type: format === 'minutes' ? 'integer' : 'elapsed_time',
      format,
      placeholder: format === 'minutes' ? 'Total minutes' : 'Hours and minutes (e.g. 3:25)',
    },
    answer_key: {
      kind: 'elapsed_time',
      format,
      total_minutes: durationMinutes,
      hours: h,
      minutes: m,
      expected_display: expectedDisplay,
      explanation: `From ${startStr} to ${endStr}${crossesMidnight ? ' (next day)' : ''} is ${h} hours and ${m} minutes (${durationMinutes} minutes).`,
    },
  };
}

function genSumSquares(rng, params = {}) {
  const minCount = Number(params.min_count ?? 2);
  const maxCount = Number(params.max_count ?? 4);
  const count = rng.int(minCount, maxCount);

  let sumSq = 0n;
  let bases = [];
  if (params.min_target && params.max_target) {
    const target = BigInt(rng.int(params.min_target, params.max_target));
    sumSq = target;
    const decomp = findSumOfSquaresDecomposition(Number(sumSq), { minCount, maxCount });
    if (decomp) {
      bases = decomp;
    } else {
      const minBase = 2;
      const maxBase = Math.max(minBase, Math.floor(Math.sqrt(Number(sumSq))));
      for (let i = 0; i < count; i++) {
        const b = BigInt(rng.int(minBase, maxBase));
        bases.push(b);
      }
      sumSq = bases.reduce((acc, b) => acc + b * b, 0n);
    }
  } else {
    const minBase = Number(params.min_base ?? 2);
    const maxBase = Number(params.max_base ?? 35);
    for (let i = 0; i < count; i++) {
      const b = BigInt(rng.int(minBase, maxBase));
      bases.push(b);
      sumSq += b * b;
    }
  }

  bases.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  const decomposition =
    findSumOfSquaresDecomposition(Number(sumSq), { minCount, maxCount }) || bases;
  const displayStr = decomposition.map((b) => `${b.toString()}²`).join(' + ');

  const scoring_data = {
    target: sumSq.toString(),
    bases_count: decomposition.length,
  };

  return {
    prompt: `Express ${sumSq.toString()} as the sum of ${minCount === maxCount ? `${minCount}` : `${minCount} to ${maxCount}`} nonzero positive integer squares:`,
    input: {
      type: 'sum_squares',
      min_count: minCount,
      max_count: maxCount,
      placeholder: 'Enter bases (e.g. 5, 3, 2 or 5^2 + 3^2 + 2^2)',
    },
    scoring_data,
    answer_key: {
      kind: 'sum_of_squares',
      target: sumSq.toString(),
      min_count: minCount,
      max_count: maxCount,
      example_bases: decomposition.map((b) => b.toString()),
      expected_display: displayStr,
      explanation: `${sumSq.toString()} = ${displayStr}. Any ${minCount}–${maxCount} nonzero positive integer bases whose squares sum to ${sumSq.toString()} receive full marks.`,
    },
  };
}

const GENERATOR_DISPATCH = Object.freeze({
  addition: genAddition,
  subtraction: genSubtraction,
  mixed: genMixed,
  multiplication: genMultiplication,
  division: genDivision,
  brackets: genBrackets,
  prime_factors: genPrimeFactors,
  hcf_lcm: genHcfLcm,
  fraction_add: genFractionAdd,
  fraction_sub: genFractionSub,
  fraction_mul: genFractionMul,
  fraction_div: genFractionDiv,
  approximation: genApproximation,
  remainder: genRemainder,
  ratio: genRatio,
  square_root: genSquareRoot,
  inexact_square_root: genInexactSquareRoot,
  next_square: genNextSquare,
  cube_root: genCubeRoot,
  next_cube: genNextCube,
  calendar: genCalendar,
  elapsed_time: genElapsedTime,
  sum_squares: genSumSquares,
});

/**
 * Generate a single private question from a slot specification.
 *
 * Scoring logic:
 * - If slot is declared with `scoring_mode: 'dynamic'`, computes `max_marks` directly
 *   from the generated operands using registered pure scoring rules in `DYNAMIC_SCORING_RULES`.
 * - Freezes that computed `max_marks` onto the persisted question record.
 * - If slot is fixed, preserves the blueprint slot's `max_marks`.
 */
export function generateQuestionForSlot(categoryKey, slotSpec, rng = null) {
  const activeRng = rng || createCryptoRng();
  if (!JMCWC_CATEGORY_KEYS.includes(categoryKey)) {
    throw new Error(`Invalid JMCWC category_key: ${categoryKey}`);
  }
  const slotNum = Number(slotSpec.slot);
  if (!Number.isInteger(slotNum) || slotNum < 1) {
    throw new Error(`Invalid slot number in ${categoryKey}: ${slotSpec.slot}`);
  }
  const generatorKey = slotSpec.generator || categoryKey;
  const genFn = GENERATOR_DISPATCH[generatorKey] || GENERATOR_DISPATCH[categoryKey];
  if (!genFn) {
    throw new Error(`Unsupported JMCWC generator: ${generatorKey}`);
  }

  const generated = genFn(activeRng, { ...(slotSpec.parameters || {}), slot: slotNum });
  const id = `${categoryKey}_s${slotNum}`;

  let maxMarks = Number(slotSpec.max_marks);
  const isDynamic = slotSpec.parameters?.scoring_mode === 'dynamic';

  if (isDynamic) {
    const ruleKey = slotSpec.parameters?.mark_rule;
    const ruleFn = DYNAMIC_SCORING_RULES[ruleKey];
    if (!ruleFn) {
      throw new Error(`Unrecognized mark_rule '${ruleKey}' in ${categoryKey} slot ${slotNum}`);
    }
    if (!generated.scoring_data) {
      throw new Error(`Generator for ${categoryKey} failed to provide scoring_data`);
    }

    if (ruleKey === 'multiplication_digits_product') {
      maxMarks = ruleFn(generated.scoring_data.factors);
    } else if (ruleKey === 'prime_factors_target_scale') {
      maxMarks = ruleFn(generated.scoring_data.target);
    } else if (ruleKey === 'approximation_product_digits') {
      maxMarks = ruleFn(generated.scoring_data.int_val);
    } else if (ruleKey === 'sum_squares_j1_decomposition') {
      maxMarks = ruleFn(generated.scoring_data.target, generated.scoring_data.bases_count);
    } else if (ruleKey === 'sum_squares_j2_target' || ruleKey === 'sum_squares_sr_target') {
      maxMarks = ruleFn(generated.scoring_data.target);
    }

    // Verify computed mark is a positive integer strictly within declared mark_range
    if (!Array.isArray(slotSpec.parameters?.mark_range) || slotSpec.parameters.mark_range.length !== 2) {
      throw new Error(`Dynamic slot ${slotNum} in ${categoryKey} missing mark_range`);
    }
    const [minM, maxM] = slotSpec.parameters.mark_range;
    if (maxMarks < minM || maxMarks > maxM) {
      throw new Error(
        `Generated dynamic mark ${maxMarks} outside declared mark_range [${minM}, ${maxM}] for ${categoryKey} slot ${slotNum}`
      );
    }
  }

  if (!Number.isInteger(maxMarks) || maxMarks <= 0) {
    throw new Error(`Invalid max_marks in ${categoryKey} slot ${slotNum}: ${maxMarks}`);
  }

  return {
    id,
    category_key: categoryKey,
    slot: slotNum,
    max_marks: maxMarks,
    prompt: generated.prompt,
    input: generated.input,
    answer_key: generated.answer_key,
  };
}

/**
 * Generate questions from a versioned paper blueprint (`spec.sections`).
 *
 * @param {object} paperSpec - `{ sections: [{ key, questions: [{ slot, max_marks, generator, parameters }] }] }`
 * @param {object} options
 * @param {'flat'|'category'} [options.mode='flat']
 * @param {string|null} [options.categoryKey=null]
 * @param {string|number|null} [options.seed=null] - Optional deterministic seed (for server tests only)
 * @returns {{ privateQuestions: Array<object>, publicQuestions: Array<object>, total_max_marks: number }}
 */
export function generateQuestionsFromBlueprint(
  paperSpec,
  { mode = 'flat', categoryKey = null, seed = null } = {}
) {
  if (!paperSpec || !Array.isArray(paperSpec.sections)) {
    throw new Error('Invalid paper blueprint spec: missing sections array');
  }
  const rng = seed !== null && seed !== undefined ? createSeededRng(seed) : createCryptoRng();

  let targetSections = paperSpec.sections;
  if (mode === 'category') {
    if (!categoryKey || !JMCWC_CATEGORY_KEYS.includes(categoryKey)) {
      throw new Error(`Valid categoryKey is required when mode is 'category'`);
    }
    targetSections = paperSpec.sections.filter((sec) => sec.key === categoryKey);
    if (targetSections.length === 0) {
      throw new Error(`Blueprint does not contain section '${categoryKey}'`);
    }
  }

  const seenIds = new Set();
  const privateQuestions = [];

  for (const section of targetSections) {
    if (!JMCWC_CATEGORY_KEYS.includes(section.key)) {
      throw new Error(`Unknown category key in blueprint section: ${section.key}`);
    }
    if (!Array.isArray(section.questions) || section.questions.length === 0) {
      throw new Error(`Blueprint section '${section.key}' has no question slots`);
    }
    for (const slotSpec of section.questions) {
      const q = generateQuestionForSlot(section.key, slotSpec, rng);
      if (seenIds.has(q.id)) {
        throw new Error(`Duplicate question id generated: ${q.id}`);
      }
      seenIds.add(q.id);
      privateQuestions.push(q);
    }
  }

  const totalMaxMarks = privateQuestions.reduce((acc, q) => acc + q.max_marks, 0);

  return {
    privateQuestions,
    publicQuestions: toPublicQuestions(privateQuestions),
    total_max_marks: totalMaxMarks,
  };
}
