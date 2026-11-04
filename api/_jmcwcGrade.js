/**
 * Trendz Tracker — Phase 17a: JMCWC Simulator Pure Grading Engine (api/_jmcwcGrade.js)
 *
 * Server-only pure grading engine:
 *   grade(question, rawAnswer) -> { question_id, award, verdict, expected, explanation }
 *
 * Security & Mathematical Guarantees:
 * - Never uses eval() or Function().
 * - Preserves raw answer text (never coerces via Number() before grading).
 * - Rejects malformed or oversized inputs safely.
 * - Uses BigInt and exact Rational / scaled-decimal arithmetic throughout.
 */

import {
  absBigInt,
  evaluateDecimalRounding,
  formatMixedFraction,
  formatPrimeFactorization,
  formatScaledUnits,
  gcdBigInt,
  isPrimeBigInt,
  makeRational,
  MONTH_NAMES_EN,
  parseSingleMonthInput,
  parseStudentDecimal,
  parseStudentFraction,
  parseWeekdayInput,
  pow10BigInt,
  roundBigIntToSigFigs,
  roundScaledAtDecimals,
  WEEKDAY_NAMES_EN,
} from './_jmcwcMath.js';

export const JMCWC_MAX_RAW_ANSWER_LENGTH = 256;

const SUPERSCRIPT_DIGITS = new Map([
  ['⁰', '0'],
  ['¹', '1'],
  ['²', '2'],
  ['³', '3'],
  ['⁴', '4'],
  ['⁵', '5'],
  ['⁶', '6'],
  ['⁷', '7'],
  ['⁸', '8'],
  ['⁹', '9'],
]);

function normalizeSuperscripts(str) {
  let out = '';
  let inSup = false;
  for (const ch of str) {
    if (SUPERSCRIPT_DIGITS.has(ch)) {
      if (!inSup) {
        out += '^';
        inSup = true;
      }
      out += SUPERSCRIPT_DIGITS.get(ch);
    } else {
      inSup = false;
      out += ch;
    }
  }
  return out;
}

/**
 * Determine whether rawAnswer is blank/skipped.
 * Supports string, array of strings (multi-box input), or plain object of field strings.
 */
export function isRawAnswerBlank(rawAnswer) {
  if (rawAnswer === null || rawAnswer === undefined) return true;
  if (typeof rawAnswer === 'string') {
    return rawAnswer.trim().length === 0;
  }
  if (Array.isArray(rawAnswer)) {
    return rawAnswer.every((item) => item === null || item === undefined || String(item).trim().length === 0);
  }
  if (typeof rawAnswer === 'object') {
    const vals = Object.values(rawAnswer);
    if (vals.length === 0) return true;
    return vals.every((item) => item === null || item === undefined || String(item).trim().length === 0);
  }
  return false;
}

/**
 * Validate that rawAnswer does not exceed safe length limits or contain non-printable control payloads.
 */
function isSafeAnswerPayload(rawAnswer) {
  if (typeof rawAnswer === 'string') {
    if (rawAnswer.length > JMCWC_MAX_RAW_ANSWER_LENGTH) return false;
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(rawAnswer)) return false;
    return true;
  }
  if (Array.isArray(rawAnswer)) {
    if (rawAnswer.length > 16) return false;
    return rawAnswer.every(
      (x) => x === null || x === undefined || (typeof x === 'string' && isSafeAnswerPayload(x))
    );
  }
  if (rawAnswer && typeof rawAnswer === 'object') {
    const keys = Object.keys(rawAnswer);
    if (keys.length > 16) return false;
    return keys.every((k) => {
      const v = rawAnswer[k];
      return v === null || v === undefined || (typeof v === 'string' && isSafeAnswerPayload(v));
    });
  }
  return false;
}

/**
 * Parse a strict signed integer string into BigInt without using Number().
 * Per JMCWC Rules 2025 Rule 8, accepts plain digits ("12345678"), comma-grouped thousands ("12,345,678"),
 * and digit-counting pipe marks ("1234|56|78").
 */
