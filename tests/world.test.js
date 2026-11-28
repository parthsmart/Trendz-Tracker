/**
 * World layer: mascot growth and moods, journey stages, server-made boss and oral papers,
 * season windows and the /api/drill journey actions (api/_journey.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MASCOT_KINDS, MASCOTS, mascotForm, pickMascotMood, mascotLine, levelIndex,
  journeyStages, journeyState, STAGE_ORDER, STAGE_KINDS,
  BOSS_BLUEPRINTS, generateBossPaper, generateOralSet, publicQuestions, parseAnswer, gradePaper,
  SEASON_THEMES, seasonEnd, seasonBounds, validateSeasonDraft, BOSS_PASS_PERCENT,
} from '../shared/world.js';
import { mascotSvg, roundReactionHtml } from '../js/mascot.js';
import { handleJourneyStart, handleJourneySubmit, validateJourneyAnswers, ORAL_SETS_PER_HOUR } from '../api/_journey.js';

const LEVELS = ['KA-1', 'KA-2', 'KA-3', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6', 'Graduate', 'Master', 'Grandmaster'];
const SID = '11111111-2222-3333-4444-555555555555';

function fakeRes() {
  return {
    code: 0,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** A tiny stand-in for the service-role client: records calls, answers from `opts`. */
function fakeAdmin(opts = {}) {
  const calls = { rpc: [], insert: [], filters: [] };
  const client = {
    calls,
    rpc: async (fn, args) => {
      calls.rpc.push([fn, args]);
      return opts.rpc?.[fn] ? opts.rpc[fn](args) : { data: null, error: null };
    },
    from(table) {
      const q = {
        select(_c, o) { q.head = o?.head; return q; },
        eq(k, v) { calls.filters.push([table, k, v]); return q; },
        gte(k, v) { calls.filters.push([table, k, v]); return Promise.resolve({ count: opts.oralCount ?? 0, error: null }); },
        insert(row) { calls.insert.push(row); return q; },
        single: async () => ({ data: { id: SID }, error: null }),
        maybeSingle: async () => ({ data: opts.session ?? null, error: null }),
      };
      return q;
    },
  };
  return client;
}

describe('mascots', () => {
  it('has three mascots with a name for every level form', () => {
    assert.deepEqual([...MASCOT_KINDS], ['owl', 'bot', 'dragon']);
    for (const k of MASCOT_KINDS) assert.equal(MASCOTS[k].forms.length, 12);
  });

  it('grows across the 12 levels', () => {
    const forms = LEVELS.map((l) => mascotForm('dragon', l));
    assert.equal(forms[0].hatching, true);
    assert.equal(forms[11].crown, true);
    assert.equal(forms[9].cap, true);
    for (let i = 1; i < 12; i += 1) assert.ok(forms[i].scale > forms[i - 1].scale);
    assert.equal(levelIndex('Nope'), -1);
    assert.equal(mascotForm('unicorn', 'Level 1').kind, 'owl');
  });

  it('reacts to the round: best, mistakes, streak', () => {
    assert.equal(pickMascotMood({ correct: 5, total: 10, personalBest: true }), 'cheer');
    assert.equal(pickMascotMood({ correct: 4, total: 10 }), 'encourage');
    assert.equal(pickMascotMood({ correct: 9, total: 10 }), 'happy');
    assert.equal(pickMascotMood({ correct: 7, total: 10, streak: 3 }), 'happy');
    assert.equal(pickMascotMood({ correct: 7, total: 10 }), 'idle');
    assert.ok(mascotLine('encourage', 3).length > 0);
  });

  it('draws an SVG for every mascot, level, mood and outfit', () => {
    for (const kind of MASCOT_KINDS) {
      for (const level of LEVELS) {
        for (const mood of ['idle', 'happy', 'cheer', 'encourage']) {
          const svg = mascotSvg({ kind, level, mood, equipped: 'space' });
          assert.match(svg, /^<svg class="mascot-svg mascot-\w+ mood-\w+"/);
          assert.ok(!svg.includes('undefined') && !svg.includes('NaN'), `${kind} ${level} ${mood}`);
        }
      }
    }
    for (const theme of Object.keys(SEASON_THEMES)) assert.ok(mascotSvg({ kind: 'bot', level: 'Level 3', equipped: theme }).length > 500);
  });

  it('adds a reaction to the round card only when a mascot is picked', () => {
    const summary = { round: { correct: 3, total: 10 }, streak: { current: 0 } };
    assert.equal(roundReactionHtml(summary, null), '');
    const html = roundReactionHtml(summary, { kind: 'owl', level: 'Level 1' });
    assert.match(html, /data-mood="encourage"/);
    assert.match(html, /mascot-bubble/);
  });
});

