/**
 * Trendz Tracker — Phase 8 Elements Drills Unit Tests (tests/drills.test.js)
 *
 * Covers:
 * 1. Exact parity between `js/drillCatalog.js` and `api/_drills.js` across all 18 drills.
 * 2. 200 deterministic seeded runs for EVERY one of the 18 drills verifying question counts,
 *    non-empty texts, canonical answers, and domain invariants.
 * 3. Known mathematical examples from the specification.
 * 4. Answer parsing and comparison edge cases (commas, leading zeros, prime factor separators,
 *    unreduced ratios rejected, spaces accepted, invalid/empty strings never crash).
 * 5. `buildDrillStartResponse` security check ensuring expected answers never appear.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRILLS,
  DRILL_KEYS,
  PRIME_POOL,
  DAYS_TO_SECONDS_MONTHS,
  createSeededRng,
  exactSqrtInfo,
  solveDrillQuestion,
  buildDrillStartResponse,
  gradeDrillSubmission,
} from '../api/_drills.js';
import {
  DRILL_CATALOG,
  DRILL_CATALOG_LIST,
} from '../js/drillCatalog.js';

describe('Phase 8 — 1. Catalog & Server Metadata Parity', () => {
  it('js/drillCatalog.js matches api/_drills.js on all 18 drills and metadata fields', () => {
    assert.equal(DRILL_KEYS.length, 18);
    assert.equal(DRILL_CATALOG_LIST.length, 18);
    assert.deepEqual(Object.keys(DRILL_CATALOG), DRILL_KEYS);

    for (const key of DRILL_KEYS) {
      const serverDrill = DRILLS[key];
      const clientDrill = DRILL_CATALOG[key];
      assert.ok(clientDrill, `Missing ${key} in DRILL_CATALOG`);
      assert.equal(clientDrill.key, serverDrill.key);
      assert.equal(clientDrill.title, serverDrill.title);
      assert.equal(clientDrill.group, serverDrill.group);
      assert.equal(clientDrill.questions, serverDrill.questions);
      assert.equal(clientDrill.time_limit_seconds, serverDrill.time_limit_seconds);
      assert.equal(clientDrill.enabled, serverDrill.enabled);
      assert.equal(clientDrill.inputmode, serverDrill.inputmode);
      assert.equal(clientDrill.hint, serverDrill.hint);
    }

    // Modulo is disabled by default until teacher confirms
    assert.equal(DRILLS.modulo.enabled, false);
    assert.equal(DRILLS.days_to_seconds.time_limit_seconds, 300);
  });
});

describe('Phase 8 — 2. 200 Seeded Sets per Drill & Range Invariants', () => {
  for (const key of DRILL_KEYS) {
    const drill = DRILLS[key];

    it(`${key} (${drill.title}): 200 seeded sets produce ${drill.questions} valid questions & canonical answers`, () => {
      for (let run = 1; run <= 200; run++) {
        const rng = createSeededRng(run * 10007 + key.length * 97);
        const set = drill.generate(rng);

        assert.equal(
          set.length,
          drill.questions,
          `${key} run ${run} should have ${drill.questions} questions`
        );

        for (let i = 0; i < set.length; i++) {
          const item = set[i];
          assert.equal(typeof item.text, 'string');
          assert.ok(item.text.trim().length > 0, `${key} q[${i}] text must not be empty`);
          assert.notEqual(item.expected, null);
          assert.notEqual(item.expected, undefined);

          // Formatting and re-parsing the expected answer must equal expected
          const formatted = drill.format(item.expected);
          const reparsed = drill.parse(formatted);
          assert.equal(
            drill.equal(reparsed, item.expected),
            true,
            `${key} formatted expected "${formatted}" did not round-trip`
          );

          // Solver check
          const solved = solveDrillQuestion(key, item.text);
          assert.deepEqual(item.expected, solved);
        }

        // Drill-specific invariant checks across all 200 sets
        if (key === 'century_codes') {
          for (const q of set) {
            assert.match(q.text, /^\d{4}$/);
            const a = Number(q.text.slice(0, 2));
            const b = Number(q.text.slice(2, 4));
            assert.ok(a >= 11 && a <= 30);
            assert.ok(b >= 11 && b <= 99);
            assert.ok([0, 2, 4, 6].includes(q.expected));
          }
        }

        if (key === 'time_conversion') {
          for (let i = 0; i < 24; i++) {
            assert.match(set[i].text, /^[1-6] (Day|Week|Hour|Minute|Month)$/);
          }
          // 25th question is always "1 Year"
          assert.equal(set[24].text, '1 Year');
          assert.equal(set[24].expected, 31536000);
        }

        if (key === 'squares_11_50' || key === 'cubes_11_50') {
          for (const q of set) {
            const n = Number(q.text);
            assert.ok(n >= 11 && n <= 50);
          }
        }

        if (key === 'squares_51_100' || key === 'cubes_51_100') {
          for (const q of set) {
            const n = Number(q.text);
            assert.ok(n >= 51 && n <= 100);
          }
        }

        if (key === 'divide_by_4' || key === 'divide_by_7') {
          for (const q of set) {
            const n = Number(q.text.split('/')[0].trim());
            assert.ok(n >= 11 && n <= 99);
          }
        }

        if (key === 'prime_factors') {
          for (const q of set) {
            const [p1, p2] = q.expected;
            assert.ok(PRIME_POOL.includes(p1));
            assert.ok(PRIME_POOL.includes(p2));
            assert.ok(p1 <= p2);
            assert.equal(p1 * p2, Number(q.text));
          }
        }

        if (key === 'modulo') {
          for (let i = 0; i < 20; i++) {
            const m = set[i].text.match(/^(\d+)\s+(\d+)\.(\d+)$/);
            assert.ok(m, `Modulo format invalid: ${set[i].text}`);
            const n1 = Number(m[2]);
            const n2Str = m[3];
            assert.ok(n1 >= 11 && n1 <= 99);
            if (i < 15) {
              assert.equal(n2Str.length, 2);
            } else {
              assert.equal(n2Str.length, 3);
            }
          }
        }

        if (key === 'ratio') {
          for (const q of set) {
            const [numStr, denStr] = q.expected.split('/');
            assert.notEqual(
              numStr,
              denStr,
              'Ratio must never have p equal to q (1/1)'
            );
          }
        }

        if (key === 'days_to_seconds') {
          for (const q of set) {
            const m = q.text.match(
              /^([A-Za-z.]+)\s+(\d+),\s*(\d+)\s*-\s*([A-Za-z.]+)\s+(\d+),\s*(\d+)$/
            );
            assert.ok(m);
            const mon1 = m[1];
            const d1 = Number(m[2]);
            const y1 = Number(m[3]);
            const mon2 = m[4];
            const d2 = Number(m[5]);
            const y2 = Number(m[6]);

            const idx1 = DAYS_TO_SECONDS_MONTHS.findIndex((x) => x.name === mon1);
            const idx2 = DAYS_TO_SECONDS_MONTHS.findIndex((x) => x.name === mon2);
            assert.ok(idx1 >= 0 && idx1 <= 7);
            assert.ok(idx2 - idx1 >= 1 && idx2 - idx1 <= 4);
            assert.ok(d1 >= 1 && d1 <= 30 && d1 <= DAYS_TO_SECONDS_MONTHS[idx1].days);
            assert.ok(d2 >= 1 && d2 <= 30 && d2 <= DAYS_TO_SECONDS_MONTHS[idx2].days);
            if (mon1 === 'Feb.') assert.ok(d1 <= 28);
            if (mon2 === 'Feb.') assert.ok(d2 <= 28);
            assert.ok(y1 >= 1600 && y1 <= 2000);
            assert.ok(y2 >= 1600 && y2 <= 2000);
          }
        }

        if (key === 'hours_to_seconds') {
          for (const q of set) {
            const m = q.text.match(/^(\d+):00:00 - (\d+):00:00$/);
            assert.ok(m);
            const h1 = Number(m[1]);
            const h2 = Number(m[2]);
            assert.ok(h1 >= 5 && h1 <= 15);
            assert.ok(h2 >= 15 && h2 <= 24);
            assert.ok(q.expected >= 0);
          }
        }

        if (key === 'minutes_to_seconds') {
          for (const q of set) {
            assert.ok(q.expected >= 0, `Minutes answer must never be negative: ${q.text}`);
          }
        }

        if (key === 'number_to_be_squared') {
          for (const q of set) {
            const n = Number(q.text);
            assert.ok(n >= 11111 && n <= 5555555);
            const info = exactSqrtInfo(n);
            assert.equal(info.isPerfectSquare, false, `${n} must not be a perfect square`);
            const k = BigInt(q.expected);
            assert.ok((k - 1n) * (k - 1n) < BigInt(n));
            assert.ok(k * k > BigInt(n));
          }
        }

        if (key === 'squares_3d_4d') {
          const allNums = set.map((q) => Number(q.text));
          const uniqueNums = new Set(allNums);
          assert.equal(uniqueNums.size, 20, 'All 20 numbers in 3D-4D Square must be distinct');
          const threeDigits = allNums.filter((n) => n >= 111 && n <= 999);
          const fourDigits = allNums.filter((n) => n >= 1111 && n <= 9999);
          assert.equal(threeDigits.length, 10);
          assert.equal(fourDigits.length, 10);
        }
      }
    });
  }
});

describe('Phase 8 — 3. Known Examples Verification', () => {
  it('computes the exact expected answer for every known example in the specification', () => {
    // Saturday gives 0
    assert.equal(solveDrillQuestion('day_codes', 'Saturday'), 0);

    // "February (02)" gives 4
    assert.equal(solveDrillQuestion('month_codes', 'February (02)'), 4);

    // year 1857 gives 2
    assert.equal(solveDrillQuestion('century_codes', '1857'), 2);

    // "3 Week" gives 1814400
    assert.equal(solveDrillQuestion('time_conversion', '3 Week'), 1814400);

    // 47 squared is 2209
    assert.equal(solveDrillQuestion('squares_11_50', '47'), 2209);

    // 99 cubed is 970299
    assert.equal(solveDrillQuestion('cubes_51_100', '99'), 970299);

    // 97 / 4 gives 24
    assert.equal(solveDrillQuestion('divide_by_4', '97 / 4'), 24);

    // 97 / 7 gives 6
    assert.equal(solveDrillQuestion('divide_by_7', '97 / 7'), 6);

    // 1261 has the factors 13 and 97 in either order
    assert.deepEqual(solveDrillQuestion('prime_factors', '1261'), [13, 97]);
    assert.equal(
      DRILLS.prime_factors.equal(DRILLS.prime_factors.parse('97 x 13'), [13, 97]),
      true
    );
    assert.equal(
      DRILLS.prime_factors.equal(DRILLS.prime_factors.parse('13 x 97'), [13, 97]),
      true
    );

    // "888 / 1554" gives 4/7
    assert.equal(solveDrillQuestion('ratio', '888 / 1554'), '4/7');

    // "Jan. 10, 1700 - March 5, 1800" gives (21 + 28 + 5) * 86400 = 4665600
    assert.equal(
      solveDrillQuestion('days_to_seconds', 'Jan. 10, 1700 - March 5, 1800'),
      4665600
    );

    // "7:00:00 - 19:00:00" gives 43200
    assert.equal(solveDrillQuestion('hours_to_seconds', '7:00:00 - 19:00:00'), 43200);

    // "12:30 - 25:10" gives 760
    assert.equal(solveDrillQuestion('minutes_to_seconds', '12:30 - 25:10'), 760);

    // 2000000 gives 1415
    assert.equal(solveDrillQuestion('number_to_be_squared', '2000000'), 1415);

    // 999 squared is 998001
    assert.equal(solveDrillQuestion('squares_3d_4d', '999'), 998001);
  });
});

describe('Phase 8 — 4. Answer Parsing & Comparison Rules', () => {
  it('parses integer answers removing spaces and commas and accepting leading zeros', () => {
    const d = DRILLS.time_conversion;
    assert.equal(d.equal(d.parse('86,400'), 86400), true);
    assert.equal(d.equal(d.parse('0086400'), 86400), true);
    assert.equal(d.equal(d.parse(' 86 400 '), 86400), true);
    assert.equal(d.equal(d.parse('03'), 3), true);
    assert.equal(d.equal(d.parse('0'), 0), true);

    // Letters, empty strings, decimals, negative signs return null and are wrong (never throw)
    assert.equal(d.parse(''), null);
    assert.equal(d.parse('   '), null);
    assert.equal(d.parse(null), null);
    assert.equal(d.parse('abc'), null);
    assert.equal(d.parse('86.4'), null);
    assert.equal(d.parse('-5'), null);
    assert.equal(d.equal(d.parse('abc'), 86400), false);
    assert.equal(d.equal(d.parse(''), 0), false);
  });

  it('parses prime factor pairs across all allowed separators in either order', () => {
    const pf = DRILLS.prime_factors;
    const expected = [13, 97];

    assert.equal(pf.equal(pf.parse('97x13'), expected), true);
    assert.equal(pf.equal(pf.parse('13 x 97'), expected), true);
    assert.equal(pf.equal(pf.parse('97 X 13'), expected), true);
    assert.equal(pf.equal(pf.parse('13 × 97'), expected), true);
    assert.equal(pf.equal(pf.parse('13 * 97'), expected), true);
    assert.equal(pf.equal(pf.parse('97, 13'), expected), true);
    assert.equal(pf.equal(pf.parse('13 97'), expected), true);
    assert.equal(pf.equal(pf.parse('013 x 097'), expected), true);

    assert.equal(pf.equal(pf.parse('13 x 89'), expected), false);
    assert.equal(pf.parse('1261'), null);
    assert.equal(pf.parse('letters'), null);
    assert.equal(pf.parse(''), null);
  });

  it('accepts lowest-terms ratio with optional spaces and rejects unreduced equivalent ratios', () => {
    const r = DRILLS.ratio;
    assert.equal(r.equal(r.parse('4/7'), '4/7'), true);
    assert.equal(r.equal(r.parse(' 4 / 7 '), '4/7'), true);
    assert.equal(r.equal(r.parse('04/07'), '4/7'), true);

    // Unreduced ratio "8/14" is wrong for "4/7"
    assert.equal(r.equal(r.parse('8/14'), '4/7'), false);
    assert.equal(r.parse('4/0'), null);
    assert.equal(r.parse('4'), null);
    assert.equal(r.parse('a/b'), null);
    assert.equal(r.parse(''), null);
  });

  it('parses modulo quotient and remainder separated by comma or space', () => {
    const mod = DRILLS.modulo;
    assert.equal(mod.equal(mod.parse('12, 5'), [12, 5]), true);
    assert.equal(mod.equal(mod.parse('12 5'), [12, 5]), true);
    assert.equal(mod.equal(mod.parse('012, 05'), [12, 5]), true);
    assert.equal(mod.equal(mod.parse('5, 12'), [12, 5]), false);
    assert.equal(mod.parse('12'), null);
    assert.equal(mod.parse(''), null);
  });
});

describe('Phase 8 — 5. Start Response Security & Submission Grading', () => {
  it('buildDrillStartResponse contains no expected answers anywhere in the payload', () => {
    const drill = DRILLS.squares_51_100;
    const rng = createSeededRng(42);
    const generated = drill.generate(rng);

    const response = buildDrillStartResponse({
      sessionId: 'sess-123',
      drillKey: 'squares_51_100',
      drill,
      generated,
    });

    assert.deepEqual(Object.keys(response).sort(), [
      'drill',
      'hint',
      'questions',
      'session_id',
      'time_limit_seconds',
      'title',
    ]);
    assert.equal(response.expected, undefined);
    assert.equal(response.questions.length, 50);

    for (let i = 0; i < response.questions.length; i++) {
      assert.equal(typeof response.questions[i], 'string');
      assert.equal(response.questions[i], generated[i].text);
    }

    const serialized = JSON.stringify(response);
    for (const item of generated) {
      // 4-digit/5-digit squares (2601..10000) must not appear in the start payload
      assert.equal(serialized.includes(String(item.expected)), false);
    }
  });

  it('gradeDrillSubmission counts attempted (non-blank) answers and grades accurately', () => {
    const graded = gradeDrillSubmission({
      drillKey: 'day_codes',
      questions: ['Sunday', 'Saturday', 'Monday'],
      expected: [1, 0, 2],
      answers: ['1', '9', '   '],
      elapsedSeconds: 24.4,
      timeLimitSeconds: 60,
    });

    assert.equal(graded.attempted, 2);
    assert.equal(graded.correct, 1);
    assert.equal(graded.questions_total, 3);
    assert.equal(graded.accuracy, 50);
    assert.equal(graded.seconds, 24);
    assert.equal(graded.detail.length, 3);
    assert.deepEqual(graded.detail[0], {
      question: 'Sunday',
      expected_display: '1',
      given: '1',
      correct: true,
    });
    assert.deepEqual(graded.detail[1], {
      question: 'Saturday',
      expected_display: '0',
      given: '9',
      correct: false,
    });
    assert.deepEqual(graded.detail[2], {
      question: 'Monday',
      expected_display: '2',
      given: null,
      correct: false,
    });
  });
});
