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
  const termsCount = Number(params.terms ?? 2);
  const digitsList = Array.isArray(params.digits)
    ? params.digits
    : Array.from({ length: termsCount }, () => Number(params.digits ?? 3));

  const terms = digitsList.map((d) => {
    if (Array.isArray(d)) return randomBigIntByDigits(rng, d[0], d[1]);
    return randomBigIntByDigits(rng, Number(d), Number(d));
  });
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
  const d2 = Array.isArray(params.subtrahend_digits)
    ? params.subtrahend_digits
    : [Number(params.subtrahend_digits ?? params.digits ?? 4), Number(params.subtrahend_digits ?? params.digits ?? 4)];

  let a = randomBigIntByDigits(rng, d1[0], d1[1]);
  let b = randomBigIntByDigits(rng, d2[0], d2[1]);
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

function genMixed(rng, params = {}) {
  const termsCount = Math.max(3, Number(params.terms ?? 4));
  const digits = Array.isArray(params.digits) ? params.digits : [3, 4];
  const terms = [];
  const ops = [];
  let running = randomBigIntByDigits(rng, digits[0], digits[1]);
  terms.push(running);

  for (let i = 1; i < termsCount; i++) {
    const t = randomBigIntByDigits(rng, digits[0], digits[1]);
    const op = i % 2 === 1 ? '-' : '+';
    ops.push(op);
    terms.push(t);
    running = op === '+' ? running + t : running - t;
  }

  if (!params.allow_negative && running < 0n) {
    const boost = absBigInt(running) + randomBigIntByDigits(rng, digits[0], digits[1]);
    terms[0] += boost;
    running += boost;
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
  const factorDigits = Array.isArray(params.factor_digits) ? params.factor_digits : [2, 2];
  const factors = factorDigits.map((d) => {
    if (Array.isArray(d)) return randomBigIntByDigits(rng, d[0], d[1], { nonZeroLast: true });
    return randomBigIntByDigits(rng, Number(d), Number(d), { nonZeroLast: true });
  });
  const prod = factors.reduce((acc, v) => acc * v, 1n);

  if (subtype === 'missing_digit') {
    const masked = maskSingleDigit(rng, prod, { avoidLeading: true });
    return {
      prompt: `Find the missing digit (?): ${factors.map((f) => f.toString()).join(' × ')} = ${masked.maskedStr}`,
      input: { type: 'text', placeholder: 'Missing digit (or full number)', mode: 'numeric' },
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
  const divisorDigits = Array.isArray(params.divisor_digits)
    ? params.divisor_digits
    : [Number(params.divisor_digits ?? 2), Number(params.divisor_digits ?? 2)];
  const quotientDigits = Array.isArray(params.quotient_digits)
    ? params.quotient_digits
    : [Number(params.quotient_digits ?? 2), Number(params.quotient_digits ?? 3)];

  let divisor = randomBigIntByDigits(rng, divisorDigits[0], divisorDigits[1], { nonZeroLast: true });
  if (divisor < 2n) divisor = 2n;
  const quotient = randomBigIntByDigits(rng, quotientDigits[0], quotientDigits[1], { nonZeroLast: true });
  const dividend = divisor * quotient;

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

  // Default: (a + b) × (c - d)
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

function genPrimeFactors(rng, params = {}) {
  const primesPool = Array.isArray(params.primes_pool)
    ? params.primes_pool.map((p) => BigInt(p))
    : [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];
  const minFactors = Number(params.min_factors ?? 3);
  const maxFactors = Number(params.max_factors ?? 5);
  const count = rng.int(minFactors, maxFactors);

  let target = 1n;
  for (let i = 0; i < count; i++) {
    target *= rng.pick(primesPool);
  }
  if (target < 12n) target *= 6n;

  const factors = factorizeBigInt(target);
  const formatted = formatPrimeFactorization(factors);

  return {
    prompt: `Prime factorisation of ${target.toString()}:`,
    input: {
      type: 'text',
      placeholder: 'e.g. 2^2 × 3 × 5 or 2 × 2 × 3 × 5',
      mode: 'text',
    },
    answer_key: {
      kind: 'prime_factorization',
      target: target.toString(),
      factors: factors.map((f) => ({ prime: f.prime.toString(), exp: f.exp })),
      expected_display: formatted,
      explanation: `${target.toString()} = ${formatted}.`,
    },
  };
}

function genHcfLcm(rng, params = {}) {
  const subtype = params.subtype || 'hcf_2';
  const baseGcd = BigInt(rng.int(params.min_gcd ?? 4, params.max_gcd ?? 24));
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

  // Default: hcf_2
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

function randomProperFraction(rng, minDen = 2, maxDen = 15, { mixedMaxWhole = 0 } = {}) {
  const den = BigInt(rng.int(minDen, maxDen));
  const coprimeNums = [];
  for (let n = 1n; n < den; n++) {
    if (gcdBigInt(n, den) === 1n) coprimeNums.push(n);
  }
  const remNum = rng.pick(coprimeNums);
  const whole = mixedMaxWhole > 0 ? BigInt(rng.int(1, mixedMaxWhole)) : 0n;
  const rat = makeRational(whole * den + remNum, den);
  return {
    rat,
    display: formatMixedFraction(rat),
  };
}

function genFractionAdd(rng, params = {}) {
  const mixedMaxWhole = Number(params.max_whole ?? 4);
  const f1 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });
  const f2 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });
  const res = addRational(f1.rat, f2.rat);
  const expectedStr = formatMixedFraction(res);

  return {
    prompt: `${f1.display} + ${f2.display} =`,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 2 3/4' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${f1.display} + ${f2.display} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

function genFractionSub(rng, params = {}) {
  const mixedMaxWhole = Number(params.max_whole ?? 5);
  let f1 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });
  let f2 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });

  if (!params.allow_negative && f1.rat.num * f2.rat.den < f2.rat.num * f1.rat.den) {
    const tmp = f1;
    f1 = f2;
    f2 = tmp;
  }
  if (f1.rat.num * f2.rat.den === f2.rat.num * f1.rat.den) {
    f1 = {
      rat: addRational(f1.rat, makeRational(1n, 2n)),
      display: formatMixedFraction(addRational(f1.rat, makeRational(1n, 2n))),
    };
  }
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

