/**
 * Trendz Tracker — Phase 17a: JMCWC Simulator Exact Arithmetic & Seeded PRNG Engine (api/_jmcwcMath.js)
 *
 * Server-only exact mathematical primitives for JMCWC question generation and grading:
 * - Seeded deterministic PRNG (for reproducible unit tests) and Node crypto RNG (for live sessions).
 * - Exact BigInt integer arithmetic, primality testing, prime factorisation, HCF/LCM,
 *   exact & floor integer square/cube roots, and next-square / next-cube boundary helpers.
 * - Exact Rational arithmetic ({ num: BigInt, den: BigInt }) and simplest mixed fraction formatting/parsing.
 * - Exact scaled BigInt decimal & significant-figure rounding engine (zero IEEE-754 drift)
 *   implementing the JMCWC training rounding policy (full marks, half marks for wrong-way rounding
 *   at requested precision or valid excess precision, zero marks otherwise).
 * - Exact Gregorian calendar arithmetic with leap-year rules and English/German weekday & month aliases.
 */

import crypto from 'node:crypto';

export const JMCWC_CATEGORY_KEYS = Object.freeze([
  'addition',
  'subtraction',
  'mixed',
  'multiplication',
  'division',
  'brackets',
  'prime_factors',
  'hcf_lcm',
  'fraction_add',
  'fraction_sub',
  'fraction_mul',
  'fraction_div',
  'approximation',
  'remainder',
  'ratio',
  'square_root',
  'inexact_square_root',
  'next_square',
  'cube_root',
  'next_cube',
  'calendar',
  'elapsed_time',
  'sum_squares',
]);

export const JMCWC_GROUPS = Object.freeze(['junior1', 'junior2', 'senior']);

/**
 * Create a deterministic PRNG from a numeric or string seed (SplitMix32 + Mulberry32).
 * Never expose the seed or internal state in client payloads.
 */
export function createSeededRng(seedInput = 1) {
  let h = 2166136261 >>> 0;
  const str = String(seedInput);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  let state = (h >>> 0) || 0x6d2b79f5;

  function nextUint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  return {
    /** Random integer in [min, max] inclusive */
    int(min, max) {
      const lo = Math.ceil(Number(min));
      const hi = Math.floor(Number(max));
      if (hi < lo) {
        throw new RangeError(`Invalid RNG range [${min}, ${max}]`);
      }
      if (hi === lo) return lo;
      const span = hi - lo + 1;
      if (span <= 0x100000000) {
        const limit = Math.floor(0x100000000 / span) * span;
        let r = nextUint32();
        while (r >= limit) {
          r = nextUint32();
        }
        return lo + (r % span);
      }
      const u = (nextUint32() * 0x200000 + (nextUint32() >>> 11)) / 0x20000000000000;
      return lo + Math.floor(u * span);
    },
    /** Random BigInt in [min, max] inclusive */
    bigInt(min, max) {
      const lo = BigInt(min);
      const hi = BigInt(max);
      if (hi < lo) {
        throw new RangeError(`Invalid BigInt RNG range [${min}, ${max}]`);
      }
      if (hi === lo) return lo;
      const span = hi - lo + 1n;
      let bits = 0n;
      let temp = span - 1n;
      while (temp > 0n) {
        bits += 1n;
        temp >>= 1n;
      }
      const words = Number((bits + 31n) / 32n);
      const mask = (1n << bits) - 1n;
      while (true) {
        let acc = 0n;
        for (let i = 0; i < words; i++) {
          acc = (acc << 32n) | BigInt(nextUint32());
        }
        const candidate = acc & mask;
        if (candidate < span) {
          return lo + candidate;
        }
      }
    },
    /** Pick one element from a non-empty array */
    pick(arr) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('Cannot pick from an empty array');
      }
      return arr[this.int(0, arr.length - 1)];
    },
    /** Return a shuffled shallow copy of arr */
    shuffle(arr) {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = this.int(0, i);
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
      }
      return copy;
    },
  };
}

/**
 * Create a cryptographically strong RNG for production attempts.
 */
export function createCryptoRng() {
  const seedHex = crypto.randomBytes(16).toString('hex');
  return createSeededRng(seedHex);
}