describe('journey', () => {
  it('has six stages per level in the fixed order', () => {
    for (const l of LEVELS) {
      const s = journeyStages(l);
      assert.deepEqual(s.map((x) => x.kind), [...STAGE_ORDER]);
      for (const x of s) assert.ok(STAGE_KINDS[x.kind].href.startsWith('/pages/'));
    }
  });

  it('opens the boss at 5 cleared stages', () => {
    const stages = journeyStages('Level 2').map((s, i) => ({ ...s, done: i < 4 ? s.rounds_needed : 0 }));
    assert.equal(journeyState(stages).bossOpen, false);
    stages[4].done = stages[4].rounds_needed;
    const st = journeyState(stages);
    assert.equal(st.cleared, 5);
    assert.equal(st.bossOpen, true);
  });

  it('makes the same boss paper from the same seed, for every level', () => {
    for (const l of LEVELS) {
      assert.ok(BOSS_BLUEPRINTS[l], l);
      const a = generateBossPaper(l, 42);
      assert.deepEqual(a, generateBossPaper(l, 42));
      assert.ok(a.questions.length >= 10);
      const types = new Set(a.questions.map((q) => q.type));
      assert.ok(types.size >= 2, `${l} is a mixed paper`);
      for (const q of a.questions) assert.ok(Number.isInteger(q.answer), `${l} ${q.prompt}`);
    }
    assert.notDeepEqual(generateBossPaper('Level 2', 1).questions, generateBossPaper('Level 2', 2).questions);
  });

  it('never sends answers to the browser', () => {
    const p = generateOralSet('Level 1', 7);
    assert.equal(p.questions.length, 10);
    for (const q of publicQuestions(p.questions)) assert.deepEqual(Object.keys(q).sort(), ['n', 'prompt', 'type']);
  });

  it('marks papers on the server', () => {
    assert.equal(parseAnswer(' 1,234 '), 1234);
    assert.equal(parseAnswer('12a'), null);
    assert.equal(parseAnswer(''), null);
    const qs = [{ type: 'add', answer: 5 }, { type: 'add', answer: 7 }, { type: 'mul', answer: 12 }, { type: 'mul', answer: 1 }, { type: 'mul', answer: 2 }];
    const g = gradePaper(qs, ['5', 7, '12', '1', 'x']);
    assert.equal(g.correct, 4);
    assert.equal(g.percent, 80);
    assert.equal(g.passed, true);
    assert.deepEqual(g.by_type, { add: { correct: 2, total: 2 }, mul: { correct: 2, total: 3 } });
    assert.equal(gradePaper(qs, ['5']).passed, false);
  });
});

describe('seasons', () => {
  const seasons = [{ name: 'Space', starts_on: '2026-11-15', ends_on: seasonEnd('2026-11-15') }];

  it('lasts 8 weeks and clips the months around it', () => {
    assert.equal(seasonEnd('2026-11-15'), '2027-01-09');
    assert.deepEqual([seasonBounds('2026-11-05', seasons).from, seasonBounds('2026-11-05', seasons).to], ['2026-11-01', '2026-11-14']);
    assert.equal(seasonBounds('2026-12-31', seasons).themed, true);
    assert.equal(seasonBounds('2027-01-20', seasons).from, '2027-01-10');
    assert.equal(seasonBounds('2026-12-01', [{ ...seasons[0], status: 'cancelled' }]).from, '2026-12-01');
  });

  it('checks a draft the same way as the server', () => {
    const ctx = { today: '2026-11-10', seasons };
    assert.match(validateSeasonDraft({ name: '', theme: 'space', starts_on: '2027-02-01' }, ctx), /name/);
    assert.match(validateSeasonDraft({ name: 'X', theme: 'moon', starts_on: '2027-02-01' }, ctx), /theme/);
    assert.match(validateSeasonDraft({ name: 'X', theme: 'ocean', starts_on: '2026-11-10' }, ctx), /tomorrow/);
    assert.match(validateSeasonDraft({ name: 'X', theme: 'ocean', starts_on: '2026-12-01' }, ctx), /overlaps/);
    assert.equal(validateSeasonDraft({ name: 'Ocean', theme: 'ocean', starts_on: '2027-01-10' }, ctx), null);
  });
});