function genFractionMul(rng, params = {}) {
  const mixedMaxWhole = Number(params.max_whole ?? 3);
  const f1 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 14, { mixedMaxWhole });
  const f2 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 14, { mixedMaxWhole });
  const res = mulRational(f1.rat, f2.rat);
  const expectedStr = formatMixedFraction(res);

  return {
    prompt: `${f1.display} × ${f2.display} =`,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 2 1/3' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${f1.display} × ${f2.display} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

function genFractionDiv(rng, params = {}) {
  const mixedMaxWhole = Number(params.max_whole ?? 3);
  const f1 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });
  const f2 = randomProperFraction(rng, params.min_den ?? 2, params.max_den ?? 12, { mixedMaxWhole });
  const res = divRational(f1.rat, f2.rat);
  const expectedStr = formatMixedFraction(res);

  return {
    prompt: `${f1.display} ÷ ${f2.display} =`,
    input: { type: 'fraction', placeholder: 'e.g. 3/4 or 1 1/2' },
    answer_key: {
      kind: 'simplest_mixed_fraction',
      num: res.num.toString(),
      den: res.den.toString(),
      expected_display: expectedStr,
      explanation: `${f1.display} ÷ ${f2.display} = ${expectedStr} in simplest mixed form.`,
    },
  };
}

