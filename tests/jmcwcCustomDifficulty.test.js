import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import {
  CUSTOM_DIFFICULTIES,
  CUSTOM_MAX_PER_SHEET,
  difficultySlotPool,
  generateCustomSheetSet,
  normalizeCustomSheetRequest,
  openCustomSet,
} from '../api/_jmcwcCustom.js';
import { createJmcwcServer } from '../api/_jmcwcServer.js';
import {
  JMCWC_CUSTOM_DIFFICULTIES,
  JMCWC_CUSTOM_MAX_PER_SHEET,
  buildCustomSheetRequest,
  buildDefaultSheetCounts,
  clampSheetCount,
  normalizeCustomDifficulty,
  summarizeSheetCounts,
} from '../js/jmcwcPaper.js';

const SECRET = 'test-secret-for-custom-sets-0123456789';
const STUDENT = '00000000-0000-4000-8000-000000000001';
const seniorSpec = JMCWC_PAPERS.senior.spec;
const section = (key) => seniorSpec.sections.find((s) => s.key === key);
const slotMarks = (key) => new Map(section(key).questions.map((q) => [Number(q.slot), Number(q.max_marks)]));

describe('difficulty pools follow the top of each sheet', () => {
  const slots = Array.from({ length: 18 }, (_, i) => i + 1);

  it('easy is the first third, medium the first two thirds, hard the whole sheet', () => {
    assert.deepEqual(difficultySlotPool(slots, 'easy'), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(difficultySlotPool(slots, 'medium'), slots.slice(0, 12));
    assert.deepEqual(difficultySlotPool(slots, 'hard'), slots);
    assert.deepEqual(difficultySlotPool([1, 2], 'easy'), [1]);
    assert.deepEqual(difficultySlotPool([4], 'easy'), [4]);
    assert.deepEqual(difficultySlotPool([], 'hard'), []);
  });
});

describe('sheet + difficulty requests', () => {
  it('validates difficulty, sheets, counts and access', () => {
    const bad = (body, code = 'INVALID_CUSTOM_SET', status = 400) =>
      assert.throws(
        () => normalizeCustomSheetRequest(seniorSpec, body, { allowedCategory: (k) => k !== 'ratio' }),
        (e) => e.code === code && e.statusCode === status
      );
    bad({ difficulty: 'expert', sheets: [{ category_key: 'addition', count: 5 }] });
    bad({ difficulty: 'easy', sheets: [] });
    bad({ difficulty: 'easy', sheets: [{ category_key: 'nope', count: 1 }] });
    bad({ difficulty: 'easy', sheets: [{ category_key: 'addition', count: CUSTOM_MAX_PER_SHEET + 1 }] });
    bad({ difficulty: 'easy', sheets: [{ category_key: 'addition', count: 2.5 }] });
    bad({ difficulty: 'easy', sheets: [{ category_key: 'addition', count: 0 }] });
    bad({ difficulty: 'easy', sheets: [{ category_key: 'addition', count: 1 }, { category_key: 'addition', count: 1 }] });
    const everySheet = seniorSpec.sections
      .filter((s) => s.key !== 'ratio')
      .map((s) => ({ category_key: s.key, count: CUSTOM_MAX_PER_SHEET }));
    bad({ difficulty: 'hard', sheets: everySheet }); // 22 x 20 > 150
    bad({ difficulty: 'easy', sheets: [{ category_key: 'ratio', count: 1 }] }, 'PRACTICE_ACCESS_RESTRICTED', 403);
    assert.deepEqual(CUSTOM_DIFFICULTIES, ['easy', 'medium', 'hard']);
  });

  it('easy picks only from the top of the sheet and keeps paper order', () => {
    const marks = slotMarks('addition');
    const easyPool = difficultySlotPool([...marks.keys()].sort((a, b) => a - b), 'easy');
    const easyMax = Math.max(...easyPool.map((s) => marks.get(s)));
    for (let seed = 1; seed <= 25; seed += 1) {
      const req = normalizeCustomSheetRequest(seniorSpec, { difficulty: 'easy', sheets: [{ category_key: 'addition', count: 5 }] });
      const set = generateCustomSheetSet(seniorSpec, req, { seed });
      assert.equal(set.privateQuestions.length, 5);
      assert.deepEqual(set.privateQuestions.map((q) => q.id), [1, 2, 3, 4, 5].map((n) => `addition_c${n}`));
      const qMarks = set.privateQuestions.map((q) => Number(q.max_marks));
      assert.ok(qMarks.every((m) => m <= easyMax), `easy stays at the top: ${qMarks}`);
      for (let i = 1; i < qMarks.length; i += 1) assert.ok(qMarks[i] >= qMarks[i - 1], `paper order: ${qMarks}`);
    }
  });

  it('hard can reach the end of the sheet, medium never does', () => {
    const marks = slotMarks('addition');
    const top = Math.max(...marks.values());
    let hardHitTop = false;
    for (let seed = 1; seed <= 40; seed += 1) {
      const hard = generateCustomSheetSet(
        seniorSpec,
        normalizeCustomSheetRequest(seniorSpec, { difficulty: 'hard', sheets: [{ category_key: 'addition', count: 10 }] }),
        { seed }
      );
      if (hard.privateQuestions.some((q) => Number(q.max_marks) === top)) hardHitTop = true;
      const medium = generateCustomSheetSet(
        seniorSpec,
        normalizeCustomSheetRequest(seniorSpec, { difficulty: 'medium', sheets: [{ category_key: 'addition', count: 10 }] }),
        { seed }
      );
      assert.ok(medium.privateQuestions.every((q) => Number(q.max_marks) < top));
    }
    assert.ok(hardHitTop, 'hard draws from the whole sheet');
  });

  it('orders sheets like the paper and allows more questions than the pool', () => {
    const req = normalizeCustomSheetRequest(seniorSpec, {
      difficulty: 'easy',
      sheets: [{ category_key: 'subtraction', count: 2 }, { category_key: 'addition', count: 12 }],
    });
    const set = generateCustomSheetSet(seniorSpec, req, { seed: 4 });
    assert.equal(set.privateQuestions.length, 14);
    assert.ok(set.privateQuestions.slice(0, 12).every((q) => q.id.startsWith('addition_')));
    assert.ok(set.privateQuestions.slice(12).every((q) => q.id.startsWith('subtraction_')));
    assert.ok(set.publicQuestions.every((q) => q.answer_key === undefined));
  });
});

describe('client sheet builder helpers', () => {
  const options = [{ category_key: 'addition' }, { category_key: 'calendar' }];

  it('defaults, clamps and summarizes sheet counts', () => {
    assert.deepEqual(buildDefaultSheetCounts(options), { addition: 5, calendar: 5 });
    assert.equal(clampSheetCount(99), JMCWC_CUSTOM_MAX_PER_SHEET);
    assert.equal(clampSheetCount(-1), 0);
    assert.equal(clampSheetCount('3.7'), 3);
    assert.deepEqual(summarizeSheetCounts(options, { addition: 5, calendar: 0 }), { questions: 5, sheets: 1, over_limit: false });
    assert.equal(normalizeCustomDifficulty('HARD'), 'hard');
    assert.equal(normalizeCustomDifficulty('x'), 'easy');
    assert.deepEqual(JMCWC_CUSTOM_DIFFICULTIES.map((d) => d.key), CUSTOM_DIFFICULTIES);
    assert.equal(JMCWC_CUSTOM_MAX_PER_SHEET, CUSTOM_MAX_PER_SHEET);
  });

  it('builds the request without empty sheets', () => {
    assert.deepEqual(buildCustomSheetRequest(options, { addition: 0, calendar: 4 }, 'medium'), {
      difficulty: 'medium',
      sheets: [{ category_key: 'calendar', count: 4 }],
    });
  });
});

function mockSupabase(writes) {
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
          data: { ok: true, student_id: STUDENT, main_round_eligible: true, settings: { main_round: { all: true, categories: [] } } },
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

describe('server accepts sheet + difficulty sets', () => {
  it('lists per-sheet limits and creates an easy set without writes', async () => {
    const writes = [];
    const now = 1_800_000_000_000;
    const handler = createJmcwcServer({
      getSupabaseAdmin: () => mockSupabase(writes),
      getCustomSetSecret: () => SECRET,
      nowFn: () => now,
      seedGenerator: () => 5,
    });
    const opts = await call(handler, { action: 'custom_options' });
    assert.equal(opts.status, 200);
    assert.equal(opts.json.max_per_sheet, CUSTOM_MAX_PER_SHEET);
    assert.deepEqual(opts.json.difficulties, CUSTOM_DIFFICULTIES);
    assert.equal(opts.json.categories.find((c) => c.category_key === 'addition').official_questions, 18);

    const created = await call(handler, { action: 'custom_create', difficulty: 'easy', sheets: [{ category_key: 'addition', count: 5 }] });
    assert.equal(created.status, 200);
    assert.equal(created.json.custom_set.difficulty, 'easy');
    assert.equal(created.json.custom_set.questions.length, 5);
    const priv = openCustomSet(created.json.custom_set.token, SECRET, { studentId: STUDENT, nowMs: now }).privateQuestions;
    assert.equal(priv.length, 5);

    const bad = await call(handler, { action: 'custom_create', difficulty: 'nope', sheets: [{ category_key: 'addition', count: 5 }] });
    assert.equal(bad.status, 400);
    assert.deepEqual(writes, []);
  });
});
