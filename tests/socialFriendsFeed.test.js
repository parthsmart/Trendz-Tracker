/**
 * Child-safe social (migration 38) on PGlite, after the multi-centre
 * migrations 30, 32 and 33.
 *
 * What must never happen:
 *  - anything social crossing centres (requests, feed, reactions, moderation);
 *  - a friendship without the other student's yes AND an adult's approval;
 *  - students writing rows directly, or writing free text anywhere;
 *  - failures / scores reaching the feed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const SOCIAL = read('supabase/migrations/39_social_friends_feed.sql');
const SOCIAL_ROLLBACK = read('supabase/rollbacks/39_social_friends_feed_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1),
  HEAD_B: id(10), TCH_B: id(12), TCH_B2: id(15), B1: id(13), B2: id(14), B3: id(16), B4: id(17),
  HEAD_K: id(20), TCH_K: id(21), K1: id(22),
};

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE FUNCTION public.is_standard_student_level(l text) RETURNS boolean LANGUAGE sql IMMUTABLE
    AS $$ SELECT l IN ('Level 1', 'Level 2', 'Level 3', 'Master') $$;
  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE
    AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY,
    student_code text UNIQUE,
    full_name text,
    role text NOT NULL,
    level text,
    active boolean NOT NULL DEFAULT true,
    leaderboard_visible boolean NOT NULL DEFAULT true,
    avatar_path text,
    deleted_at timestamptz,
    deleted_by uuid,
    CONSTRAINT profiles_role_check CHECK (role IN ('student', 'teacher', 'admin')),
    CONSTRAINT profiles_level_allowed CHECK (level IS NULL OR public.is_standard_student_level(level)
      OR (role = 'teacher' AND level = 'Teacher') OR (role = 'admin' AND level = 'Admin'))
  );
  CREATE TABLE public.teacher_permissions (
    teacher_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    can_view_students boolean NOT NULL DEFAULT true
  );
  CREATE TABLE public.teacher_student_assignments (
    teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    UNIQUE (teacher_id, student_id)
  );
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.is_teacher(p_uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT COALESCE((SELECT role = 'teacher' AND active FROM public.profiles WHERE id = p_uid), false) $$;
  CREATE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id uuid, p_student_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = p_teacher_id AND student_id = p_student_id) $$;
  CREATE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT public.is_teacher(p_teacher_id) AND p_permission = 'view_students'
            AND COALESCE((SELECT can_view_students FROM public.teacher_permissions WHERE teacher_id = p_teacher_id), true) $$;
  CREATE FUNCTION public.display_name_for(p_name text, p_code text) RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT split_part(p_name, ' ', 1) $$;
  CREATE FUNCTION public.avatar_visible(p_student uuid, p_path text) RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT p_path $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN RETURN NEW; END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();

  CREATE TABLE public.badge_catalogue (key text PRIMARY KEY, name text NOT NULL, icon text NOT NULL);
  INSERT INTO public.badge_catalogue VALUES ('streak_7', 'One-week streak', '📅'), ('pb_first', 'New record', '📈');
  CREATE TABLE public.student_badges (
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    badge_key text NOT NULL REFERENCES public.badge_catalogue(key),
    earned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, badge_key)
  );
  CREATE TABLE public.student_xp_events (
    id bigserial PRIMARY KEY,
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    label text NOT NULL,
    correct integer NOT NULL DEFAULT 0,
    total integer NOT NULL DEFAULT 0,
    is_personal_best boolean NOT NULL DEFAULT false,
    first_best boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.duels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_id uuid NOT NULL, opponent_id uuid NOT NULL, status text NOT NULL DEFAULT 'open'
  );
  CREATE TABLE public.live_duels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    a_id uuid NOT NULL, b_id uuid, status text NOT NULL DEFAULT 'live'
  );
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.OWNER}', 'ADMIN01', 'Owner', 'admin', 'Admin'),
    ('${P.HEAD_B}', 'HEADB', 'Head Baran', 'student', NULL),
    ('${P.TCH_B}', 'TCHB', 'Teacher Baran', 'teacher', 'Teacher'),
    ('${P.TCH_B2}', 'TCHB2', 'Other Teacher', 'teacher', 'Teacher'),
    ('${P.B1}', 'STUB1', 'Riya Shah', 'student', 'Level 1'),
    ('${P.B2}', 'STUB2', 'Aarav Mehta', 'student', 'Level 1'),
    ('${P.B3}', 'STUB3', 'Neha Rao', 'student', 'Level 2'),
    ('${P.B4}', 'STUB4', 'Kabir Jain', 'student', 'Level 1'),
    ('${P.HEAD_K}', 'HEADK', 'Head Kota', 'student', NULL),
    ('${P.TCH_K}', 'TCHK', 'Teacher Kota', 'teacher', 'Teacher'),
    ('${P.K1}', 'STUK1', 'Kiran Das', 'student', 'Level 1');
  INSERT INTO public.teacher_student_assignments VALUES
    ('${P.TCH_B}', '${P.B1}'), ('${P.TCH_K}', '${P.K1}');
`;

async function as(db, uid, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec(`SET ROLE ${role}`);
}

async function attempt(db, sql, params = []) {
  try {
    const { rows } = await db.query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function rows(db, sql, params = []) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  return (await db.query(sql, params)).rows;
}

/** Calls fn as uid and returns its jsonb result (throws on SQL error). */
async function rpc(db, uid, fn, args = [], casts = []) {
  await as(db, uid);
  const list = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ''}`).join(', ');
  const r = await attempt(db, `SELECT public.${fn}(${list}) AS r`, args);
  if (!r.ok) throw new Error(`${fn}: ${r.error}`);
  return r.rows[0].r;
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
  await as(db, P.OWNER);
  const k = await attempt(db, "INSERT INTO public.centres (name, code) VALUES ('Kota Centre', 'KTA') RETURNING id");
  assert.equal(k.ok, true, k.error);
  const kta = k.rows[0].id;
  const [{ id: brn }] = await rows(db, "SELECT id FROM public.centres WHERE code = 'BRN'");
  await rows(db, 'UPDATE public.profiles SET centre_id = $1 WHERE id = ANY ($2::uuid[])', [kta, [P.TCH_K, P.K1]]);
  await as(db, P.OWNER);
  for (const [target, role, centre] of [[P.HEAD_B, 'centre_head', brn], [P.HEAD_K, 'centre_head', kta]]) {
    const r = await attempt(db, 'SELECT public.set_person_role($1, $2, $3)', [target, role, centre]);
    assert.equal(r.ok, true, r.error);
  }
  await db.exec('RESET ROLE');
  await db.exec(SOCIAL);
  return { db, brn, kta };
}

/** B1 asks B2, B2 accepts, TCH_B (B1's teacher) approves. */
async function makeFriends(db, a = P.B1, b = P.B2, adult = P.TCH_B) {
  const req = await rpc(db, a, 'social_request_friend', [b]);
  assert.equal(req.ok, true, JSON.stringify(req));
  assert.equal((await rpc(db, b, 'social_respond_request', [req.id, true])).ok, true);
  assert.equal((await rpc(db, adult, 'social_decide_request', [req.id, true])).ok, true);
  return req.id;
}

const friendCount = async (db) => Number((await rows(db, 'SELECT count(*) AS n FROM public.friendships WHERE ended_at IS NULL'))[0].n);

describe('social: friend requests', () => {
  it('stay inside the centre, with the same answer for every refusal', async () => {
    const { db } = await freshDb();
    const cross = await rpc(db, P.B1, 'social_request_friend', [P.K1]);
    assert.deepEqual(cross, { ok: false, code: 'UNAVAILABLE' });
    const missing = await rpc(db, P.B1, 'social_request_friend', [id(999)]);
    assert.deepEqual(missing, { ok: false, code: 'UNAVAILABLE' });
    const staff = await rpc(db, P.B1, 'social_request_friend', [P.TCH_B]);
    assert.deepEqual(staff, { ok: false, code: 'UNAVAILABLE' });
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).ok, true);
    const home = await rpc(db, P.B1, 'social_home');
    assert.ok(!home.classmates.some((c) => c.id === P.K1), 'no Kota classmates listed');
    assert.ok(!JSON.stringify(home).includes('STUK1'));
  });

  it('need the other student AND an adult before a friendship exists', async () => {
    const { db } = await freshDb();
    const req = await rpc(db, P.B1, 'social_request_friend', [P.B2]);
    assert.equal(await friendCount(db), 0);
    // The adult cannot skip the student.
    assert.equal((await rpc(db, P.TCH_B, 'social_decide_request', [req.id, true])).ok, false);
    // The asker cannot accept their own request.
    assert.equal((await rpc(db, P.B1, 'social_respond_request', [req.id, true])).ok, false);
    assert.equal((await rpc(db, P.B2, 'social_respond_request', [req.id, true])).ok, true);
    assert.equal(await friendCount(db), 0, 'still waiting for an adult');
    // Students cannot approve.
    assert.equal((await rpc(db, P.B2, 'social_decide_request', [req.id, true])).ok, false);
    assert.equal((await rpc(db, P.TCH_B, 'social_decide_request', [req.id, true])).ok, true);
    assert.equal(await friendCount(db), 1);
    const home = await rpc(db, P.B2, 'social_home');
    assert.deepEqual(home.friends.map((f) => f.id), [P.B1]);
  });

  it('can only be approved by staff who look after one of the two students', async () => {
    const { db } = await freshDb();
    const req = await rpc(db, P.B1, 'social_request_friend', [P.B2]);
    await rpc(db, P.B2, 'social_respond_request', [req.id, true]);
    for (const outsider of [P.TCH_K, P.HEAD_K, P.TCH_B2]) {
      assert.equal((await rpc(db, outsider, 'social_decide_request', [req.id, true])).ok, false, outsider);
      const q = await rpc(db, outsider, 'social_mod_queue', [null]);
      assert.equal(q.requests.length, 0, `${outsider} sees no Baran request`);
    }
    assert.equal(await friendCount(db), 0);
    const q = await rpc(db, P.HEAD_B, 'social_mod_queue', [null]);
    assert.equal(q.requests.length, 1);
    assert.equal((await rpc(db, P.HEAD_B, 'social_decide_request', [req.id, true])).ok, true);
    assert.equal(await friendCount(db), 1);
  });

  it('a teacher without view_students cannot approve', async () => {
    const { db } = await freshDb();
    await rows(db, `INSERT INTO public.teacher_permissions VALUES ('${P.TCH_B}', false)`);
    const req = await rpc(db, P.B1, 'social_request_friend', [P.B2]);
    await rpc(db, P.B2, 'social_respond_request', [req.id, true]);
    assert.equal((await rpc(db, P.TCH_B, 'social_decide_request', [req.id, true])).ok, false);
  });

  it('are rate limited: 5 pending, no duplicates, 7 days after a no', async () => {
    const { db } = await freshDb();
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).ok, true);
    assert.equal((await rpc(db, P.B2, 'social_request_friend', [P.B1])).code, 'PENDING');
    const req = (await rpc(db, P.B1, 'social_home')).requests[0];
    await rpc(db, P.B2, 'social_respond_request', [req.id, false]);
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).code, 'TOO_SOON');
    // Six more students so B1 can hit the pending cap.
    for (let n = 50; n < 56; n += 1) {
      await rows(db, `INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES ($1, $2, 'Kid ${n}', 'student', 'Level 1')`,
        [id(n), `K${n}`]);
    }
    const results = [];
    for (let n = 50; n < 56; n += 1) results.push((await rpc(db, P.B1, 'social_request_friend', [id(n)])).code || 'ok');
    assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 'TOO_MANY_PENDING']);
  });

  it('honour the centre switch', async () => {
    const { db, brn } = await freshDb();
    assert.equal((await rpc(db, P.TCH_B, 'social_update_settings', [brn, false, true, true])).ok, false, 'teachers cannot');
    assert.equal((await rpc(db, P.HEAD_K, 'social_update_settings', [brn, false, true, true])).ok, false, 'other head cannot');
    assert.equal((await rpc(db, P.HEAD_B, 'social_update_settings', [brn, false, true, true])).ok, true);
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).code, 'DISABLED');
  });
});

describe('social: no direct access, no free text', () => {
  it('students cannot write any social table or read raw rows', async () => {
    const { db, brn } = await freshDb();
    await makeFriends(db);
    await as(db, P.B3);
    const writes = [
      `INSERT INTO public.friendships (a_id, b_id, centre_id) VALUES ('${P.B3 < P.B4 ? P.B3 : P.B4}', '${P.B3 < P.B4 ? P.B4 : P.B3}', '${brn}')`,
      `INSERT INTO public.friend_requests (from_id, to_id, centre_id, status) VALUES ('${P.B3}', '${P.B4}', '${brn}', 'approved')`,
      `INSERT INTO public.feed_items (centre_id, student_id, kind) VALUES ('${brn}', '${P.B3}', 'badge')`,
      `INSERT INTO public.social_reactions (reactor_id, target_kind, target_id, reaction) VALUES ('${P.B3}', 'feed', '1', 'clap')`,
      `INSERT INTO public.safety_reports (reporter_id, target_id, context, reason) VALUES ('${P.B3}', '${P.B1}', 'student', 'spam')`,
      `UPDATE public.friendships SET ended_at = now()`,
      `DELETE FROM public.student_blocks`,
      `UPDATE public.social_settings SET feed_enabled = false`,
    ];
    for (const sql of writes) {
      const r = await attempt(db, sql);
      assert.equal(r.ok, false, `should be refused: ${sql}`);
    }
    for (const table of ['friendships', 'friend_requests', 'feed_items', 'safety_reports']) {
      const r = await attempt(db, `SELECT * FROM public.${table}`);
      assert.equal(r.ok && r.rows.length, 0, `${table} raw rows hidden from students`);
    }
    assert.equal(await friendCount(db), 1);
  });

  it('anon can execute none of the social functions', async () => {
    const { db } = await freshDb();
    await as(db, '', 'anon');
    for (const sql of ['SELECT public.social_home()', "SELECT public.social_feed('centre', NULL, 20)",
      `SELECT public.social_request_friend('${P.B2}')`, 'SELECT public.social_mod_queue(NULL)']) {
      const r = await attempt(db, sql);
      assert.equal(r.ok, false, sql);
      assert.match(r.error, /permission denied/);
    }
  });

  it('internal helpers are not callable from the site', async () => {
    const { db, brn } = await freshDb();
    await as(db, P.B1);
    for (const sql of [
      `SELECT public.feed_post('${P.B1}', 'badge', '{}'::jsonb)`,
      `SELECT public.feed_post_batch_event('${brn}', 'Level 1', 'We did it')`,
      `SELECT public.social_rate_take('${P.B1}', 'reaction', 100, interval '1 second')`,
    ]) {
      const r = await attempt(db, sql);
      assert.equal(r.ok, false, sql);
    }
  });

  it('reactions and report reasons are fixed lists; no message columns exist', async () => {
    const { db } = await freshDb();
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`);
    const [{ id: item }] = await rows(db, 'SELECT id FROM public.feed_items LIMIT 1');
    assert.equal((await rpc(db, P.B1, 'social_react', ['feed', String(item), 'you are bad'])).code, 'BAD_REACTION');
    assert.equal((await rpc(db, P.B1, 'social_report', [P.B2, 'student', null, 'he said hi'])).code, 'BAD_INPUT');
    const cols = await rows(db, `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('friend_requests','friendships','student_blocks','feed_items',
        'social_reactions','safety_reports','social_settings','social_prefs')
        AND column_name ~ '(^|_)(message|body|comment|note|text|chat)($|_)'`);
    assert.deepEqual(cols, []);
  });
});

