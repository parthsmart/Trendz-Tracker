import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import {
  CUSTOM_MAX_PER_LEVEL,
  CUSTOM_MAX_QUESTIONS,
  CUSTOM_TOKEN_TTL_MS,
  buildCustomLevels,
  buildCustomOptions,
  generateCustomSet,
  normalizeCustomSelections,
  openCustomSet,
  sealCustomSet,
} from '../api/_jmcwcCustom.js';
import { createJmcwcServer } from '../api/_jmcwcServer.js';

const SECRET = 'test-secret-for-custom-sets-0123456789';
const STUDENT = '00000000-0000-4000-8000-000000000001';
const seniorSpec = JMCWC_PAPERS.senior.spec;

function selectionsFor(spec, perLevel) {
  return buildCustomLevels(spec).flatMap((c) =>
    c.levels.map((l) => ({ category_key: c.category_key, level: l.level, count: perLevel }))
  );
}

describe('custom set levels follow the official paper', () => {
  it('groups every group paper into ascending point levels covering all slots', () => {
    for (const group of ['junior1', 'junior2', 'senior']) {
      const spec = JMCWC_PAPERS[group].spec;
      const levels = buildCustomLevels(spec);
      assert.equal(levels.length, 23, group);
      for (const cat of levels) {
        const sec = spec.sections.find((s) => s.key === cat.category_key);
        const slotCount = cat.levels.reduce((n, l) => n + l.slots.length, 0);
        assert.equal(slotCount, sec.questions.length, `${group} ${cat.category_key} covers every slot`);
        for (let i = 1; i < cat.levels.length; i += 1) {
          assert.ok(cat.levels[i].min_marks >= cat.levels[i - 1].min_marks, `${group} ${cat.category_key} ascending`);
        }
      }
    }
  });

  it('builds options with sample prompts and filters by allowed category', () => {
    const opts = buildCustomOptions(seniorSpec, { allowedCategory: (k) => k === 'addition' || k === 'calendar' });
    assert.deepEqual(opts.map((o) => o.category_key), ['addition', 'calendar']);
    for (const lvl of opts[0].levels) {
      assert.ok(lvl.sample_prompt.length > 0);
      assert.ok(lvl.official_slots >= 1);
    }
  });
});

describe('custom set validation and generation', () => {
  it('rejects empty, unknown, duplicate and oversized selections', () => {
    const bad = (sel, code = 'INVALID_CUSTOM_SET') =>
      assert.throws(() => normalizeCustomSelections(seniorSpec, sel), (e) => e.code === code && e.statusCode === 400);
    bad([]);
    bad(null);
    bad([{ category_key: 'nope', level: 1, count: 1 }]);
    bad([{ category_key: 'addition', level: 99, count: 1 }]);
    bad([{ category_key: 'addition', level: 1, count: CUSTOM_MAX_PER_LEVEL + 1 }]);
    bad([{ category_key: 'addition', level: 1, count: 1.5 }]);
    bad([{ category_key: 'addition', level: 1, count: 0 }]);
    bad([
      { category_key: 'addition', level: 1, count: 1 },
      { category_key: 'addition', level: 1, count: 2 },
    ]);
    bad(selectionsFor(seniorSpec, 2), 'INVALID_CUSTOM_SET'); // 258 questions > 150
    assert.ok(selectionsFor(seniorSpec, 2).reduce((n, s) => n + s.count, 0) > CUSTOM_MAX_QUESTIONS);
  });

  it('rejects categories outside the student access with 403', () => {
    assert.throws(
      () => normalizeCustomSelections(seniorSpec, [{ category_key: 'ratio', level: 1, count: 1 }], { allowedCategory: () => false }),
      (e) => e.statusCode === 403 && e.code === 'PRACTICE_ACCESS_RESTRICTED'
    );
  });

  it('generates the chosen counts in paper order, easiest level first, with sheet-numbered ids', () => {
    const sel = [
      { category_key: 'subtraction', level: 3, count: 2 },
      { category_key: 'addition', level: 2, count: 3 },
      { category_key: 'addition', level: 1, count: 1 },
    ];
    const set = generateCustomSet(seniorSpec, normalizeCustomSelections(seniorSpec, sel), { seed: 7 });
    assert.deepEqual(
      set.privateQuestions.map((q) => q.id),
      ['addition_c1', 'addition_c2', 'addition_c3', 'addition_c4', 'subtraction_c1', 'subtraction_c2']
    );
    const levels = buildCustomLevels(seniorSpec);
    const addL1 = levels.find((c) => c.category_key === 'addition').levels[0].max_marks;
    const addL2 = levels.find((c) => c.category_key === 'addition').levels[1].max_marks;
    assert.equal(set.privateQuestions[0].max_marks, addL1);
    assert.ok(set.privateQuestions.slice(1, 4).every((q) => q.max_marks === addL2));
    assert.equal(set.total_max_marks, set.privateQuestions.reduce((n, q) => n + q.max_marks, 0));
    for (const q of set.publicQuestions) {
      assert.equal(q.answer_key, undefined, 'public questions carry no answer key');
    }
    const again = generateCustomSet(seniorSpec, normalizeCustomSelections(seniorSpec, sel), { seed: 7 });
    assert.deepEqual(again.publicQuestions, set.publicQuestions, 'seeded generation is repeatable');
  });

  it('a one-per-level set has one question for every official level', () => {
    const set = generateCustomSet(seniorSpec, normalizeCustomSelections(seniorSpec, selectionsFor(seniorSpec, 1)), { seed: 1 });
    const levelCount = buildCustomLevels(seniorSpec).reduce((n, c) => n + c.levels.length, 0);
    assert.equal(set.privateQuestions.length, levelCount);
  });
});

