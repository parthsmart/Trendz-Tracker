/**
 * Fair-play guardrails.
 *
 *  - shared/fairPlay.js: thresholds, reject vs flag, time mismatch, big jumps, rate limits;
 *  - api/_fairPlay.js: review opening and rate limits against a fake client;
 *  - migration 42 on PGlite: typed-score flagging, status guard, review queue scoping,
 *    void removes XP (and blocks re-award), restore puts it back, audit trail, rate limits,
 *    board patching, and the rollback;
 *  - page helpers (js/fairPlayReview.js) and the student notice (js/fairPlayNotice.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  DEFAULT_FAIR_PLAY_THRESHOLDS,
  UNDER_REVIEW_MESSAGE,
  assessAttempt,
  rateLimitDecision,
  resolveThreshold,
  studentReviewLabel,
} from '../shared/fairPlay.js';
import { checkRateLimit, clearFairPlayCache, loadFairPlayThresholds, reviewAfterSave } from '../api/_fairPlay.js';
import { describeDetail, renderQueueHtml, renderThresholdsHtml } from '../js/fairPlayReview.js';
import { fairPlayNoticeText } from '../js/fairPlayNotice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION = read('supabase/migrations/42_fair_play_guardrails.sql');
const ROLLBACK = read('supabase/rollbacks/42_fair_play_guardrails_rollback.sql');

describe('shared fair-play checker', () => {
  it('picks the most specific threshold row', () => {
    assert.equal(resolveThreshold('memoriad', 'multiplications', '8').flag_spq, 25);
    assert.equal(resolveThreshold('memoriad', 'multiplications', '5').flag_spq, 10);
    assert.equal(resolveThreshold('memoriad', 'division', '7').reject_spq, 3);
    assert.equal(resolveThreshold('element', 'day_codes', '*').flag_spq, 0.6);
    assert.equal(resolveThreshold('nope', '*', '*').source, 'none');
    const rows = [{ kind: 'element', key: 'day_codes', level: '*', reject_spq: 0.3, flag_spq: 1, max_correct: null }];
    assert.equal(resolveThreshold('element', 'day_codes', '*', rows).flag_spq, 1);
    // Table rows fall back to defaults for kinds they do not cover.
    assert.equal(resolveThreshold('basics', '*', '*', rows).flag_spq, 0.5);
    // A disabled row is skipped.
    assert.equal(resolveThreshold('element', 'day_codes', '*', [{ ...rows[0], enabled: false }]).flag_spq, 0.6);
  });

  it('rejects only the impossible and flags the unusually fast', () => {
    // 40 answers in 8 s = 0.2 s each: impossible.
    assert.equal(assessAttempt({ kind: 'basics', attempted: 40, correct: 40, usedSeconds: 8 }).verdict, 'reject');
    // Fastest honest run in production: 0.60 s a question.
    assert.equal(assessAttempt({ kind: 'basics', attempted: 100, correct: 100, usedSeconds: 60 }).verdict, 'ok');
    const fast = assessAttempt({ kind: 'basics', attempted: 150, correct: 150, usedSeconds: 60 });
    assert.equal(fast.verdict, 'flag');
    assert.deepEqual(fast.reasons, ['too_fast']);
    // Fast wrong answers are not suspicious.
    assert.equal(assessAttempt({ kind: 'basics', attempted: 150, correct: 10, usedSeconds: 60 }).verdict, 'ok');
    // Memoriad 8-digit multiplications: 10 in 120 s is flagged, 10 in 400 s is fine.
    assert.equal(assessAttempt({ kind: 'memoriad', key: 'multiplications', level: 8, attempted: 10, correct: 10, usedSeconds: 120 }).verdict, 'flag');
    assert.equal(assessAttempt({ kind: 'memoriad', key: 'multiplications', level: 8, attempted: 10, correct: 10, usedSeconds: 400 }).verdict, 'ok');
    // Flash has no time threshold.
    assert.equal(assessAttempt({ kind: 'flash', attempted: 10, correct: 10, usedSeconds: 1 }).verdict, 'ok');
    // Nothing attempted.
    assert.equal(assessAttempt({ kind: 'basics', attempted: 0, correct: 0, usedSeconds: 0 }).verdict, 'ok');
  });

  it('flags typed scores above the max', () => {
    const r = assessAttempt({ kind: 'typed_round', attempted: 250, correct: 220, usedSeconds: 600 });
    assert.deepEqual(r.reasons, ['over_max']);
  });

  it('allows honest clock lag but flags a browser time far below the server clock', () => {
    // Worst honest gap seen: about 37 s.
    assert.equal(assessAttempt({ kind: 'element', attempted: 30, correct: 30, usedSeconds: 60, serverSeconds: 97 }).verdict, 'ok');
    const r = assessAttempt({ kind: 'element', attempted: 30, correct: 30, usedSeconds: 60, serverSeconds: 180 });
    assert.deepEqual(r.reasons, ['time_mismatch']);
    // A large gap that is a small share of a long round is fine.
    assert.equal(assessAttempt({ kind: 'memoriad', key: 'additions', attempted: 10, correct: 10, usedSeconds: 550, serverSeconds: 600 }).verdict, 'ok');
  });

  it('flags a big jump only with enough history', () => {
    const base = { kind: 'element', attempted: 30, correct: 30, usedSeconds: 60 };
    assert.deepEqual(assessAttempt({ ...base, previousBest: 15, score: 30 }).reasons, ['big_jump']);
    assert.equal(assessAttempt({ ...base, previousBest: 25, score: 30 }).verdict, 'ok');
    assert.equal(assessAttempt({ ...base, previousBest: 5, score: 30 }).verdict, 'ok');
  });

  it('decides rate limits and student labels', () => {
    assert.equal(rateLimitDecision('practice_start', 59).allowed, true);
    assert.equal(rateLimitDecision('practice_start', 60).allowed, false);
    assert.equal(rateLimitDecision('practice_start', 60).retryAfterSeconds, 600);
    assert.equal(rateLimitDecision('unknown', 9999).allowed, true);
    assert.equal(rateLimitDecision('reward_claim', 3, { reward_claim: { limit: 3, windowSeconds: 60 } }).allowed, false);
    assert.equal(studentReviewLabel('review'), 'Under review');
    assert.equal(studentReviewLabel('voided'), 'Not counted');
    assert.equal(studentReviewLabel('approved'), '');
  });

  it('keeps the migration seed in step with the JS defaults', () => {
    for (const t of DEFAULT_FAIR_PLAY_THRESHOLDS) {
      const v = (x) => (x === null ? 'NULL' : String(x));
      const row = `('${t.kind}', '${t.key}', '${t.level}', ${v(t.reject_spq)}, ${v(t.flag_spq)}, ${v(t.max_correct)}`;
      assert.ok(MIGRATION.includes(row), `migration seeds ${row}`);
    }
  });

  it('student wording never accuses', () => {
    assert.doesNotMatch(UNDER_REVIEW_MESSAGE, /cheat|suspicious|fake|impossible/i);
    assert.equal(fairPlayNoticeText({ under_review: true }), UNDER_REVIEW_MESSAGE);
    assert.equal(fairPlayNoticeText({ under_review: true, review_message: 'Saved!' }), 'Saved!');
    assert.equal(fairPlayNoticeText({ saved: true }), '');
  });
});

function fakeDb({ xp = [], rpcResult = {} } = {}) {
  const calls = [];
  const query = (rows) => {
    const q = {
      filters: [],
      select() { return q; },
      eq(c, v) { q.filters.push((r) => String(r[c]) === String(v)); return q; },
      neq(c, v) { q.filters.push((r) => String(r[c]) !== String(v)); return q; },
      lt(c, v) { q.filters.push((r) => r[c] < v); return q; },
      order(c) { q.sortBy = c; return q; },
      limit(n) {
        const out = rows.filter((r) => q.filters.every((f) => f(r))).sort((a, b) => b[q.sortBy] - a[q.sortBy]);
        return Promise.resolve({ data: out.slice(0, n), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: rows.find((r) => q.filters.every((f) => f(r))) || null, error: null });
      },
      then(res) { return res({ data: rows, error: null }); },
    };
    return q;
  };
  return {
    calls,
    from(t) { return query(t === 'student_xp_events' ? xp : []); },
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve(rpcResult[name] ?? { data: 1, error: null });
    },
  };
}

describe('api fair-play helper', () => {
  it('opens a review only when flagged and reports under_review', async () => {
    const db = fakeDb();
    const ok = await reviewAfterSave(db, {
      studentId: 's1', sourceTable: 'activity_results', sourceId: 'a1',
      verdict: assessAttempt({ kind: 'element', attempted: 20, correct: 20, usedSeconds: 40 }),
      attempt: { kind: 'element', attempted: 20, correct: 20, usedSeconds: 40 },
    });
    assert.deepEqual(ok, { under_review: false });
    assert.equal(db.calls.length, 0);

    const attempt = { kind: 'element', key: 'day_codes', attempted: 100, correct: 100, usedSeconds: 40 };
    const flagged = await reviewAfterSave(db, {
      studentId: 's1', sourceTable: 'activity_results', sourceId: 'a2', verdict: assessAttempt(attempt), attempt, label: 'Day codes',
    });
    assert.equal(flagged.under_review, true);
    assert.equal(flagged.message, UNDER_REVIEW_MESSAGE);
    assert.equal(db.calls[0].name, 'fair_play_open_review');
    assert.deepEqual(db.calls[0].args.p_reasons, ['too_fast']);
    assert.equal(db.calls[0].args.p_detail.correct, 100);
  });

  it('adds the big-jump check from earlier XP rows', async () => {
    const xp = [
      { source: 'activity', source_id: 'old', student_id: 's1', activity_key: 'el:x:60', pb_score: 12, created_at: '2026-11-01' },
      { source: 'activity', source_id: 'new', student_id: 's1', activity_key: 'el:x:60', pb_score: 30, created_at: '2026-11-20' },
    ];
    const db = fakeDb({ xp });
    const attempt = { kind: 'element', attempted: 30, correct: 30, usedSeconds: 60 };
    const r = await reviewAfterSave(db, { studentId: 's1', sourceTable: 'activity_results', sourceId: 'new', verdict: assessAttempt(attempt), attempt });
    assert.equal(r.under_review, true);
    assert.deepEqual(db.calls[0].args.p_reasons, ['big_jump']);
  });

  it('never blocks a save when the database errors', async () => {
    const db = fakeDb({ rpcResult: { fair_play_open_review: { data: null, error: { message: 'boom' } } } });
    const attempt = { kind: 'element', attempted: 100, correct: 100, usedSeconds: 40 };
    assert.deepEqual(
      await reviewAfterSave(db, { studentId: 's', sourceTable: 'activity_results', sourceId: 'x', verdict: assessAttempt(attempt) }),
      { under_review: false }
    );
    const denied = fakeDb({ rpcResult: { fair_play_rate_hit: { data: false, error: null } } });
    assert.equal((await checkRateLimit(denied, 's', 'reward_claim')).allowed, false);
    const broken = fakeDb({ rpcResult: { fair_play_rate_hit: { data: null, error: { message: 'x' } } } });
    assert.equal((await checkRateLimit(broken, 's', 'reward_claim')).allowed, true);
  });

  it('falls back to default thresholds', async () => {
    clearFairPlayCache();
    const db = { from() { return { select: () => Promise.resolve({ data: null, error: { message: 'no table' } }) }; } };
    assert.equal(await loadFairPlayThresholds(db), DEFAULT_FAIR_PLAY_THRESHOLDS);
  });
});

describe('review page helpers', () => {
  it('renders the queue, escapes names and shows counts only', () => {
    const html = renderQueueHtml([
      { id: 7, student_name: '<b>Asha</b>', student_code: 'T01', level: 'Level 2', kind: 'element', label: 'Day codes',
        reasons: ['too_fast'], detail: { correct: 90, attempted: 92, used_seconds: 50, seconds_per_question: 0.54 },
        status: 'open', xp: 40, created_at: '2026-11-28T10:00:00Z' },
    ], 'open');
    assert.match(html, /&lt;b&gt;Asha&lt;\/b&gt;/);
    assert.match(html, /data-fp-decide="approve" data-id="7"/);
    assert.match(html, /data-fp-decide="void"/);
    assert.match(html, /Faster per question/);
    assert.match(renderQueueHtml([], 'open'), /Nothing waiting/);
    const voided = renderQueueHtml([{ id: 8, status: 'voided', detail: {} }], 'voided');
    assert.match(voided, /Restore/);
    assert.doesNotMatch(voided, /data-fp-decide="void"/);
    assert.equal(describeDetail({ correct: 5, total: 6, seconds: 12 }), '5 correct of 6 · 12 s');
  });

  it('renders the thresholds editor', () => {
    const html = renderThresholdsHtml([{ kind: 'basics', key: '*', level: '*', reject_spq: 0.25, flag_spq: 0.5, max_correct: null }]);
    assert.match(html, /data-kind="basics"/);
    assert.match(html, /name="flag_spq" value="0.5"/);
    assert.match(html, /name="max_correct" value=""/);
  });
});

// ---------------------------------------------------------------------------
// Migration on PGlite
// ---------------------------------------------------------------------------
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const U = { ADMIN: id(1), HEAD_A: id(2), TCH_A: id(3), STU_A: id(4), STU_B: id(5), HEAD_B: id(6), CAT_ROUND: id(50), CAT_BASICS: id(51) };

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, student_code text, full_name text, role text, level text, centre_id int);
  CREATE TABLE public.centre_heads (head uuid, centre_id int);
  CREATE TABLE public.assignments (teacher uuid, student uuid);
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND centre_id IS NULL) $$;
  CREATE FUNCTION public.can_manage_profile(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT public.is_admin() OR EXISTS (SELECT 1 FROM public.centre_heads h JOIN public.profiles s ON s.centre_id = h.centre_id
                                               WHERE h.head = auth.uid() AND s.id = p) $$;
  CREATE FUNCTION public.is_teacher(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = u AND role = 'teacher') $$;
  CREATE FUNCTION public.is_teacher_assigned_to_student(t uuid, s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT EXISTS (SELECT 1 FROM public.assignments WHERE teacher = t AND student = s) $$;

  CREATE TABLE public.categories (id uuid PRIMARY KEY, name text, section text);
  CREATE TABLE public.results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, category_id uuid, correct int, total int,
    time_seconds int, entry_date date DEFAULT current_date, verified boolean DEFAULT false, source text,
    created_at timestamptz DEFAULT now());
  CREATE TABLE public.activity_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, activity_type text, activity_name text,
    correct int, total int, time_seconds int, settings jsonb, created_at timestamptz DEFAULT now());
  CREATE TABLE public.student_xp_events (
    id bigserial PRIMARY KEY, student_id uuid, source text, source_id text, activity_key text, xp int,
    pb_score numeric, created_at timestamptz DEFAULT now(), UNIQUE (source, source_id));
  CREATE TABLE public.drill_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, started_at timestamptz DEFAULT now());
  CREATE TABLE public.reward_redemptions (id bigserial PRIMARY KEY, student_id uuid, cost int, requested_at timestamptz DEFAULT now());

  -- XP the way the real triggers do it: an activity row earns XP at once.
  CREATE FUNCTION public.stub_xp() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN
    INSERT INTO public.student_xp_events (student_id, source, source_id, activity_key, xp, pb_score)
    VALUES (NEW.student_id, 'activity', NEW.id::text, 'el:test', 10 + NEW.correct, NEW.correct)
    ON CONFLICT (source, source_id) DO UPDATE SET xp = EXCLUDED.xp;
    RETURN NEW;
  END $$;
  CREATE TRIGGER trg_stub_xp AFTER INSERT OR UPDATE OF correct ON public.activity_results FOR EACH ROW EXECUTE FUNCTION public.stub_xp();

  -- Simplified board functions with the same FROM shapes as production.
  CREATE FUNCTION public.practice_highest_records(p_section text, p_filters jsonb) RETURNS TABLE(student_id uuid, best int)
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT ar.student_id, max(ar.correct) FROM public.activity_results ar GROUP BY ar.student_id
    UNION ALL
    SELECT r.student_id, max(r.correct) FROM public.results r GROUP BY r.student_id
  $$;
  CREATE FUNCTION public.leaderboard(p_board text, p_period text, p_level text, p_limit integer, p_scope text)
  RETURNS TABLE(student_id uuid, n bigint) LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT r.student_id, count(*) FROM public.results r GROUP BY r.student_id
  $$;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
  ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
  CREATE POLICY results_own ON public.results FOR ALL TO authenticated
    USING (student_id = auth.uid()) WITH CHECK (student_id = auth.uid());
`;

const SEED = `
  INSERT INTO public.profiles VALUES
    ('${U.ADMIN}', NULL, 'Owner', 'admin', NULL, NULL),
    ('${U.HEAD_A}', NULL, 'Head A', 'admin', NULL, 1),
    ('${U.TCH_A}', NULL, 'Teacher A', 'teacher', NULL, 1),
    ('${U.STU_A}', 'A1', 'Student A', 'student', 'Level 1', 1),
    ('${U.STU_B}', 'B1', 'Student B', 'student', 'Level 1', 2),
    ('${U.HEAD_B}', NULL, 'Head B', 'admin', NULL, 2);
  INSERT INTO public.centre_heads VALUES ('${U.HEAD_A}', 1), ('${U.HEAD_B}', 2);
  INSERT INTO public.assignments VALUES ('${U.TCH_A}', '${U.STU_A}');
  INSERT INTO public.categories VALUES ('${U.CAT_ROUND}', 'Round 1', 'rounds'), ('${U.CAT_BASICS}', 'Add 1d', 'basics');
`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(SEED);
  await db.exec(MIGRATION);
  return db;
}

async function as(db, uid, role, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`);
  }
}
const asService = (db, sql, params) => as(db, null, 'service_role', sql, params);

async function flagActivity(db, student, correct = 100) {
  const { rows } = await asService(db,
    `INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds)
     VALUES ($1, 'element', 'Day codes', $2, $2, 40) RETURNING id`, [student, correct]);
  const sourceId = rows[0].id;
  const r = await asService(db,
    `SELECT public.fair_play_open_review($1, 'activity_results', $2, 'element', 'day_codes', 'Day codes',
       ARRAY['too_fast'], '{"correct": 100}'::jsonb) AS id`, [student, sourceId]);
  return { sourceId, reviewId: r.rows[0].id };
}

describe('migration 42 on PGlite', () => {
  it('flags implausible typed scores and keeps the status out of students’ hands', async () => {
    const db = await freshDb();
    // 120 correct in 30 s: under the 0.3 s typed-round flag.
    const { rows } = await as(db, U.STU_A, 'authenticated',
      `INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, fair_play_status)
       VALUES ($1, $2, 120, 120, 30, 'approved') RETURNING id, fair_play_status`, [U.STU_A, U.CAT_ROUND]);
    assert.equal(rows[0].fair_play_status, 'review', 'student cannot self-approve; the score is flagged');
    const rev = await db.query(`SELECT kind, reasons, status FROM public.fair_play_reviews WHERE source_id = $1`, [rows[0].id]);
    assert.equal(rev.rows[0].kind, 'typed_round');
    assert.deepEqual(rev.rows[0].reasons, ['too_fast']);
    assert.equal(rev.rows[0].status, 'open');
    const audits = await db.query(`SELECT count(*)::int AS n FROM public.fair_play_audit WHERE action = 'opened'`);
    assert.equal(audits.rows[0].n, 1, 'one review opened, no recursion');

    // A normal typed score is untouched.
    const ok = await as(db, U.STU_A, 'authenticated',
      `INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
       VALUES ($1, $2, 40, 50, 300) RETURNING fair_play_status`, [U.STU_A, U.CAT_BASICS]);
    assert.equal(ok.rows[0].fair_play_status, null);

    // Over the typed-basics max.
    const big = await as(db, U.STU_A, 'authenticated',
      `INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
       VALUES ($1, $2, 160, 160, 600) RETURNING fair_play_status`, [U.STU_A, U.CAT_BASICS]);
    assert.equal(big.rows[0].fair_play_status, 'review');

    // The student cannot clear the status by editing.
    const upd = await as(db, U.STU_A, 'authenticated',
      `UPDATE public.results SET fair_play_status = NULL, note_dummy = NULL WHERE id = $1 RETURNING fair_play_status`,
      [rows[0].id]).catch(() => null);
    assert.equal(upd, null, 'unknown column rejected');
    const upd2 = await as(db, U.STU_A, 'authenticated',
      `UPDATE public.results SET fair_play_status = NULL WHERE id = $1 RETURNING fair_play_status`, [rows[0].id]);
    assert.equal(upd2.rows[0].fair_play_status, 'review');

    // Site (server-graded) rows are not assessed by the trigger.
    const site = await asService(db,
      `INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, source)
       VALUES ($1, $2, 500, 500, 10, 'site') RETURNING fair_play_status`, [U.STU_A, U.CAT_BASICS]);
    assert.equal(site.rows[0].fair_play_status, null);
  });

  it('scopes the queue to admins, own-centre heads and assigned teachers', async () => {
    const db = await freshDb();
    await flagActivity(db, U.STU_A);
    await flagActivity(db, U.STU_B);
    const count = async (uid) =>
      (await as(db, uid, 'authenticated', `SELECT count(*)::int AS n FROM public.fair_play_queue('open', 100)`)).rows[0].n;
    assert.equal(await count(U.ADMIN), 2);
    assert.equal(await count(U.HEAD_A), 1);
    assert.equal(await count(U.HEAD_B), 1);
    assert.equal(await count(U.TCH_A), 1);
    assert.equal(await count(U.STU_A), 0, 'a student never reviews, not even themself');
    const q = await as(db, U.TCH_A, 'authenticated', `SELECT student_id, xp FROM public.fair_play_queue('open', 100)`);
    assert.equal(q.rows[0].student_id, U.STU_A);
    assert.equal(q.rows[0].xp, 110, 'XP counts while under review');
    // Students cannot read the tables directly.
    await assert.rejects(as(db, U.STU_A, 'authenticated', `SELECT * FROM public.fair_play_audit`).then((r) => {
      if (r.rows.length === 0) throw new Error('no rows');
    }));
  });

  it('voids (removing XP and blocking re-award), restores, and audits', async () => {
    const db = await freshDb();
    const { sourceId, reviewId } = await flagActivity(db, U.STU_A);
    // Head of the other centre cannot decide.
    await assert.rejects(
      as(db, U.HEAD_B, 'authenticated', `SELECT public.fair_play_decide($1, 'void', 'x')`, [reviewId]),
      /Review not found/
    );
    const v = await as(db, U.HEAD_A, 'authenticated', `SELECT public.fair_play_decide($1, 'void', 'Checked with class') AS r`, [reviewId]);
    assert.equal(v.rows[0].r.status, 'voided');
    assert.equal(v.rows[0].r.xp_rows_removed, 1);
    const xp = async () => (await db.query(`SELECT count(*)::int AS n FROM public.student_xp_events WHERE source_id = $1`, [sourceId])).rows[0].n;
    assert.equal(await xp(), 0);
    const st = await db.query(`SELECT fair_play_status FROM public.activity_results WHERE id = $1`, [sourceId]);
    assert.equal(st.rows[0].fair_play_status, 'voided');

    // A later edit cannot bring the XP back.
    await asService(db, `UPDATE public.activity_results SET correct = 99 WHERE id = $1`, [sourceId]);
    assert.equal(await xp(), 0);

    // Boards skip voided rows.
    const boards = await as(db, U.STU_B, 'authenticated', `SELECT * FROM public.practice_highest_records('x', '{}')`);
    assert.equal(boards.rows.filter((r) => r.student_id === U.STU_A && r.best !== null).length, 0);

    // The student sees a neutral status.
    const mine = await as(db, U.STU_A, 'authenticated', `SELECT status FROM public.my_fair_play_reviews()`);
    assert.deepEqual(mine.rows.map((r) => r.status), ['voided']);

    // Restore.
    const a = await as(db, U.ADMIN, 'authenticated', `SELECT public.fair_play_decide($1, 'approve', 'Mistake') AS r`, [reviewId]);
    assert.equal(a.rows[0].r.status, 'approved');
    assert.equal(a.rows[0].r.xp_rows_restored, 1);
    assert.equal(await xp(), 1);
    const back = await db.query(`SELECT xp FROM public.student_xp_events WHERE source_id = $1`, [sourceId]);
    assert.equal(back.rows[0].xp, 110, 'the original XP amount comes back');

    const hist = await as(db, U.TCH_A, 'authenticated', `SELECT action, actor_name, note FROM public.fair_play_history($1)`, [reviewId]);
    assert.deepEqual(hist.rows.map((h) => h.action), ['opened', 'voided', 'restored']);
    assert.equal(hist.rows[1].actor_name, 'Head A');
    assert.equal(hist.rows[1].note, 'Checked with class');
    // Repeating a decision changes nothing.
    const again = await as(db, U.ADMIN, 'authenticated', `SELECT public.fair_play_decide($1, 'approve') AS r`, [reviewId]);
    assert.equal(again.rows[0].r.changed, false);
  });

  it('hides results under review from other students but not from their owner', async () => {
    const db = await freshDb();
    await flagActivity(db, U.STU_A, 77);
    const other = await as(db, U.STU_B, 'authenticated', `SELECT best FROM public.practice_highest_records('x', '{}') WHERE student_id = $1`, [U.STU_A]);
    assert.equal(other.rows.length, 0);
    const own = await as(db, U.STU_A, 'authenticated', `SELECT best FROM public.practice_highest_records('x', '{}') WHERE student_id = $1`, [U.STU_A]);
    assert.equal(own.rows[0].best, 77);
  });

  it('only admins edit thresholds, and edits are audited', async () => {
    const db = await freshDb();
    await assert.rejects(
      as(db, U.TCH_A, 'authenticated', `SELECT public.fair_play_threshold_save('basics', '*', '*', 0.25, 0.4, NULL, true, NULL)`),
      /Only an admin/
    );
    await as(db, U.ADMIN, 'authenticated', `SELECT public.fair_play_threshold_save('basics', '*', '*', 0.25, 0.4, NULL, true, 'tuned')`);
    const t = await db.query(`SELECT flag_spq FROM public.fair_play_thresholds WHERE kind = 'basics' AND key = '*' AND level = '*'`);
    assert.equal(Number(t.rows[0].flag_spq), 0.4);
    const a = await db.query(`SELECT count(*)::int AS n FROM public.fair_play_audit WHERE action = 'threshold_saved'`);
    assert.equal(a.rows[0].n, 1);
    // Only the service role opens reviews.
    await assert.rejects(
      as(db, U.STU_A, 'authenticated', `SELECT public.fair_play_open_review($1, 'results', $1, 'x', 'x', 'x', '{}', '{}')`, [U.STU_A]),
      /permission denied/
    );
  });

  it('rate-limits round starts, reward claims and the shared ledger', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO public.drill_sessions (student_id) SELECT $1 FROM generate_series(1, 60)`, [U.STU_A]);
    await assert.rejects(db.query(`INSERT INTO public.drill_sessions (student_id) VALUES ($1)`, [U.STU_A]), /short break/);
    await db.query(`INSERT INTO public.drill_sessions (student_id) VALUES ($1)`, [U.STU_B]);

    await db.query(`INSERT INTO public.reward_redemptions (student_id, cost) SELECT $1, 5 FROM generate_series(1, 10)`, [U.STU_A]);
    await assert.rejects(db.query(`INSERT INTO public.reward_redemptions (student_id, cost) VALUES ($1, 5)`, [U.STU_A]), /10 rewards a day/);

    const hit = async () => (await asService(db, `SELECT public.fair_play_rate_hit($1, 'reward_claim', 2, 60) AS ok`, [U.STU_A])).rows[0].ok;
    assert.equal(await hit(), true);
    assert.equal(await hit(), true);
    assert.equal(await hit(), false);
  });

  it('patches the boards once and rolls back cleanly', async () => {
    const db = await freshDb();
    const def = async (sig) => (await db.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig])).rows[0].d;
    assert.match(await def('public.leaderboard(text,text,text,integer,text)'), /fair_play_status/);
    const again = await db.query(`SELECT public.fair_play_patch_function('public.leaderboard(text,text,text,integer,text)') AS n`);
    assert.equal(again.rows[0].n, -1, 'already patched');
    // Re-running the whole migration is safe.
    await db.exec(MIGRATION);

    await db.exec(ROLLBACK);
    assert.doesNotMatch(await def('public.leaderboard(text,text,text,integer,text)'), /fair_play_status/);
    assert.doesNotMatch(await def('public.practice_highest_records(text,jsonb)'), /fair_play_status/);
    const fns = await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'fair_play%'`);
    assert.equal(fns.rows[0].n, 0);
    const kept = await db.query(`SELECT count(*)::int AS n FROM public.fair_play_thresholds`);
    assert.ok(kept.rows[0].n > 0, 'rollback keeps the data');
    // Typed inserts work again with no trigger.
    await db.query(`INSERT INTO public.drill_sessions (student_id) VALUES ($1)`, [U.STU_A]);
  });
});