export function parseStrictBigInt(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw
    .trim()
    .replace(/[−–—]/g, '-');
  if (!trimmed) return null;
  const grouped = /^([+-])?(\d{1,3}(?:,\d{3})+)$/;
  const piped = /^([+-])?(\d+(?:\|\d+)+)$/;
  const plain = /^([+-])?(\d+)$/;
  let sign = '';
  let digits = '';
  const mPlain = trimmed.match(plain);
  if (mPlain) {
    sign = mPlain[1] === '-' ? '-' : '';
    digits = mPlain[2];
  } else {
    const mGroup = trimmed.match(grouped);
    const mPipe = trimmed.match(piped);
    if (mGroup) {
      sign = mGroup[1] === '-' ? '-' : '';
      digits = mGroup[2].replace(/,/g, '');
    } else if (mPipe) {
      sign = mPipe[1] === '-' ? '-' : '';
      digits = mPipe[2].replace(/\|/g, '');
    } else {
      return null;
    }
  }
  const val = BigInt(`${sign}${digits}`);
  return val;
}

// ============================================================================
// Category-Specific Evaluators
// ============================================================================

function gradeExactInteger(answerKey, rawAnswer) {
  const expectedVal = BigInt(answerKey.value);
  const expectedStr = String(answerKey.expected_display ?? expectedVal.toString());
  const explanation = String(answerKey.explanation ?? `Exact value is ${expectedStr}.`);

  const str = typeof rawAnswer === 'string' ? rawAnswer.trim() : '';
  // Missing-digit support: accept either the missing digit(s) or the full reconstructed number
  if (answerKey.missing_digit !== undefined && answerKey.missing_digit !== null) {
    const missingStr = String(answerKey.missing_digit).trim();
    const fullStr = answerKey.full_number !== undefined ? String(answerKey.full_number).trim() : null;
    const cleaned = str.replace(/\s+/g, '');
    if (cleaned === missingStr) {
      return { verdict: 'correct', expected: expectedStr, explanation };
    }
    if (fullStr !== null) {
      const parsedUser = parseStrictBigInt(str);
      const parsedFull = parseStrictBigInt(fullStr);
      if (parsedUser !== null && parsedFull !== null && parsedUser === parsedFull) {
        return { verdict: 'correct', expected: expectedStr, explanation };
      }
    }
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  const parsed = parseStrictBigInt(str);
  if (parsed === null) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }
  if (parsed === expectedVal) {
    return { verdict: 'correct', expected: expectedStr, explanation };
  }
  return { verdict: 'wrong', expected: expectedStr, explanation };
}

function gradeExactDecimal(answerKey, rawAnswer) {
  const expectedParsed = parseStudentDecimal(String(answerKey.value));
  const expectedStr = String(answerKey.expected_display ?? answerKey.value);
  const explanation = String(answerKey.explanation ?? `Exact value is ${expectedStr}.`);
  if (typeof rawAnswer !== 'string') {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }
  const userParsed = parseStudentDecimal(rawAnswer);
  if (!userParsed.ok || !expectedParsed.ok) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }
  // Compare exact value as rational / scaled integer
  const maxDec = Math.max(userParsed.decimals, expectedParsed.decimals);
  const uScaled =
    BigInt(userParsed.sign) *
    userParsed.unitsBigInt *
    pow10BigInt(maxDec - userParsed.decimals);
  const eScaled =
    BigInt(expectedParsed.sign) *
    expectedParsed.unitsBigInt *
    pow10BigInt(maxDec - expectedParsed.decimals);
  if (uScaled === eScaled) {
    return { verdict: 'correct', expected: expectedStr, explanation };
  }
  return { verdict: 'wrong', expected: expectedStr, explanation };
}

function gradeRoundedDecimal(answerKey, rawAnswer) {
  const highScaledObj = {
    scaledFloor: BigInt(answerKey.scaled_floor),
    scale: Number(answerKey.scale),
    exact: Boolean(answerKey.exact),
    sign: Number(answerKey.sign ?? 1),
  };
  const targetDecimals = Number(answerKey.target_decimals);
  const targetRound = roundScaledAtDecimals(highScaledObj, targetDecimals);
  const defaultExpected = formatScaledUnits(
    targetRound.nearestUnits,
    targetDecimals,
    targetRound.sign
  );
  const expectedStr = String(answerKey.expected_display ?? defaultExpected);
  const explanation = String(
    answerKey.explanation ??
      `Rounded to ${targetDecimals} decimal place${targetDecimals === 1 ? '' : 's'}: ${expectedStr}.`
  );

  if (typeof rawAnswer !== 'string') {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }
  const result = evaluateDecimalRounding(rawAnswer, highScaledObj, targetDecimals);
  return {
    verdict: result.verdict,
    expected: expectedStr,
    explanation,
  };
}