describe('social: class feed', () => {
  it('posts only positive events, never scores', async () => {
    const { db, brn } = await freshDb();
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`); // up: posted
    await rows(db, `UPDATE public.profiles SET level = 'Level 1' WHERE id = '${P.B1}'`); // down: not posted
    await rows(db, `INSERT INTO public.student_badges (student_id, badge_key) VALUES ('${P.B1}', 'streak_7')`);
    await rows(db, `INSERT INTO public.student_badges (student_id, badge_key, earned_at) VALUES ('${P.B2}', 'streak_7', now() - interval '30 days')`); // backfill
    await rows(db, `INSERT INTO public.student_xp_events (student_id, label, correct, total, is_personal_best) VALUES ('${P.B1}', 'Add 2D', 3, 10, false)`); // low score
    await rows(db, `INSERT INTO public.student_xp_events (student_id, label, is_personal_best, first_best) VALUES ('${P.B1}', 'Add 2D', true, true)`); // first ever
    await rows(db, `INSERT INTO public.student_xp_events (student_id, label, is_personal_best) VALUES ('${P.B1}', 'Add 2D', true)`); // PB
    await rows(db, `INSERT INTO public.student_xp_events (student_id, label, is_personal_best) VALUES ('${P.B1}', 'Sub 2D', true)`); // 2nd PB same day
    const items = await rows(db, 'SELECT kind, payload, centre_id FROM public.feed_items ORDER BY id');
    assert.deepEqual(items.map((i) => i.kind), ['level_up', 'badge', 'personal_best']);
    assert.equal(items[0].payload.level, 'Level 2');
    assert.ok(items.every((i) => i.centre_id === brn));
    for (const i of items) assert.ok(!/correct|total|score|rank/.test(JSON.stringify(i.payload)));
    // Even the database owner cannot store a score in the feed.
    const bad = await attempt(db, `INSERT INTO public.feed_items (centre_id, student_id, kind, payload)
      VALUES ('${brn}', '${P.B1}', 'badge', '{"score": 3}')`);
    assert.equal(bad.ok, false);
    const badKind = await attempt(db, `INSERT INTO public.feed_items (centre_id, student_id, kind) VALUES ('${brn}', '${P.B1}', 'lost_duel')`);
    assert.equal(badKind.ok, false);
  });

  it('respects opt-outs: hidden from leaderboards, auto-post off', async () => {
    const { db } = await freshDb();
    await rows(db, `UPDATE public.profiles SET leaderboard_visible = false WHERE id = '${P.B2}'`);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`);
    assert.equal((await rpc(db, P.B1, 'social_set_auto_post', [false])).ok, true);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`);
    assert.equal((await rows(db, 'SELECT count(*) AS n FROM public.feed_items'))[0].n, 0);
  });

  it('never shows another centre, and defaults to my level', async () => {
    const { db, kta } = await freshDb();
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`); // B2 now Level 2 (Baran)
    await rows(db, `UPDATE public.profiles SET level = 'Level 3' WHERE id = '${P.B3}'`); // Level 3 (Baran)
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.K1}'`); // Kota
    await rows(db, `SELECT public.feed_post_batch_event('${kta}', 'Level 2', 'Level 2 beat the weekly boss!')`);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`);
    const mine = await rpc(db, P.B1, 'social_feed', ['level', null, 20], [null, 'bigint', 'integer']);
    assert.deepEqual(mine.items.map((i) => i.student_id).sort(), [P.B1, P.B2].sort());
    const centre = await rpc(db, P.B1, 'social_feed', ['centre', null, 20], [null, 'bigint', 'integer']);
    assert.equal(centre.items.length, 3);
    assert.ok(!JSON.stringify(centre).includes(P.K1) && !JSON.stringify(centre).includes('weekly boss'));
    const kota = await rpc(db, P.K1, 'social_feed', ['centre', null, 20], [null, 'bigint', 'integer']);
    assert.equal(kota.items.length, 2);
    assert.ok(kota.items.some((i) => i.kind === 'batch_goal'));
    assert.ok(!JSON.stringify(kota).includes('Riya') && !JSON.stringify(kota).includes(P.B1));
    // Staff of the other centre see none of Baran's items either.
    const q = await rpc(db, P.HEAD_K, 'social_mod_queue', [null]);
    assert.ok(q.feed.every((i) => i.student_id === null || i.student_id === P.K1));
  });

  it('students hide their own items; staff remove items in their scope only', async () => {
    const { db } = await freshDb();
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`);
    const ids = (await rows(db, 'SELECT id, student_id FROM public.feed_items ORDER BY id'));
    const b1Item = String(ids.find((r) => r.student_id === P.B1).id);
    const b2Item = String(ids.find((r) => r.student_id === P.B2).id);
    assert.equal((await rpc(db, P.B2, 'social_hide_item', [b1Item, true], ['bigint'])).ok, false, 'not your item');
    assert.equal((await rpc(db, P.B1, 'social_hide_item', [b1Item, true], ['bigint'])).ok, true);
    let feed = await rpc(db, P.B2, 'social_feed', ['level', null, 20], [null, 'bigint', 'integer']);
    assert.deepEqual(feed.items.map((i) => String(i.id)), [b2Item]);
    assert.equal((await rpc(db, P.HEAD_K, 'social_remove_item', [b2Item, true], ['bigint'])).ok, false);
    assert.equal((await rpc(db, P.TCH_K, 'social_remove_item', [b2Item, true], ['bigint'])).ok, false);
    assert.equal((await rpc(db, P.TCH_B, 'social_remove_item', [b2Item, true], ['bigint'])).ok, false, 'B2 is not TCH_B\'s student');
    assert.equal((await rpc(db, P.HEAD_B, 'social_remove_item', [b2Item, true], ['bigint'])).ok, true);
    feed = await rpc(db, P.B1, 'social_feed', ['centre', null, 20], [null, 'bigint', 'integer']);
    assert.equal(feed.items.length, 0);
  });
});