// ============================================================================
// Exact BigInt Integer Primitives
// ============================================================================

export function absBigInt(n) {
  const b = BigInt(n);
  return b < 0n ? -b : b;
}

export function gcdBigInt(a, b) {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function lcmBigInt(a, b) {
  const x = absBigInt(a);
  const y = absBigInt(b);
  if (x === 0n || y === 0n) return 0n;
  return (x / gcdBigInt(x, y)) * y;
}

export function gcdManyBigInt(values) {
  if (!Array.isArray(values) || values.length === 0) return 0n;
  let g = absBigInt(values[0]);
  for (let i = 1; i < values.length; i++) {
    g = gcdBigInt(g, values[i]);
  }
  return g;
}

export function lcmManyBigInt(values) {
  if (!Array.isArray(values) || values.length === 0) return 0n;
  let l = absBigInt(values[0]);
  for (let i = 1; i < values.length; i++) {
    l = lcmBigInt(l, values[i]);
  }
  return l;
}

/**
 * Exact integer square root for n >= 0n using Newton's method.
 * Returns { root: floor(sqrt(n)), exact: boolean, remainder: n - root^2 }.
 */
export function isqrtBigInt(n) {
  const val = BigInt(n);
  if (val < 0n) {
    throw new RangeError('isqrtBigInt requires a non-negative BigInt');
  }
  if (val < 2n) {
    return { root: val, exact: true, remainder: 0n };
  }
  let x0 = val;
  let x1 = (x0 + val / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + val / x0) >> 1n;
  }
  const sq = x0 * x0;
  return {
    root: x0,
    exact: sq === val,
    remainder: val - sq,
  };
}

/**
 * Exact integer cube root for any BigInt n.
 * Returns { root: floor(cbrt(|n|)) * sign(n), exact: boolean, remainder: n - root^3 }.
 */
export function icbrtBigInt(n) {
  const val = BigInt(n);
  if (val === 0n) {
    return { root: 0n, exact: true, remainder: 0n };
  }
  const sign = val < 0n ? -1n : 1n;
  const absVal = val < 0n ? -val : val;
  let lo = 0n;
  let hi = 1n;
  while (hi * hi * hi <= absVal) {
    lo = hi;
    hi <<= 1n;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) >> 1n;
    const cube = mid * mid * mid;
    if (cube === absVal) {
      lo = mid;
      break;
    } else if (cube < absVal) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const signedRoot = sign * lo;
  const cube = signedRoot * signedRoot * signedRoot;
  return {
    root: signedRoot,
    exact: cube === val,
    remainder: val - cube,
  };
}

/**
 * Next perfect square for a positive integer n.
 * In JMCWC "Next Squares", given N (which is non-square in standard slots, or if square when strict=true),
 * returns the smallest perfect square > N (or >= N if strict=false), plus the nearest perfect square.
 */
export function nextSquareBigInt(n, { strictGreater = true } = {}) {
  const val = BigInt(n);
  if (val <= 0n) {
    return { root: 1n, square: 1n, diff: 1n - val };
  }
  const { root, exact } = isqrtBigInt(val);
  if (exact && !strictGreater) {
    return { root, square: val, diff: 0n };
  }
  const nextRoot = root + 1n;
  const nextSq = nextRoot * nextRoot;
  return { root: nextRoot, square: nextSq, diff: nextSq - val };
}

/**
 * Nearest perfect square to a positive integer n (used when a subtype asks for closest square).
 */
export function nearestSquareBigInt(n) {
  const val = BigInt(n);
  if (val <= 1n) {
    return { root: 1n, square: 1n };
  }
  const { root, exact } = isqrtBigInt(val);
  if (exact) return { root, square: val };
  const loSq = root * root;
  const hiRoot = root + 1n;
  const hiSq = hiRoot * hiRoot;
  if (val - loSq <= hiSq - val) {
    return { root, square: loSq };
  }
  return { root: hiRoot, square: hiSq };
}

/**
 * Next perfect cube for a positive integer n.
 */