describe('sealed custom set tokens', () => {
  const set = generateCustomSet(seniorSpec, normalizeCustomSelections(seniorSpec, [{ category_key: 'addition', level: 1, count: 2 }]), { seed: 3 });
  const issuedAt = 1_800_000_000_000;
  const token = sealCustomSet({ studentId: STUDENT, groupKey: 'senior', paperId: 'p1', privateQuestions: set.privateQuestions, issuedAt }, SECRET);

  it('round-trips the private questions without exposing them in clear', () => {
    assert.ok(!token.includes('answer_key'));
    const opened = openCustomSet(token, SECRET, { studentId: STUDENT, nowMs: issuedAt + 1000 });
    assert.deepEqual(opened.privateQuestions, set.privateQuestions);
    assert.equal(opened.groupKey, 'senior');
  });

  it('rejects tampering, another student, a wrong secret and expiry', () => {
    const invalid = (fn) => assert.throws(fn, (e) => e.code === 'INVALID_CUSTOM_TOKEN' && e.statusCode === 400);
    const flipped = token.slice(0, 40) + (token[40] === 'A' ? 'B' : 'A') + token.slice(41);
    invalid(() => openCustomSet(flipped, SECRET, { studentId: STUDENT, nowMs: issuedAt }));
    invalid(() => openCustomSet(token, SECRET, { studentId: 'someone-else', nowMs: issuedAt }));
    invalid(() => openCustomSet(token, 'another-secret-value-0123456789', { studentId: STUDENT, nowMs: issuedAt }));
    invalid(() => openCustomSet(token, SECRET, { studentId: STUDENT, nowMs: issuedAt + CUSTOM_TOKEN_TTL_MS + 1 }));
    invalid(() => openCustomSet('short', SECRET, { studentId: STUDENT }));
  });

  it('refuses to seal or open without a configured secret', () => {
    assert.throws(
      () => sealCustomSet({ studentId: STUDENT, groupKey: 'senior', paperId: 'p1', privateQuestions: [], issuedAt }, ''),
      (e) => e.statusCode === 503 && e.code === 'CUSTOM_SET_UNCONFIGURED'
    );
  });
});