describe('/api/drill journey actions', () => {
  const student = { id: 'stu-1', level: 'Level 2' };

  it('starts a boss round only when the server says it is open', async () => {
    const closed = fakeAdmin({ rpc: { journey_boss_check: () => ({ data: { ok: false, reason: 'Clear 5 stages on this island first.' } }) } });
    let res = fakeRes();
    await handleJourneyStart({ body: { kind: 'boss' }, student, adminSupabase: closed, res });
    assert.equal(res.code, 409);
    assert.match(res.body.error, /Clear 5/);

    const open = fakeAdmin({ rpc: { journey_boss_check: () => ({ data: { ok: true, level: 'Level 2' } }) } });
    res = fakeRes();
    await handleJourneyStart({ body: { kind: 'boss' }, student, adminSupabase: open, res, now: Date.parse('2026-11-20T05:00:00Z'), seed: 9 });
    assert.equal(res.code, 200);
    assert.equal(res.body.session_id, SID);
    assert.equal(res.body.pass_percent, BOSS_PASS_PERCENT);
    assert.ok(res.body.questions.every((q) => !('answer' in q)));
    assert.ok(open.calls.insert[0].questions.every((q) => Number.isInteger(q.answer)));
  });

  it('limits oral sets per hour and needs a level', async () => {
    let res = fakeRes();
    await handleJourneyStart({ body: { kind: 'oral' }, student, adminSupabase: fakeAdmin({ oralCount: ORAL_SETS_PER_HOUR }), res });
    assert.equal(res.code, 429);
    res = fakeRes();
    await handleJourneyStart({ body: { kind: 'oral' }, student: { id: 's', level: null }, adminSupabase: fakeAdmin(), res });
    assert.equal(res.code, 409);
    res = fakeRes();
    await handleJourneyStart({ body: { kind: 'exam' }, student, adminSupabase: fakeAdmin(), res });
    assert.equal(res.code, 400);
  });

  it('checks the answers before loading anything', () => {
    assert.equal(validateJourneyAnswers(['1', 2, null]), true);
    assert.equal(validateJourneyAnswers('1,2'), false);
    assert.equal(validateJourneyAnswers([{}]), false);
    assert.equal(validateJourneyAnswers(['1'.repeat(30)]), false);
  });

  const paper = generateBossPaper('Level 2', 5).questions;
  const started = Date.parse('2026-11-20T05:00:00Z');
  const session = (over = {}) => ({
    id: SID, student_id: 'stu-1', kind: 'boss', level: 'Level 2', questions: paper, status: 'open',
    started_at: new Date(started).toISOString(), expires_at: new Date(started + 20 * 60000).toISOString(), ...over,
  });

  it('marks a paper on the server and saves it through journey_finish_session', async () => {
    const admin = fakeAdmin({ session: session(), rpc: { journey_finish_session: () => ({ data: { ok: true } }) } });
    const res = fakeRes();
    const answers = paper.map((q) => String(q.answer));
    answers[0] = '0';
    await handleJourneySubmit({ body: { session_id: SID, answers }, student, adminSupabase: admin, res, now: started + 5 * 60000 });
    assert.equal(res.code, 200);
    assert.equal(res.body.correct, paper.length - 1);
    assert.equal(res.body.review[0].correct, false);
    const [fn, args] = admin.calls.rpc[0];
    assert.equal(fn, 'journey_finish_session');
    assert.equal(args.p_correct, paper.length - 1);
    assert.equal(args.p_passed, res.body.passed);
    assert.deepEqual(admin.calls.filters.filter((f) => f[1] === 'student_id'), [['journey_sessions', 'student_id', 'stu-1']]);
  });

  it('refuses late, too-fast, repeated and unknown papers', async () => {
    const answers = paper.map((q) => String(q.answer));
    const go = async (s, now, extra = {}) => {
      const res = fakeRes();
      await handleJourneySubmit({ body: { session_id: SID, answers, ...extra }, student, adminSupabase: fakeAdmin({ session: s, rpc: { journey_finish_session: () => ({ data: { ok: false } }) } }), res, now });
      return res.code;
    };
    assert.equal(await go(session(), started + 22 * 60000), 409); // after the time limit
    assert.equal(await go(session(), started + 2000), 400); // faster than a second a question
    assert.equal(await go(session({ status: 'submitted' }), started + 5 * 60000), 409);
    assert.equal(await go(null, started + 5 * 60000), 404);
    assert.equal(await go(session(), started + 5 * 60000, { session_id: 'abc' }), 400);
    assert.equal(await go(session(), started + 5 * 60000), 409); // the database said it was already saved
  });
});