export function nextCubeBigInt(n, { strictGreater = true } = {}) {
  const val = BigInt(n);
  if (val <= 0n) {
    return { root: 1n, cube: 1n, diff: 1n - val };
  }
  const { root, exact } = icbrtBigInt(val);
  if (exact && !strictGreater) {
    return { root, cube: val, diff: 0n };
  }
  const nextRoot = root + 1n;
  const nextCb = nextRoot * nextRoot * nextRoot;
  return { root: nextRoot, cube: nextCb, diff: nextCb - val };
}

/**
 * Deterministic Miller-Rabin + trial division primality check for BigInt.
 */
export function isPrimeBigInt(n) {
  const val = BigInt(n);
  if (val < 2n) return false;
  const smallPrimes = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const p of smallPrimes) {
    if (val === p) return true;
    if (val % p === 0n) return false;
  }
  if (val < 41n * 41n) return true;

  let d = val - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1n;
  }

  function modPow(base, exp, mod) {
    let result = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
    }
    return result;
  }

  for (const a of smallPrimes) {
    if (a >= val) continue;
    let x = modPow(a, d, val);
    if (x === 1n || x === val - 1n) continue;
    let composite = true;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % val;
      if (x === val - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

/**
 * Exact prime factorisation of n >= 2n.
 * Returns array of { prime: BigInt, exp: number } sorted ascending by prime.
 */
export function factorizeBigInt(n) {
  let rem = BigInt(n);
  if (rem < 2n) {
    throw new RangeError('factorizeBigInt requires an integer >= 2');
  }
  const factors = [];
  let count2 = 0;
  while ((rem & 1n) === 0n) {
    rem >>= 1n;
    count2++;
  }
  if (count2 > 0) {
    factors.push({ prime: 2n, exp: count2 });
  }
  let count3 = 0;
  while (rem % 3n === 0n) {
    rem /= 3n;
    count3++;
  }
  if (count3 > 0) {
    factors.push({ prime: 3n, exp: count3 });
  }
  let d = 5n;
  while (d * d <= rem) {
    if (rem % d === 0n) {
      let c = 0;
      while (rem % d === 0n) {
        rem /= d;
        c++;
      }
      factors.push({ prime: d, exp: c });
    }
    const d2 = d + 2n;
    if (rem % d2 === 0n) {
      let c = 0;
      while (rem % d2 === 0n) {
        rem /= d2;
        c++;
      }
      factors.push({ prime: d2, exp: c });
    }
    d += 6n;
  }
  if (rem > 1n) {
    factors.push({ prime: rem, exp: 1 });
  }
  return factors;
}

/**
 * Format a prime factorisation cleanly, e.g. "2^3 × 3 × 5^2" or expanded "2 × 2 × 2 × 3 × 5 × 5".
 */
export function formatPrimeFactorization(factors, { expanded = false } = {}) {
  if (!Array.isArray(factors) || factors.length === 0) return '';
  if (expanded) {
    const parts = [];
    for (const { prime, exp } of factors) {
      for (let i = 0; i < exp; i++) {
        parts.push(prime.toString());
      }
    }
    return parts.join(' × ');
  }
  return factors
    .map(({ prime, exp }) => (exp > 1 ? `${prime.toString()}^${exp}` : prime.toString()))
    .join(' × ');
}

// ============================================================================
// Exact Rational Arithmetic & Mixed Fraction Formatting
// ============================================================================

/**
 * Create a reduced Rational { num: BigInt, den: BigInt } with den > 0n.
 */
export function makeRational(num, den = 1n) {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) {
    throw new RangeError('Rational denominator cannot be zero');
  }
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcdBigInt(n, d);
  return {
    num: n / g,
    den: d / g,
  };
}

export function addRational(a, b) {
  return makeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subRational(a, b) {
  return makeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mulRational(a, b) {
  return makeRational(a.num * b.num, a.den * b.den);
}

export function divRational(a, b) {
  if (BigInt(b.num) === 0n) {
    throw new RangeError('Division by zero rational');
  }
  return makeRational(a.num * b.den, a.den * b.num);
}

/**
 * Convert a reduced rational to canonical simplest mixed-fraction components:
 * { sign: 1 | -1 | 0, whole: BigInt, remNum: BigInt, den: BigInt }
 * where whole >= 0n, 0n <= remNum < den, gcd(remNum, den) = 1.
 */
export function toMixedFraction(rat) {
  const r = makeRational(rat.num, rat.den);
  if (r.num === 0n) {
    return { sign: 0, whole: 0n, remNum: 0n, den: 1n };
  }
  const sign = r.num < 0n ? -1 : 1;
  const absNum = r.num < 0n ? -r.num : r.num;
  const whole = absNum / r.den;
  const remNum = absNum % r.den;
  return {
    sign,
    whole,
    remNum,
    den: r.den,
  };
}

/**
 * Format a rational as a canonical simplest mixed fraction string:
 * - Integer: "5", "-3", "0"
 * - Proper fraction: "3/4", "-2/5"
 * - Mixed number: "2 3/4", "-1 2/5"
 */
export function formatMixedFraction(rat) {
  const m = toMixedFraction(rat);
  if (m.sign === 0) return '0';
  const prefix = m.sign < 0 ? '-' : '';
  if (m.remNum === 0n) {
    return `${prefix}${m.whole.toString()}`;
  }
  if (m.whole === 0n) {
    return `${prefix}${m.remNum.toString()}/${m.den.toString()}`;
  }
  return `${prefix}${m.whole.toString()} ${m.remNum.toString()}/${m.den.toString()}`;
}

/**
 * Parse a student's fraction input and inspect whether it is:
 * - valid syntax
 * - mathematically equal to a rational value
 * - strictly in simplest mixed form (proper fractional part 0 < rem < den and gcd(rem, den) === 1,
 *   and if whole != 0 then rem != 0).
 */
export function parseStudentFraction(rawInput) {
  if (typeof rawInput !== 'string') return { ok: false, reason: 'invalid_type' };
  const cleaned = rawInput
    .trim()
    .replace(/[−–—]/g, '-')
    .replace(/⁄/g, '/')
    .replace(/\s+/g, ' ');
  if (!cleaned) return { ok: false, reason: 'empty' };

  // Case 1: Pure integer e.g. "12" or "-7"
  const intMatch = cleaned.match(/^([+-]?\d+)$/);
  if (intMatch) {
    const val = BigInt(intMatch[1]);
    return {
      ok: true,
      rational: makeRational(val, 1n),
      isSimplestMixed: true,
      isReduced: true,
      isProperOrMixed: true,
      rawParts: { kind: 'integer', whole: val },
    };
  }

  // Case 2: Mixed fraction e.g. "2 3/4", "-2 3/4", or "2_3/4"
  const mixedMatch = cleaned.match(/^([+-]?\d+)(?:\s+|_)(\d+)\s*\/\s*(\d+)$/);
  if (mixedMatch) {
    const wholeStr = mixedMatch[1];
    const isNeg = wholeStr.startsWith('-');
    const absWhole = absBigInt(BigInt(wholeStr));
    const num = BigInt(mixedMatch[2]);
    const den = BigInt(mixedMatch[3]);
    if (den === 0n) return { ok: false, reason: 'zero_denominator' };
    const isReduced = gcdBigInt(num, den) === 1n && num > 0n;
    const isProperPart = num > 0n && num < den;
    const isSimplestMixed = absWhole > 0n && isReduced && isProperPart;
    const totalAbsNum = absWhole * den + num;
    const signedNum = isNeg ? -totalAbsNum : totalAbsNum;
    return {
      ok: true,
      rational: makeRational(signedNum, den),
      isSimplestMixed,
      isReduced,
      isProperOrMixed: isProperPart && absWhole > 0n,
      rawParts: { kind: 'mixed', isNeg, absWhole, num, den },
    };
  }

  // Case 3: Simple fraction e.g. "3/4", "-7/4", "6/8"
  const fracMatch = cleaned.match(/^([+-]?\d+)\s*\/\s*(\d+)$/);
  if (fracMatch) {
    const num = BigInt(fracMatch[1]);
    const den = BigInt(fracMatch[2]);
    if (den === 0n) return { ok: false, reason: 'zero_denominator' };
    const absNum = absBigInt(num);
    const isReduced = absNum > 0n && gcdBigInt(absNum, den) === 1n && den > 1n;
    const isProper = absNum > 0n && absNum < den;
    const isSimplestMixed = isReduced && isProper;
    return {
      ok: true,
      rational: makeRational(num, den),
      isSimplestMixed,
      isReduced,
      isProperOrMixed: isProper,
      rawParts: { kind: 'fraction', num, den },
    };
  }

  return { ok: false, reason: 'invalid_format' };
}

// ============================================================================
// Exact Scaled Decimal & Significant-Figure Rounding Engine
// ============================================================================

export function pow10BigInt(exp) {
  const e = Number(exp);
  if (e < 0) throw new RangeError('pow10BigInt exponent must be >= 0');
  return 10n ** BigInt(e);
}

/**
 * Compute exact scaled square root of a positive integer or decimal radicand.
 * Given an integer radicand N (or { num, den }) and guardScale (e.g. 12 decimal places),
 * returns an exact high-precision scaled representation:
 * { scaledFloor: BigInt, scale: number, exact: boolean }
 * where scaledFloor = floor(trueValue * 10^scale).
 */
export function computeExactSqrtScaled(radicandNum, radicandDen = 1n, scale = 12) {
  const num = BigInt(radicandNum);
  const den = BigInt(radicandDen);
  if (num < 0n || den <= 0n) {
    throw new RangeError('Radicand must be non-negative');
  }
  const factor = pow10BigInt(2 * scale);
  const scaledNumerator = num * factor;
  const quotient = scaledNumerator / den;
  const remDiv = scaledNumerator % den;
  const { root, exact } = isqrtBigInt(quotient);
  return {
    scaledFloor: root,
    scale,
    exact: exact && remDiv === 0n,
  };
}

/**
 * Compute exact scaled value of a Rational { num, den } at `scale` decimal places.
 * Returns { sign: 1 | -1 | 0, scaledFloor: BigInt, scale: number, exact: boolean }
 * where scaledFloor = floor(|num/den| * 10^scale).
 */
export function computeExactRationalScaled(num, den = 1n, scale = 12) {
  const r = makeRational(num, den);
  if (r.num === 0n) {
    return { sign: 0, scaledFloor: 0n, scale, exact: true };
  }
  const sign = r.num < 0n ? -1 : 1;
  const absNum = absBigInt(r.num);
  const factor = pow10BigInt(scale);
  const prod = absNum * factor;
  const scaledFloor = prod / r.den;
  const rem = prod % r.den;
  return {
    sign,
    scaledFloor,
    scale,
    exact: rem === 0n,
  };
}

/**
 * Given a non-negative high-precision scaled value (scaledFloor at highScale, plus `exact` flag),
 * compute the floor, ceiling, and nearest-half-up rounded integer units at targetDecimals <= highScale - 2.
 */
export function roundScaledAtDecimals(highScaledObj, targetDecimals) {
  const { scaledFloor, scale, exact, sign = 1 } = highScaledObj;
  if (targetDecimals < 0 || targetDecimals > scale - 2) {
    throw new RangeError(`targetDecimals=${targetDecimals} out of bounds for scale=${scale}`);
  }
  const dropDigits = scale - targetDecimals;
  const divisor = pow10BigInt(dropDigits);
  const half = divisor / 2n;

  const qFloor = scaledFloor / divisor;
  const rem = scaledFloor % divisor;
  const isExactAtTarget = exact && rem === 0n;

  const qCeil = isExactAtTarget ? qFloor : qFloor + 1n;
  // Standard half-away-from-zero rounding on the magnitude:
  // If rem > half, round up. If rem === half and not exact below scale, round up; if exact half, round half up.
  const qNearest = rem >= half ? qFloor + 1n : qFloor;
  const qOther = isExactAtTarget ? qNearest : (qNearest === qFloor ? qCeil : qFloor);

  return {
    sign: scaledFloor === 0n && isExactAtTarget ? 0 : sign,
    targetDecimals,
    isExactAtTarget,
    nearestUnits: qNearest,
    otherUnits: qOther,
    floorUnits: qFloor,
    ceilUnits: qCeil,
  };
}

/**
 * Format an unsigned scaled integer `units` with `decimals` decimal places and optional sign.
 */
export function formatScaledUnits(units, decimals, sign = 1) {
  const u = absBigInt(units);
  const prefix = sign < 0 && u > 0n ? '-' : '';
  if (decimals <= 0) {
    return `${prefix}${u.toString()}`;
  }
  const s = u.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  return `${prefix}${intPart}.${fracPart}`;
}

/**
 * Parse a student decimal string into { ok, sign, intStr, fracStr, decimals, unitsBigInt, sigFigs }.
 * Preserves trailing zeros so precision can be inspected accurately!
 * Per JMCWC Rules 2025 Rule 8, small digit-counting marks like `|` or `,` in integer digits are allowed.
 */
export function parseStudentDecimal(rawInput) {
  if (typeof rawInput !== 'string') return { ok: false, reason: 'invalid_type' };
  const cleaned = rawInput
    .trim()
    .replace(/[−–—]/g, '-')
    .replace(/[,|]/g, '');
  if (!cleaned) return { ok: false, reason: 'empty' };

  const match = cleaned.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return { ok: false, reason: 'invalid_decimal' };
  }
  const signChar = match[1];
  const intRaw = match[2];
  const fracRaw = match[3] || '';
  const intStr = intRaw.replace(/^0+(?=\d)/, '');
  const decimals = fracRaw.length;
  const combinedDigits = `${intStr}${fracRaw}`;
  const unitsBigInt = BigInt(combinedDigits);
  const sign = unitsBigInt === 0n ? 0 : (signChar === '-' ? -1 : 1);

  // Count significant figures in the student's written number:
  // Strip leading zeros from combinedDigits; if decimals > 0, trailing zeros after decimal are significant.
  const strippedLeading = combinedDigits.replace(/^0+/, '');
  const sigFigs = strippedLeading.length === 0 ? 1 : strippedLeading.length;

  return {
    ok: true,
    sign,
    intStr,
    fracStr: fracRaw,
    decimals,
    unitsBigInt,
    sigFigs,
    normalizedText: formatScaledUnits(unitsBigInt, decimals, sign),
  };
}

/**
 * Evaluate a student's decimal answer against a high-precision scaled value at `targetDecimals` decimal places.
 *
 * JMCWC Rules 2025 (Rule 10) Rounding Policy:
 * 1. Full marks ('correct'): student provides `targetDecimals` decimal places matching `nearestUnits`.
 * 2. Half marks ('partial'):
 *    - Case A (Incorrect rounding at requested precision): student provides `targetDecimals` decimal places matching
 *      `otherUnits` (the floor/ceiling neighbour at `targetDecimals`), provided the true value is NOT exact at `targetDecimals`.
 *    - Case B (Too precise / extra decimal places that validly round the true value): student provides `d > targetDecimals`
 *      decimal places, and at `d` decimal places the student's value equals the true value rounded to `d` decimal places.
 *      Example from JMCWC Rules 2025 Rule 10: sqrt(567) = 23.8117618... to 1 d.p.:
 *        - "23.8"  -> 'correct' (full marks)
 *        - "23.81" -> 'partial' (only half marks: too precise)
 *        - "23.9"  -> 'partial' (only half marks: incorrect rounding)
 *        - "23.7"  -> 'wrong'   (no marks)
 *        - "23.79" -> 'wrong'   (no marks)
 */
export function evaluateDecimalRounding(rawInput, highScaledObj, targetDecimals) {
  const parsed = parseStudentDecimal(rawInput);
  if (!parsed.ok) {
    return {
      verdict: parsed.reason === 'empty' ? 'skipped' : 'wrong',
      reason: parsed.reason,
      expected: formatScaledUnits(
        roundScaledAtDecimals(highScaledObj, targetDecimals).nearestUnits,
        targetDecimals,
        highScaledObj.sign ?? 1
      ),
    };
  }

  const targetRound = roundScaledAtDecimals(highScaledObj, targetDecimals);
  const expectedStr = formatScaledUnits(targetRound.nearestUnits, targetDecimals, targetRound.sign);

  // Sign mismatch check (unless both are 0)
  const expectedSign = targetRound.nearestUnits === 0n ? 0 : (highScaledObj.sign ?? 1);
  if (parsed.sign !== expectedSign && !(parsed.unitsBigInt === 0n && targetRound.nearestUnits === 0n)) {
    return { verdict: 'wrong', reason: 'sign_mismatch', expected: expectedStr };
  }

  // Same precision as requested (or exact integer match when trailing zeros are omitted on an exact integer/decimal)
  if (parsed.decimals === targetDecimals) {
    if (parsed.unitsBigInt === targetRound.nearestUnits) {
      return { verdict: 'correct', reason: 'exact_rounded_match', expected: expectedStr };
    }
    if (!targetRound.isExactAtTarget && parsed.unitsBigInt === targetRound.otherUnits) {
      return { verdict: 'partial', reason: 'wrong_way_rounding_at_target_precision', expected: expectedStr };
    }
    return { verdict: 'wrong', reason: 'value_mismatch_at_target_precision', expected: expectedStr };
  }

  // Fewer decimal places than requested:
  if (parsed.decimals < targetDecimals) {
    const scaleUp = pow10BigInt(targetDecimals - parsed.decimals);
    const scaledStudentUnits = parsed.unitsBigInt * scaleUp;
    if (scaledStudentUnits === targetRound.nearestUnits) {
      if (targetRound.isExactAtTarget) {
        return { verdict: 'correct', reason: 'exact_value_fewer_decimals', expected: expectedStr };
      }
      return { verdict: 'partial', reason: 'omitted_trailing_zero_precision', expected: expectedStr };
    }
    return { verdict: 'wrong', reason: 'insufficient_precision', expected: expectedStr };
  }

  // Excess precision (parsed.decimals > targetDecimals):
  const maxCheckDecimals = highScaledObj.scale - 2;
  if (parsed.decimals <= maxCheckDecimals) {
    const excessRound = roundScaledAtDecimals(highScaledObj, parsed.decimals);
    if (parsed.unitsBigInt === excessRound.nearestUnits) {
      return { verdict: 'partial', reason: 'excess_precision_valid_rounding', expected: expectedStr };
    }
  }

  return { verdict: 'wrong', reason: 'excess_precision_invalid_value', expected: expectedStr };
}

/**
 * Evaluate significant-figure approximation rounding.
 */
export function roundBigIntToSigFigs(val, sigFigs) {
  const n = absBigInt(val);
  const sign = BigInt(val) < 0n ? -1n : 1n;
  if (n === 0n) {
    return { nearest: 0n, floor: 0n, ceil: 0n, exact: true };
  }
  const str = n.toString();
  if (str.length <= sigFigs) {
    return { nearest: BigInt(val), floor: BigInt(val), ceil: BigInt(val), exact: true };
  }
  const drop = str.length - sigFigs;
  const div = pow10BigInt(drop);
  const half = div / 2n;
  const qFloor = (n / div) * div;
  const rem = n % div;
  const exact = rem === 0n;
  const qCeil = exact ? qFloor : qFloor + div;
  const qNearest = rem >= half ? qFloor + div : qFloor;
  return {
    nearest: sign * qNearest,
    floor: sign < 0n ? -qCeil : qFloor,
    ceil: sign < 0n ? -qFloor : qCeil,
    other: exact ? sign * qNearest : sign * (qNearest === qFloor ? qCeil : qFloor),
    exact,
  };
}

// ============================================================================
// Gregorian Calendar & Weekday / Month Primitives
// ============================================================================

export function isLeapYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return false;
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year, month) {
  const m = Number(month);
  if (m < 1 || m > 12) throw new RangeError(`Invalid month: ${month}`);
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[m - 1];
}

/**
 * Compute Gregorian day of week for (year, month 1..12, day 1..31).
 * Returns 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
 */
export function dayOfWeekGregorian(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new RangeError('Invalid date arguments');
  }
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new RangeError(`Invalid Gregorian date: ${y}-${m}-${d}`);
  }
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yAdj = m < 3 ? y - 1 : y;
  const dow =
    (yAdj +
      Math.floor(yAdj / 4) -
      Math.floor(yAdj / 100) +
      Math.floor(yAdj / 400) +
      t[m - 1] +
      d) %
    7;
  return (dow + 7) % 7;
}