describe('social: reactions', () => {
  it('toggle, stay in the centre and are rate limited', async () => {
    const { db } = await freshDb();
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`);
    const item = String((await rows(db, 'SELECT id FROM public.feed_items'))[0].id);
    let r = await rpc(db, P.B1, 'social_react', ['feed', item, 'clap']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.reactions.counts, { clap: 1 });
    r = await rpc(db, P.B1, 'social_react', ['feed', item, 'clap']);
    assert.deepEqual(r.reactions.counts, {}, 'second tap removes it');
    assert.equal((await rpc(db, P.K1, 'social_react', ['feed', item, 'fire'])).code, 'NOT_ALLOWED');
    let last;
    for (let n = 0; n < 18; n += 1) last = await rpc(db, P.B1, 'social_react', ['feed', item, n % 2 ? 'fire' : 'gg']);
    assert.equal(last.ok, true);
    assert.equal((await rpc(db, P.B1, 'social_react', ['feed', item, 'star'])).code, 'SLOW_DOWN');
  });

  it('duel results: only the two players react', async () => {
    const { db } = await freshDb();
    const [{ id: duel }] = await rows(db, `INSERT INTO public.duels (challenger_id, opponent_id, status)
      VALUES ('${P.B1}', '${P.K1}', 'done') RETURNING id`);
    const [{ id: live }] = await rows(db, `INSERT INTO public.live_duels (a_id, b_id, status)
      VALUES ('${P.B1}', '${P.B2}', 'live') RETURNING id`);
    assert.equal((await rpc(db, P.K1, 'social_react', ['duel', duel, 'gg'])).ok, true, 'cross-centre duel players may GG');
    assert.equal((await rpc(db, P.B2, 'social_react', ['duel', duel, 'gg'])).code, 'NOT_ALLOWED');
    assert.equal((await rpc(db, P.B1, 'social_react', ['live_duel', live, 'gg'])).code, 'NOT_ALLOWED', 'not finished');
    const seen = await rpc(db, P.B1, 'social_reactions_for', ['duel', [duel]], [null, 'text[]']);
    assert.deepEqual(seen[duel].counts, { gg: 1 });
    const other = await rpc(db, P.B3, 'social_reactions_for', ['duel', [duel]], [null, 'text[]']);
    assert.deepEqual(other, {});
  });
});

describe('social: block and report', () => {
  it('a block ends the friendship, refuses requests and hides items and reactions', async () => {
    const { db } = await freshDb();
    await makeFriends(db);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B2}'`);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`);
    const b2Item = String((await rows(db, `SELECT id FROM public.feed_items WHERE student_id = '${P.B2}'`))[0].id);
    await rpc(db, P.B2, 'social_react', ['feed', b2Item, 'party']);
    assert.equal((await rpc(db, P.B1, 'social_block', [P.B2])).ok, true);
    assert.equal(await friendCount(db), 0);
    assert.equal((await rpc(db, P.B2, 'social_request_friend', [P.B1])).code, 'UNAVAILABLE');
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).code, 'UNAVAILABLE');
    assert.equal((await rpc(db, P.B1, 'social_react', ['feed', b2Item, 'clap'])).code, 'NOT_ALLOWED');
    const feed = await rpc(db, P.B1, 'social_feed', ['level', null, 20], [null, 'bigint', 'integer']);
    assert.ok(feed.items.every((i) => i.student_id !== P.B2));
    assert.ok(!(await rpc(db, P.B1, 'social_home')).classmates.some((c) => c.id === P.B2));
    // B2 is not told, and B2's classmates list just no longer has B1.
    assert.ok(!(await rpc(db, P.B2, 'social_home')).classmates.some((c) => c.id === P.B1));
    assert.equal((await rpc(db, P.B1, 'social_unblock', [P.B2])).ok, true);
  });

  it('reports reach the right staff only', async () => {
    const { db } = await freshDb();
    assert.equal((await rpc(db, P.B2, 'social_report', [P.B1, 'student', null, 'unkind'])).ok, true);
    assert.equal((await rpc(db, P.B2, 'social_report', [P.B2, 'student', null, 'unkind'])).ok, false, 'not yourself');
    assert.equal((await rpc(db, P.TCH_B, 'social_mod_queue', [null])).reports.length, 1, 'B1 is TCH_B\'s student');
    assert.equal((await rpc(db, P.HEAD_B, 'social_mod_queue', [null])).reports.length, 1);
    assert.equal((await rpc(db, P.HEAD_K, 'social_mod_queue', [null])).reports.length, 0);
    assert.equal((await rpc(db, P.TCH_K, 'social_mod_queue', [null])).reports.length, 0);
    const [{ id: rid }] = await rows(db, 'SELECT id FROM public.safety_reports');
    assert.equal((await rpc(db, P.HEAD_K, 'social_handle_report', [String(rid), 'reviewed', 'none'], ['bigint'])).ok, false);
    assert.equal((await rpc(db, P.TCH_B, 'social_handle_report', [String(rid), 'actioned', 'talked'], ['bigint'])).ok, true);
    await assert.rejects(rpc(db, P.B1, 'social_mod_queue', [null]), /Not allowed/);
  });

  it('staff can end a friendship in their scope', async () => {
    const { db } = await freshDb();
    await makeFriends(db);
    assert.equal((await rpc(db, P.TCH_K, 'social_end_friendship', [P.B1, P.B2])).ok, false);
    assert.equal((await rpc(db, P.TCH_B, 'social_end_friendship', [P.B1, P.B2])).ok, true);
    assert.equal(await friendCount(db), 0);
  });
});

describe('social: rollback', () => {
  it('removes everything and can be re-applied', async () => {
    const { db } = await freshDb();
    await db.exec('RESET ROLE');
    await db.exec(SOCIAL_ROLLBACK);
    const left = await rows(db, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('friend_requests','friendships','feed_items','social_reactions','safety_reports','student_blocks')`);
    assert.deepEqual(left, []);
    await rows(db, `UPDATE public.profiles SET level = 'Level 2' WHERE id = '${P.B1}'`);
    await db.exec(SOCIAL);
    assert.equal((await rpc(db, P.B1, 'social_request_friend', [P.B2])).ok, true);
  });
});