function gradeApproximation(answerKey, rawAnswer) {
  const expectedStr = String(answerKey.expected_display ?? answerKey.value);
  const explanation = String(answerKey.explanation ?? `Target approximation is ${expectedStr}.`);
  if (typeof rawAnswer !== 'string') {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  // Mode 1: Decimal rounding if scaled_floor & target_decimals are provided
  if (answerKey.scaled_floor !== undefined && answerKey.target_decimals !== undefined) {
    return gradeRoundedDecimal(answerKey, rawAnswer);
  }

  // Parse student integer or decimal
  const intVal = parseStrictBigInt(rawAnswer);

  // Mode 2: Explicit tolerance bands (full_min..full_max, optional half_min..half_max)
  if (answerKey.full_min !== undefined && answerKey.full_max !== undefined) {
    if (intVal === null) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    const fullMin = BigInt(answerKey.full_min);
    const fullMax = BigInt(answerKey.full_max);
    if (intVal >= fullMin && intVal <= fullMax) {
      return { verdict: 'correct', expected: expectedStr, explanation };
    }
    if (answerKey.half_min !== undefined && answerKey.half_max !== undefined) {
      const halfMin = BigInt(answerKey.half_min);
      const halfMax = BigInt(answerKey.half_max);
      if (intVal >= halfMin && intVal <= halfMax) {
        return { verdict: 'partial', expected: expectedStr, explanation };
      }
    }
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  // Mode 3: Significant-figure rounding on an exact integer / scaled value
  if (answerKey.exact_integer !== undefined && answerKey.sig_figs !== undefined) {
    if (intVal === null) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    const exactInt = BigInt(answerKey.exact_integer);
    const sigFigs = Number(answerKey.sig_figs);
    const targetSf = roundBigIntToSigFigs(exactInt, sigFigs);
    if (intVal === targetSf.nearest) {
      return { verdict: 'correct', expected: expectedStr, explanation };
    }
    if (!targetSf.exact && intVal === targetSf.other) {
      return { verdict: 'partial', expected: expectedStr, explanation };
    }
    // Check if student provided excess significant figures that validly round exactInt
    const absStr = absBigInt(exactInt).toString();
    for (let sf = sigFigs + 1; sf <= absStr.length; sf++) {
      const excessSf = roundBigIntToSigFigs(exactInt, sf);
      if (intVal === excessSf.nearest) {
        return { verdict: 'partial', expected: expectedStr, explanation };
      }
    }
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  return gradeExactInteger(answerKey, rawAnswer);
}

function gradeSimplestMixedFraction(answerKey, rawAnswer) {
  const expectedRat = makeRational(answerKey.num, answerKey.den);
  const expectedStr = String(answerKey.expected_display ?? formatMixedFraction(expectedRat));
  const explanation = String(
    answerKey.explanation ?? `Simplest mixed fraction is ${expectedStr}.`
  );

  let candidateStr = '';
  if (typeof rawAnswer === 'string') {
    candidateStr = rawAnswer;
  } else if (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) {
    const w = String(rawAnswer.whole ?? '').trim();
    const n = String(rawAnswer.num ?? '').trim();
    const d = String(rawAnswer.den ?? '').trim();
    if (w && !n && !d) {
      candidateStr = w;
    } else if (!w && n && d) {
      candidateStr = `${n}/${d}`;
    } else if (w && n && d) {
      candidateStr = `${w} ${n}/${d}`;
    } else {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
  } else {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  const parsed = parseStudentFraction(candidateStr);
  if (!parsed.ok) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  const sameValue =
    parsed.rational.num === expectedRat.num && parsed.rational.den === expectedRat.den;
  if (!sameValue) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  // Must be in simplest mixed form (reduced and proper fractional part)
  if (!parsed.isSimplestMixed) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  return { verdict: 'correct', expected: expectedStr, explanation };
}

function gradePrimeFactorization(answerKey, rawAnswer) {
  const target = BigInt(answerKey.target);
  const expectedStr = String(
    answerKey.expected_display ??
      (Array.isArray(answerKey.factors)
        ? formatPrimeFactorization(
            answerKey.factors.map((f) => ({ prime: BigInt(f.prime), exp: Number(f.exp) }))
          )
        : target.toString())
  );
  const explanation = String(
    answerKey.explanation ?? `Prime factorisation of ${target.toString()} is ${expectedStr}.`
  );

  if (typeof rawAnswer !== 'string') {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  const normalized = normalizeSuperscripts(rawAnswer.trim())
    .replace(/\*\*/g, '^')
    .replace(/[×xX*·•,]/g, ' ')
    .replace(/\.(?=\s*\d)/g, ' ')
    .trim();

  if (!normalized) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  // Split tokens by whitespace, keeping `p^e` glued even if spaces surround `^`
  const compact = normalized.replace(/\s*\^\s*/g, '^');
  const tokens = compact.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  let product = 1n;
  for (const tok of tokens) {
    const m = tok.match(/^(\d+)(?:\^(\d+))?$/);
    if (!m) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    const base = BigInt(m[1]);
    const exp = m[2] !== undefined ? Number(m[2]) : 1;
    if (exp < 1 || exp > 64) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    // Every base must be prime (rejects 1 and composite numbers like 4, 6, 9, etc.)
    if (!isPrimeBigInt(base)) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    for (let i = 0; i < exp; i++) {
      product *= base;
      if (product > target) {
        return { verdict: 'wrong', expected: expectedStr, explanation };
      }
    }
  }

  if (product !== target) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  return { verdict: 'correct', expected: expectedStr, explanation };
}

function gradeSumOfSquares(answerKey, rawAnswer) {
  const target = BigInt(answerKey.target);
  const minCount = Number(answerKey.min_count ?? 2);
  const maxCount = Number(answerKey.max_count ?? 4);
  const expectedBases = Array.isArray(answerKey.example_bases)
    ? answerKey.example_bases.map((b) => BigInt(b))
    : [];
  const expectedStr = String(
    answerKey.expected_display ??
      (expectedBases.length > 0
        ? expectedBases.map((b) => `${b.toString()}²`).join(' + ')
        : `Sum of ${minCount}–${maxCount} squares = ${target.toString()}`)
  );
  const explanation = String(
    answerKey.explanation ??
      `${target.toString()} = ${expectedStr} (any valid decomposition of ${minCount} to ${maxCount} positive integer squares is accepted).`
  );

  let rawTokens = [];
  if (Array.isArray(rawAnswer)) {
    // Multi-box array: ignore empty boxes, but if a box has text, keep it
    rawTokens = rawAnswer
      .map((item) => (item === null || item === undefined ? '' : String(item).trim()))
      .filter((s) => s.length > 0);
  } else if (typeof rawAnswer === 'string') {
    const normalized = normalizeSuperscripts(rawAnswer.trim()).replace(/\*\*/g, '^');
    // Split on '+', ',', ';', or whitespace (keeping `b^2` intact)
    const compact = normalized.replace(/\s*\^\s*/g, '^');
    rawTokens = compact.split(/[\s+,;]+/).filter(Boolean);
  } else {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  if (rawTokens.length < minCount || rawTokens.length > maxCount) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  let sumSq = 0n;
  for (const tok of rawTokens) {
    // Accept either a positive base `b` or explicit squared notation `b^2`
    const m = tok.match(/^([+-]?\d+)(?:\^(\d+))?$/);
    if (!m) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    if (m[2] !== undefined && m[2] !== '2') {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    const base = BigInt(m[1]);
    // Reject 0 padding and negative bases: bases must be strictly positive integers >= 1
    if (base <= 0n) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
    sumSq += base * base;
  }

  if (sumSq === target) {
    return { verdict: 'correct', expected: expectedStr, explanation };
  }
  return { verdict: 'wrong', expected: expectedStr, explanation };
}

function gradeCalendar(answerKey, rawAnswer) {
  const subtype = answerKey.subtype || 'weekday';
  const expectedStr = String(answerKey.expected_display ?? answerKey.value ?? '');
  const explanation = String(answerKey.explanation ?? `Correct answer is ${expectedStr}.`);

  if (typeof rawAnswer !== 'string') {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  if (subtype === 'weekday') {
    const expectedDow = Number(answerKey.weekday_index);
    const parsedDow = parseWeekdayInput(rawAnswer);
    if (parsedDow === null) {
      return { verdict: 'wrong', expected: expectedStr || WEEKDAY_NAMES_EN[expectedDow], explanation };
    }
    if (parsedDow === expectedDow) {
      return { verdict: 'correct', expected: expectedStr || WEEKDAY_NAMES_EN[expectedDow], explanation };
    }
    return { verdict: 'wrong', expected: expectedStr || WEEKDAY_NAMES_EN[expectedDow], explanation };
  }

  if (subtype === 'month') {
    const validMonths = Array.isArray(answerKey.valid_months)
      ? answerKey.valid_months.map(Number)
      : [Number(answerKey.month_index)];
    const parsedMonth = parseSingleMonthInput(rawAnswer);
    const fallbackExpected =
      expectedStr || validMonths.map((m) => MONTH_NAMES_EN[m - 1]).join(' or ');
    if (parsedMonth === null) {
      return { verdict: 'wrong', expected: fallbackExpected, explanation };
    }
    if (validMonths.includes(parsedMonth)) {
      return { verdict: 'correct', expected: fallbackExpected, explanation };
    }
    return { verdict: 'wrong', expected: fallbackExpected, explanation };
  }

  if (subtype === 'year') {
    const validYears = Array.isArray(answerKey.valid_years)
      ? answerKey.valid_years.map(Number)
      : [Number(answerKey.year)];
    const rawTokens = String(rawAnswer).split(/[\s,]+/).filter(Boolean).map(Number);
    if (rawTokens.length > 0 && rawTokens.every((y) => validYears.includes(y))) {
      return { verdict: 'correct', expected: expectedStr, explanation };
    }
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  // Numeric calendar question (e.g. date number, count of occurrences, or year)
  return gradeExactInteger(answerKey, rawAnswer);
}

function gradeRatio(answerKey, rawAnswer) {
  const expectedStr = String(answerKey.expected_display ?? '');
  const explanation = String(answerKey.explanation ?? `Correct answer is ${expectedStr}.`);

  // Single missing term in ratio
  if (answerKey.value !== undefined && !Array.isArray(answerKey.terms)) {
    return gradeExactInteger(answerKey, rawAnswer);
  }

  // Multi-term ratio e.g. [a, b] or [a, b, c]
  const expectedTerms = (answerKey.terms || []).map((t) => BigInt(t));
  let userParts = [];
  if (Array.isArray(rawAnswer)) {
    userParts = rawAnswer.map((x) => String(x ?? '').trim());
  } else if (typeof rawAnswer === 'string') {
    userParts = rawAnswer
      .trim()
      .split(/\s*[:;,]\s*|\s+/)
      .filter(Boolean);
  } else {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  if (userParts.length !== expectedTerms.length) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  const parsedTerms = [];
  for (const p of userParts) {
    const b = parseStrictBigInt(p);
    if (b === null) return { verdict: 'wrong', expected: expectedStr, explanation };
    parsedTerms.push(b);
  }

  // Require exact term-by-term equality (already simplified when simplest_form is required)
  const exactMatch = parsedTerms.every((val, idx) => val === expectedTerms[idx]);
  if (exactMatch) {
    return { verdict: 'correct', expected: expectedStr, explanation };
  }
  return { verdict: 'wrong', expected: expectedStr, explanation };
}

function gradeElapsedTime(answerKey, rawAnswer) {
  const expectedStr = String(answerKey.expected_display ?? '');
  const explanation = String(answerKey.explanation ?? `Correct elapsed time is ${expectedStr}.`);
  const format = answerKey.format || 'hours_minutes';

  if (format === 'seconds') {
    const totalSecs = BigInt(answerKey.total_seconds ?? answerKey.value ?? 0);
    return gradeExactInteger({ ...answerKey, value: totalSecs.toString(), expected_display: expectedStr }, rawAnswer);
  }

  const totalMinutes = BigInt(answerKey.total_minutes ?? 0);

  if (format === 'minutes') {
    return gradeExactInteger({ ...answerKey, value: totalMinutes.toString(), expected_display: expectedStr }, rawAnswer);
  }

  // hours_minutes format: accept `{ hours, minutes }`, `[hours, minutes]`, `"H:MM"`, `"H h M m"`, or `"H M"`
  const expectedHours = totalMinutes / 60n;
  const expectedMins = totalMinutes % 60n;

  let hVal = null;
  let mVal = null;

  if (Array.isArray(rawAnswer) && rawAnswer.length === 2) {
    hVal = parseStrictBigInt(String(rawAnswer[0] ?? ''));
    mVal = parseStrictBigInt(String(rawAnswer[1] ?? ''));
  } else if (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) {
    hVal = parseStrictBigInt(String(rawAnswer.hours ?? rawAnswer.h ?? ''));
    mVal = parseStrictBigInt(String(rawAnswer.minutes ?? rawAnswer.m ?? ''));
  } else if (typeof rawAnswer === 'string') {
    const s = rawAnswer.trim();
    const hmColon = s.match(/^(\d+)\s*:\s*(\d{1,2})$/);
    const hmWords = s.match(/^(\d+)\s*(?:h|hr|hrs|hours?)\s*(\d{1,2})?\s*(?:m|min|mins|minutes?)?$/i);
    const mOnlyWords = s.match(/^(\d+)\s*(?:m|min|mins|minutes?)$/i);
    const twoInts = s.match(/^(\d+)\s+(\d{1,2})$/);
    if (hmColon) {
      hVal = BigInt(hmColon[1]);
      mVal = BigInt(hmColon[2]);
    } else if (hmWords) {
      hVal = BigInt(hmWords[1]);
      mVal = hmWords[2] !== undefined ? BigInt(hmWords[2]) : 0n;
    } else if (mOnlyWords && expectedHours === 0n) {
      hVal = 0n;
      mVal = BigInt(mOnlyWords[1]);
    } else if (twoInts) {
      hVal = BigInt(twoInts[1]);
      mVal = BigInt(twoInts[2]);
    } else if (answerKey.allow_total_minutes) {
      const single = parseStrictBigInt(s);
      if (single !== null && single === totalMinutes) {
        return { verdict: 'correct', expected: expectedStr, explanation };
      }
    }
  }

  if (hVal === null || mVal === null || mVal < 0n || mVal >= 60n) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  if (hVal === expectedHours && mVal === expectedMins) {
    return { verdict: 'correct', expected: expectedStr, explanation };
  }
  return { verdict: 'wrong', expected: expectedStr, explanation };
}

function gradePairIntegers(answerKey, rawAnswer) {
  const expectedValues = (answerKey.values || []).map((v) => BigInt(v));
  const expectedStr = String(
    answerKey.expected_display ?? expectedValues.map((v) => v.toString()).join(', ')
  );
  const explanation = String(answerKey.explanation ?? `Correct answer is ${expectedStr}.`);

  let parts = [];
  if (Array.isArray(rawAnswer)) {
    parts = rawAnswer.map((x) => String(x ?? '').trim());
  } else if (rawAnswer && typeof rawAnswer === 'object') {
    parts = [String(rawAnswer.first ?? rawAnswer.hcf ?? ''), String(rawAnswer.second ?? rawAnswer.lcm ?? '')];
  } else if (typeof rawAnswer === 'string') {
    parts = rawAnswer
      .trim()
      .split(/\s*[,;/]\s*|\s+/)
      .filter(Boolean);
  }

  if (parts.length !== expectedValues.length) {
    return { verdict: 'wrong', expected: expectedStr, explanation };
  }

  for (let i = 0; i < expectedValues.length; i++) {
    const b = parseStrictBigInt(parts[i]);
    if (b === null || b !== expectedValues[i]) {
      return { verdict: 'wrong', expected: expectedStr, explanation };
    }
  }
  return { verdict: 'correct', expected: expectedStr, explanation };
}

// ============================================================================
// Main Pure Grading Entry Point
// ============================================================================

/**
 * Pure server-side grading function for a single JMCWC question.
 *
 * @param {object} question - Private question object containing { id, max_marks, answer_key }
 * @param {string|string[]|object|null|undefined} rawAnswer - Raw user input
 * @returns {{ question_id: string, award: number, verdict: 'correct'|'partial'|'wrong'|'skipped', expected: string, explanation: string }}
 */
export function grade(question, rawAnswer) {
  if (!question || typeof question !== 'object') {
    throw new Error('Invalid question object passed to grade()');
  }
  const questionId = String(question.id ?? '');
  const maxMarks = Number(question.max_marks ?? 1);
  const answerKey = question.answer_key || {};
  const fallbackExpected = String(answerKey.expected_display ?? answerKey.value ?? '');
  const fallbackExplanation = String(answerKey.explanation ?? '');

  if (isRawAnswerBlank(rawAnswer)) {
    return {
      question_id: questionId,
      award: 0,
      verdict: 'skipped',
      expected: fallbackExpected,
      explanation: fallbackExplanation,
    };
  }

  if (!isSafeAnswerPayload(rawAnswer)) {
    return {
      question_id: questionId,
      award: 0,
      verdict: 'wrong',
      expected: fallbackExpected,
      explanation: fallbackExplanation,
    };
  }

  const kind = answerKey.kind || 'exact_integer';
  let result;
  switch (kind) {
    case 'exact_integer':
      result = gradeExactInteger(answerKey, rawAnswer);
      break;
    case 'exact_decimal':
      result = gradeExactDecimal(answerKey, rawAnswer);
      break;
    case 'rounded_decimal':
      result = gradeRoundedDecimal(answerKey, rawAnswer);
      break;
    case 'approximation':
      result = gradeApproximation(answerKey, rawAnswer);
      break;
    case 'simplest_mixed_fraction':
      result = gradeSimplestMixedFraction(answerKey, rawAnswer);
      break;
    case 'prime_factorization':
      result = gradePrimeFactorization(answerKey, rawAnswer);
      break;
    case 'sum_of_squares':
      result = gradeSumOfSquares(answerKey, rawAnswer);
      break;
    case 'calendar':
      result = gradeCalendar(answerKey, rawAnswer);
      break;
    case 'ratio':
      result = gradeRatio(answerKey, rawAnswer);
      break;
    case 'elapsed_time':
      result = gradeElapsedTime(answerKey, rawAnswer);
      break;
    case 'integer_pair':
      result = gradePairIntegers(answerKey, rawAnswer);
      break;
    default:
      throw new Error(`Unsupported JMCWC answer_key kind: ${kind}`);
  }

  const finalVerdict = result.verdict === 'skipped' ? 'wrong' : result.verdict;
  let award = 0;
  if (finalVerdict === 'correct') {
    award = maxMarks;
  } else if (finalVerdict === 'partial') {
    award = maxMarks / 2;
  }

  return {
    question_id: questionId,
    award,
    verdict: finalVerdict,
    expected: result.expected,
    explanation: result.explanation,
  };
}

/**
 * Grade an entire attempt's question list against a map of raw answers `{ [question_id]: rawAnswer }`.
 * Returns aggregate statistics matching `jmcwc_scores` and `jmcwc_finalize`.
 */
export function gradeAttempt(questions, answersMap = {}) {
  if (!Array.isArray(questions)) {
    throw new Error('questions must be an array');
  }
  const safeAnswers = answersMap && typeof answersMap === 'object' ? answersMap : {};
  const items = [];
  let marks = 0;
  let maxMarks = 0;
  let correct = 0;
  let partial = 0;
  let wrong = 0;
  let skipped = 0;

  for (const q of questions) {
    const raw = Object.prototype.hasOwnProperty.call(safeAnswers, q.id)
      ? safeAnswers[q.id]
      : '';
    const item = grade(q, raw);
    items.push(item);
    marks += item.award;
    maxMarks += Number(q.max_marks ?? 0);
    if (item.verdict === 'correct') correct++;
    else if (item.verdict === 'partial') partial++;
    else if (item.verdict === 'skipped') skipped++;
    else wrong++;
  }

  return {
    marks,
    max_marks: maxMarks,
    correct,
    partial,
    wrong,
    skipped,
    items,
  };
}