export const WEEKDAY_NAMES_EN = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

export const MONTH_NAMES_EN = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

/**
 * Parse a weekday name in English or German (full name or 3-letter abbreviation per JMCWC Rules 2025 Rule 12).
 * Returns 0..6 (0 = Sunday .. 6 = Saturday) or null if unrecognized.
 */
const WEEKDAY_ALIAS_MAP = new Map([
  // Sunday (0)
  ['sunday', 0],
  ['sun', 0],
  ['sonntag', 0],
  ['son', 0],
  // Monday (1)
  ['monday', 1],
  ['mon', 1],
  ['montag', 1],
  // Tuesday (2)
  ['tuesday', 2],
  ['tue', 2],
  ['dienstag', 2],
  ['die', 2],
  // Wednesday (3)
  ['wednesday', 3],
  ['wed', 3],
  ['mittwoch', 3],
  ['mit', 3],
  // Thursday (4)
  ['thursday', 4],
  ['thu', 4],
  ['donnerstag', 4],
  ['don', 4],
  // Friday (5)
  ['friday', 5],
  ['fri', 5],
  ['freitag', 5],
  ['fre', 5],
  // Saturday (6)
  ['saturday', 6],
  ['sat', 6],
  ['samstag', 6],
  ['sam', 6],
  ['sonnabend', 6],
]);