function genApproximation(rng, params = {}) {
  const subtype = params.subtype || 'sig_figs_product';
  const sigFigs = Number(params.sig_figs ?? (subtype.includes('4') ? 4 : 2));

  if (subtype === 'nearest_int_div' || subtype === 'sig_figs_4_div') {
    const den = BigInt(rng.int(7, 97));
    const num = BigInt(rng.int(200, 9500));
    const highScaled = computeExactRationalScaled(num, den, 12);
    if (subtype === 'nearest_int_div') {
      const rounded = roundScaledAtDecimals(highScaled, 0);
      const expectedStr = rounded.nearestUnits.toString();
      return {
        prompt: `Approximate ${num.toString()} ÷ ${den.toString()} to the nearest integer:`,
        input: { type: 'integer', placeholder: 'Nearest integer', mode: 'numeric' },
        answer_key: {
          kind: 'exact_integer',
          value: expectedStr,
          expected_display: expectedStr,
          explanation: `${num.toString()} ÷ ${den.toString()} ≈ ${expectedStr} (nearest integer).`,
        },
      };
    } else {
      const quotientFloat = Number(num) / Number(den);
      const rounded = Number(quotientFloat.toPrecision(4));
      const expectedStr = String(rounded);
      return {
        prompt: `Approximate ${num.toString()} ÷ ${den.toString()} to 4 significant figures:`,
        input: { type: 'decimal', placeholder: 'To 4 sig figs' },
        answer_key: {
          kind: 'exact_decimal',
          value: expectedStr,
          expected_display: expectedStr,
          explanation: `${num.toString()} ÷ ${den.toString()} ≈ ${expectedStr} (4 s.f.).`,
        },
      };
    }
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

  // Multiplication approximations
  const a = randomBigIntByDigits(rng, 3, 4, { nonZeroLast: true });
  const b = randomBigIntByDigits(rng, 3, 3, { nonZeroLast: true });
  const exactProd = a * b;

  if (subtype === 'nearest_int_mul') {
    return {
      prompt: `Approximate ${a.toString()} × ${b.toString()} to the nearest integer:`,
      input: { type: 'integer', placeholder: 'Nearest integer', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: exactProd.toString(),
        expected_display: exactProd.toString(),
        explanation: `Exact product is ${exactProd.toString()}.`,
      },
    };
  }

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
  const dividendDigits = Array.isArray(params.dividend_digits) ? params.dividend_digits : [4, 5];
  const divisorMin = Number(params.divisor_min ?? 7);
  const divisorMax = Number(params.divisor_max ?? 97);
  const dividend = randomBigIntByDigits(rng, dividendDigits[0], dividendDigits[1]);
  const divisor = BigInt(rng.int(divisorMin, divisorMax));
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
  const subtype = params.subtype || 'missing_term';
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

  if (subtype === 'proportion_missing_x') {
    const a = baseA;
    const b = baseB;
    const c = a * scale;
    const d = b * scale;
    const pos = rng.int(1, 4);
    let prompt = '';
    let ans = 0n;
    if (pos === 1) {
      prompt = `Find x: x : ${b.toString()} = ${c.toString()} : ${d.toString()}`;
      ans = a;
    } else if (pos === 2) {
      prompt = `Find x: ${a.toString()} : x = ${c.toString()} : ${d.toString()}`;
      ans = b;
    } else if (pos === 3) {
      prompt = `Find x: ${a.toString()} : ${b.toString()} = x : ${d.toString()}`;
      ans = c;
    } else {
      prompt = `Find x: ${a.toString()} : ${b.toString()} = ${c.toString()} : x`;
      ans = d;
    }
    return {
      prompt,
      input: { type: 'integer', placeholder: 'Enter x', mode: 'numeric' },
      answer_key: {
        kind: 'exact_integer',
        value: ans.toString(),
        expected_display: ans.toString(),
        explanation: `In the proportion ${a.toString()} : ${b.toString()} = ${c.toString()} : ${d.toString()}, x = ${ans.toString()}.`,
      },
    };
  }

  // Default: missing_term in proportion a : b = c : ?
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

function genSquareRoot(rng, params = {}) {
  const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 3];
  const root = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
  const sq = root * root;

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
  let n = BigInt(rng.int(minRad, maxRad));
  while (isqrtBigInt(n).exact) {
    n += 1n;
  }

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
  const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 3];
  const baseRoot = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
  const baseSq = baseRoot * baseRoot;
  const nextSqVal = (baseRoot + 1n) * (baseRoot + 1n);
  const span = nextSqVal - baseSq - 1n;
  const offset = span > 1n ? rng.bigInt(1n, span) : 1n;
  const n = baseSq + offset;
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

  return {
    prompt: `Next perfect square strictly greater than ${n.toString()}:`,
    input: { type: 'integer', placeholder: 'Enter next square', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: ns.square.toString(),
      expected_display: ns.square.toString(),
      explanation: `${baseRoot.toString()}² = ${baseSq.toString()} < ${n.toString()} < ${ns.root.toString()}² = ${ns.square.toString()}.`,
    },
  };
}