function createMockSupabase({ mainRound = { all: true, categories: [] }, writes }) {
  const builder = (table) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      in: () => b,
      single: () => b,
      insert: () => { writes.push(table); return b; },
      update: () => { writes.push(table); return b; },
      upsert: () => { writes.push(table); return b; },
      delete: () => { writes.push(table); return b; },
      then(resolve, reject) {
        let result = { data: null, error: null };
        if (table === 'profiles') {
          result = { data: { id: STUDENT, role: 'student', active: true, student_code: 'T1', full_name: 'Test', level: 1 }, error: null };
        } else if (table === 'jmcwc_papers') {
          result = {
            data: [{ id: 'paper-sr', group_key: 'senior', version: '2026.4', published: true, created_at: new Date().toISOString(), spec: seniorSpec }],
            error: null,
          };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    from: builder,
    rpc(fn) {
      if (fn === 'jmcwc_check_student') return Promise.resolve({ data: 'senior', error: null });
      if (fn === 'get_student_effective_access') {
        return Promise.resolve({
          data: { ok: true, student_id: STUDENT, main_round_eligible: true, settings: { main_round: mainRound } },
          error: null,
        });
      }
      writes.push(`rpc:${fn}`);
      return Promise.resolve({ data: null, error: null });
    },
    auth: { async getUser() { return { data: { user: { id: STUDENT } }, error: null }; } },
  };
}

async function call(handler, body) {
  let status = 0;
  let json = null;
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json(data) { json = data; return this; },
  };
  await handler({ method: 'POST', headers: { authorization: 'Bearer test' }, body }, res);
  return { status, json };
}

describe('custom set server actions', () => {
  it('lists options, creates a set and grades it without writing to the database', async () => {
    const writes = [];
    let now = 1_800_000_000_000;
    const handler = createJmcwcServer({
      getSupabaseAdmin: () => createMockSupabase({ writes }),
      getCustomSetSecret: () => SECRET,
      nowFn: () => now,
      seedGenerator: () => 11,
    });

    const opts = await call(handler, { action: 'custom_options' });
    assert.equal(opts.status, 200);
    assert.equal(opts.json.group_key, 'senior');
    assert.equal(opts.json.categories.length, 23);

    const created = await call(handler, {
      action: 'custom_create',
      selections: [
        { category_key: 'addition', level: 1, count: 2 },
        { category_key: 'calendar', level: 1, count: 1 },
      ],
    });
    assert.equal(created.status, 200);
    const set = created.json.custom_set;
    assert.equal(set.questions.length, 3);
    assert.ok(set.questions.every((q) => q.answer_key === undefined));
    assert.ok(!JSON.stringify(set.questions).includes('answer_key'));

    // Use the sealed private copy to answer the first question correctly.
    const priv = openCustomSet(set.token, SECRET, { studentId: STUDENT, nowMs: now }).privateQuestions;
    const first = priv[0];
    now += 60_000;
    const graded = await call(handler, {
      action: 'custom_grade',
      token: set.token,
      answers: { [first.id]: String(first.answer_key.value), not_in_set: '5' },
      active_ms: 61_000,
    });
    assert.equal(graded.status, 200);
    const result = graded.json.custom_result;
    assert.equal(result.mode, 'custom');
    assert.equal(result.status, 'submitted');
    assert.equal(result.active_ms, 61_000);
    assert.equal(result.score.max_marks, set.max_marks);
    assert.equal(result.score.correct, 1);
    assert.equal(result.score.skipped, 2);
    assert.equal(result.score.marks, first.max_marks);
    assert.equal(result.review.length, 3);
    assert.equal(result.review[0].verdict, 'correct');
    assert.equal(result.review.find((r) => r.id === 'not_in_set'), undefined);

    assert.deepEqual(writes, [], 'custom sets never write attempts, scores or history');
  });

  it('honours restricted main-round access and rejects expired tokens', async () => {
    const writes = [];
    let now = 1_800_000_000_000;
    const handler = createJmcwcServer({
      getSupabaseAdmin: () => createMockSupabase({ writes, mainRound: { all: false, categories: ['addition'] } }),
      getCustomSetSecret: () => SECRET,
      nowFn: () => now,
    });
    const opts = await call(handler, { action: 'custom_options' });
    assert.deepEqual(opts.json.categories.map((c) => c.category_key), ['addition']);

    const denied = await call(handler, { action: 'custom_create', selections: [{ category_key: 'ratio', level: 1, count: 1 }] });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'PRACTICE_ACCESS_RESTRICTED');

    const created = await call(handler, { action: 'custom_create', selections: [{ category_key: 'addition', level: 1, count: 1 }] });
    assert.equal(created.status, 200);
    now += CUSTOM_TOKEN_TTL_MS + 1;
    const expired = await call(handler, { action: 'custom_grade', token: created.json.custom_set.token, answers: {} });
    assert.equal(expired.status, 400);
    assert.equal(expired.json.code, 'INVALID_CUSTOM_TOKEN');
  });
});