export function parseWeekdayInput(rawInput) {
  if (typeof rawInput !== 'string') return null;
  const cleaned = rawInput
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!cleaned) return null;
  if (WEEKDAY_ALIAS_MAP.has(cleaned)) {
    return WEEKDAY_ALIAS_MAP.get(cleaned);
  }
  return null;
}

/**
 * Parse a single month name in English or German (full name or 3-letter abbreviation per JMCWC Rules 2025 Rule 12).
 * Returns 1..12 or null if invalid or if multiple months are entered.
 */
const MONTH_ALIAS_MAP = new Map([
  ['january', 1],
  ['jan', 1],
  ['januar', 1],
  ['february', 2],
  ['feb', 2],
  ['februar', 2],
  ['march', 3],
  ['mar', 3],
  ['märz', 3],
  ['maerz', 3],
  ['marz', 3],
  ['mär', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['mai', 5],
  ['june', 6],
  ['jun', 6],
  ['juni', 6],
  ['july', 7],
  ['jul', 7],
  ['juli', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sep', 9],
  ['october', 10],
  ['oct', 10],
  ['oktober', 10],
  ['okt', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
  ['dezember', 12],
  ['dez', 12],
]);

export function parseSingleMonthInput(rawInput) {
  if (typeof rawInput !== 'string') return null;
  const cleaned = rawInput
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!cleaned) return null;
  // Reject multiple months separated by comma, slash, "and", spaces, etc.
  if (MONTH_ALIAS_MAP.has(cleaned)) {
    return MONTH_ALIAS_MAP.get(cleaned);
  }
  return null;
}

// ============================================================================
// Sums of Squares Solver (2 to 4 nonzero positive integer squares)
// ============================================================================

/**
 * Find a canonical representation of a positive integer N as a sum of between `minCount` and `maxCount`
 * positive nonzero integer squares (a_1^2 + ... + a_k^2 = N, with each a_i >= 1).
 * Returns an array of BigInt bases sorted descending, or null if no representation exists for [minCount, maxCount].
 */
export function findSumOfSquaresDecomposition(n, { minCount = 2, maxCount = 4 } = {}) {
  const target = Number(n);
  if (!Number.isSafeInteger(target) || target < minCount) return null;

  function search(rem, countLeft, maxBase) {
    if (rem <= 0) return null;
    if (countLeft === 1) {
      const r = Math.floor(Math.sqrt(rem));
      if (r >= 1 && r <= maxBase && r * r === rem) {
        return [BigInt(r)];
      }
      return null;
    }
    const upper = Math.min(maxBase, Math.floor(Math.sqrt(rem - (countLeft - 1))));
    const lower = Math.max(1, Math.ceil(Math.sqrt(rem / countLeft)));
    for (let b = upper; b >= lower; b--) {
      const sub = search(rem - b * b, countLeft - 1, b);
      if (sub) {
        return [BigInt(b), ...sub];
      }
    }
    return null;
  }

  const maxRoot = Math.floor(Math.sqrt(target - (minCount - 1)));
  for (let k = minCount; k <= maxCount; k++) {
    const found = search(target, k, maxRoot);
    if (found) return found;
  }
  return null;
}