function genCubeRoot(rng, params = {}) {
  const rootDigits = Array.isArray(params.root_digits) ? params.root_digits : [2, 2];
  const root = randomBigIntByDigits(rng, rootDigits[0], rootDigits[1]);
  const cb = root * root * root;

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
  const minRoot = Number(params.min_root ?? 5);
  const maxRoot = Number(params.max_root ?? 45);
  const baseRoot = BigInt(rng.int(minRoot, maxRoot));
  const baseCb = baseRoot * baseRoot * baseRoot;
  const nextCbVal = (baseRoot + 1n) * (baseRoot + 1n) * (baseRoot + 1n);
  const span = nextCbVal - baseCb - 1n;
  const offset = span > 1n ? rng.bigInt(1n, span) : 1n;
  const n = baseCb + offset;
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

  return {
    prompt: `Next perfect cube strictly greater than ${n.toString()}:`,
    input: { type: 'integer', placeholder: 'Enter next cube', mode: 'numeric' },
    answer_key: {
      kind: 'exact_integer',
      value: nc.cube.toString(),
      expected_display: nc.cube.toString(),
      explanation: `${baseRoot.toString()}³ = ${baseCb.toString()} < ${n.toString()} < ${nc.root.toString()}³ = ${nc.cube.toString()}.`,
    },
  };
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
      prompt: `Between ${startYear} and ${endYear}, in which year(s) does ${dateLabel} fall on a ${WEEKDAY_NAMES_EN[targetDow]}?`,
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
    const targetMonth = rng.int(1, 12);
    const targetDow = dayOfWeekGregorian(year, targetMonth, 1);
    const validMonths = [];
    for (let m = 1; m <= 12; m++) {
      if (dayOfWeekGregorian(year, m, 1) === targetDow) {
        validMonths.push(m);
      }
    }
    const expectedNames = validMonths.map((m) => MONTH_NAMES_EN[m - 1]).join(' / ');
    return {
      prompt: `Name a month in ${year} that starts on a ${WEEKDAY_NAMES_EN[targetDow]}:`,
      input: { type: 'text', placeholder: 'e.g. March or Mar' },
      answer_key: {
        kind: 'calendar',
        subtype: 'month',
        year,
        weekday_index: targetDow,
        valid_months: validMonths,
        expected_display: expectedNames,
        explanation: `In ${year}, the 1st falls on a ${WEEKDAY_NAMES_EN[targetDow]} in: ${expectedNames}.`,
      },
    };
  }

  // Default: weekday of a Gregorian date
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

function genElapsedTime(rng, params = {}) {
  const format = params.format || 'hours_minutes';

  if (format === 'seconds') {
    const startSec = rng.int(0, 86400 - 1);
    const minSec = params.min_seconds ?? 600;
    const maxSec = params.max_seconds ?? 43200;
    const durationSeconds = rng.int(minSec, maxSec);
    const endSec = (startSec + durationSeconds) % 86400;

    const fmtClockSec = (sec) => {
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return `${h}:${m}:${s}`;
    };

    const startStr = fmtClockSec(startSec);
    const endStr = fmtClockSec(endSec);

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
  const minBase = Number(params.min_base ?? 2);
  const maxBase = Number(params.max_base ?? 35);

  const bases = [];
  let sumSq = 0n;
  for (let i = 0; i < count; i++) {
    const b = BigInt(rng.int(minBase, maxBase));
    bases.push(b);
    sumSq += b * b;
  }
  bases.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  const decomposition =
    findSumOfSquaresDecomposition(Number(sumSq), { minCount, maxCount }) || bases;
  const displayStr = decomposition.map((b) => `${b.toString()}²`).join(' + ');

  return {
    prompt: `Express ${sumSq.toString()} as the sum of ${minCount === maxCount ? `${minCount}` : `${minCount} to ${maxCount}`} nonzero positive integer squares:`,
    input: {
      type: 'sum_squares',
      min_count: minCount,
      max_count: maxCount,
      placeholder: 'Enter bases (e.g. 5, 3, 2 or 5^2 + 3^2 + 2^2)',
    },
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
 */
export function generateQuestionForSlot(categoryKey, slotSpec, rng = createCryptoRng()) {
  if (!JMCWC_CATEGORY_KEYS.includes(categoryKey)) {
    throw new Error(`Invalid JMCWC category_key: ${categoryKey}`);
  }
  const slotNum = Number(slotSpec.slot);
  if (!Number.isInteger(slotNum) || slotNum < 1) {
    throw new Error(`Invalid slot number in ${categoryKey}: ${slotSpec.slot}`);
  }
  const maxMarks = Number(slotSpec.max_marks);
  if (!Number.isFinite(maxMarks) || maxMarks <= 0) {
    throw new Error(`Invalid max_marks in ${categoryKey} slot ${slotNum}: ${slotSpec.max_marks}`);
  }
  const generatorKey = slotSpec.generator || categoryKey;
  const genFn = GENERATOR_DISPATCH[generatorKey] || GENERATOR_DISPATCH[categoryKey];
  if (!genFn) {
    throw new Error(`Unsupported JMCWC generator: ${generatorKey}`);
  }

  const generated = genFn(rng, slotSpec.parameters || {});
  const id = `${categoryKey}_s${slotNum}`;

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
 * @returns {{ privateQuestions: Array<object>, publicQuestions: Array<object> }}
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

  return {
    privateQuestions,
    publicQuestions: toPublicQuestions(privateQuestions),
  };
}
