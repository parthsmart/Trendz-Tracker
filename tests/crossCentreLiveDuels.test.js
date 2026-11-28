/**
 * Multi-centre step 5c: live duels across centres follow centre_visibility (migration 41).
 *
 * PGlite with the live duel migrations (31, 34, 35) on minimal centre tables:
 *  - the lobby (live_duel_online_players) lists another centre's student only when
 *    both centres opened to each other; same-centre classmates are unchanged;
 *  - grant modes 'all', 'students', 'top_n', a viewer-specific grant, expiry, a
 *    suspended centre and a student hidden from leaderboards;
 *  - accepting an invite after the grant was removed is refused and expires it;
 *  - quick match never claims a pair that is not open;
 *  - students cannot call the helpers; the rollback brings back the old lobby.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M31 = read('supabase/migrations/31_live_duels.sql');
const M34 = read('supabase/migrations/34_live_duel_mate_avatars.sql');
const M35 = read('supabase/migrations/35_live_duel_fair_open.sql');
const M41 = read('supabase/migrations/41_cross_centre_live_duels.sql');
const R41 = read('supabase/rollbacks/41_cross_centre_live_duels_rollback.sql');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BRN = id(901);
const KTA = id(902);
const MYS = id(903);
const S = {
  ASHA: id(1), RAVI: id(2), // Baran, Level 2
  KIRAN: id(3), NEHA: id(4), // Kota, Level 2 (Neha has more XP)
  MEERA: id(5), // Mysore, Level 2
  HIDDEN: id(6), // Kota, Level 2, hidden from leaderboards
};
const CAT = id(800);

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
  CREATE SCHEMA realtime;
  CREATE TABLE realtime.messages (id bigserial PRIMARY KEY, topic text, extension text, event text, payload jsonb, private boolean);
  ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;
  CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
    LANGUAGE sql SECURITY DEFINER AS $$
    INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES (topic, 'broadcast', event, payload, private) $$;
  GRANT USAGE ON SCHEMA realtime, auth TO authenticated, anon, service_role;
  GRANT SELECT, INSERT ON realtime.messages TO authenticated; GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;

  CREATE TABLE public.centres (id uuid PRIMARY KEY, name text NOT NULL, code text NOT NULL,
    status text NOT NULL DEFAULT 'active');
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, active boolean DEFAULT true, level text,
    full_name text, student_code text, avatar_path text, leaderboard_visible boolean DEFAULT true,
    centre_id uuid REFERENCES public.centres (id));
  CREATE TABLE public.centre_visibility (
    id bigserial PRIMARY KEY,
    source_centre_id uuid NOT NULL REFERENCES public.centres (id),
    viewer_centre_id uuid REFERENCES public.centres (id),
    mode text NOT NULL CHECK (mode IN ('all', 'students', 'top_n')),
    student_ids uuid[], top_n integer,
    purpose text NOT NULL DEFAULT 'duels',
    created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz);
  ALTER TABLE public.centre_visibility ENABLE ROW LEVEL SECURITY;
  CREATE TABLE public.student_xp_events (id bigserial PRIMARY KEY, student_id uuid, day date, xp integer,
    bonus_xp integer DEFAULT 0, source text, source_id text);
  CREATE TABLE public.student_badges (student_id uuid, badge_key text, PRIMARY KEY (student_id, badge_key));
  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;
  CREATE FUNCTION public.display_name_for(p_name text, p_code text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_name, p_code) $$;
  CREATE FUNCTION public.avatar_visible(p_student uuid, p_path text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p_path $$;
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.is_teacher(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id uuid, p_student_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`;

async function freshDb({ with41 = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(M31);
  await db.exec(M34);
  await db.exec(M35);
  await db.query(
    `INSERT INTO public.centres (id, name, code) VALUES ($1, 'Baran', 'BRN'), ($2, 'Kota', 'KTA'), ($3, 'Mysore', 'MYS')`,
    [BRN, KTA, MYS],
  );
  await db.query(
    `INSERT INTO public.profiles (id, role, level, full_name, centre_id, leaderboard_visible) VALUES
      ($1, 'student', 'Level 2', 'Asha', $7, true), ($2, 'student', 'Level 2', 'Ravi', $7, true),
      ($3, 'student', 'Level 2', 'Kiran', $8, true), ($4, 'student', 'Level 2', 'Neha', $8, true),
      ($5, 'student', 'Level 2', 'Meera', $9, true), ($6, 'student', 'Level 2', 'Hidden', $8, false)`,
    [S.ASHA, S.RAVI, S.KIRAN, S.NEHA, S.MEERA, S.HIDDEN, BRN, KTA, MYS],
  );
  await db.query(
    `INSERT INTO public.student_xp_events (student_id, day, xp) VALUES ($1, current_date, 50), ($2, current_date, 10)`,
    [S.NEHA, S.KIRAN],
  );
  if (with41) await db.exec(M41);
  return db;
}

const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const one = async (db, sql, params) => (await rows(db, sql, params))[0];

async function as(db, uid, fn) {
  await db.exec(`SET app.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE; RESET app.uid;');
  }
}

const ALL = Object.values(S);
async function lobby(db, uid) {
  const r = await as(db, uid, () => one(db, 'SELECT public.live_duel_online_players($1::uuid[]) AS j', [ALL]));
  return (r.j || []).map((p) => p.display_name).sort();
}
const grant = (db, source, viewer, mode, extra = {}) => db.query(
  `INSERT INTO public.centre_visibility (source_centre_id, viewer_centre_id, mode, student_ids, top_n, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [source, viewer, mode, extra.students || null, extra.top_n || null, extra.expires_at || null],
);
const pairable = async (db, a, b) => (await one(db, 'SELECT public.live_duel_pairable($1, $2) AS ok', [a, b])).ok;

describe('cross-centre live duels (migration 41)', () => {
  let db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('applies twice without errors (idempotent)', async () => {
    await db.exec(M41);
    assert.deepEqual(await lobby(db, S.ASHA), ['Ravi']);
  });

  it('lists only classmates when no centre has opened up', async () => {
    assert.deepEqual(await lobby(db, S.ASHA), ['Ravi']);
    assert.deepEqual(await lobby(db, S.KIRAN), ['Neha'], 'Hidden is not listed even as a classmate');
    assert.equal(await pairable(db, S.ASHA, S.RAVI), true);
    assert.equal(await pairable(db, S.ASHA, S.KIRAN), false);
  });

  it('a grant one way is not enough: both centres must open to each other', async () => {
    await grant(db, KTA, BRN, 'all');
    assert.deepEqual(await lobby(db, S.ASHA), ['Ravi'], 'Baran has not opened to Kota');
    assert.deepEqual(await lobby(db, S.KIRAN), ['Neha']);
    await grant(db, BRN, KTA, 'all');
    assert.deepEqual(await lobby(db, S.ASHA), ['Kiran', 'Neha', 'Ravi']);
    assert.deepEqual(await lobby(db, S.KIRAN), ['Asha', 'Neha', 'Ravi']);
    assert.deepEqual(await lobby(db, S.MEERA), [], 'Mysore was not opened to anyone');
  });

  it('never lists a hidden student of another centre, whatever the grant', async () => {
    await grant(db, KTA, null, 'all');
    await grant(db, BRN, null, 'all');
    assert.equal((await lobby(db, S.ASHA)).includes('Hidden'), false);
    assert.equal(await pairable(db, S.ASHA, S.HIDDEN), false);
  });

  it("'every centre' grants, a viewer-specific grant and the chosen-students mode", async () => {
    await grant(db, BRN, null, 'all');
    await grant(db, KTA, MYS, 'students', { students: [S.KIRAN] });
    await grant(db, MYS, null, 'all');
    assert.deepEqual(await lobby(db, S.MEERA), ['Asha', 'Kiran', 'Ravi'], 'only Kiran was chosen from Kota');
    assert.deepEqual(await lobby(db, S.ASHA), ['Meera', 'Ravi'], 'Kota opened to Mysore only');
  });

  it('top N goes by total XP inside the source centre', async () => {
    await grant(db, KTA, BRN, 'top_n', { top_n: 1 });
    await grant(db, BRN, KTA, 'all');
    assert.deepEqual(await lobby(db, S.ASHA), ['Neha', 'Ravi'], 'Neha has the most XP at Kota');
    await db.query('INSERT INTO public.student_xp_events (student_id, day, xp) VALUES ($1, current_date, 100)', [S.KIRAN]);
    assert.deepEqual(await lobby(db, S.ASHA), ['Kiran', 'Ravi']);
  });

  it('expired grants and suspended centres close the door', async () => {
    await grant(db, KTA, BRN, 'all', { expires_at: new Date(Date.now() - 60_000).toISOString() });
    await grant(db, BRN, KTA, 'all');
    assert.equal(await pairable(db, S.ASHA, S.KIRAN), false, 'expired');
    await grant(db, KTA, BRN, 'all');
    assert.equal(await pairable(db, S.ASHA, S.KIRAN), true);
    await db.query("UPDATE public.centres SET status = 'suspended' WHERE id = $1", [KTA]);
    assert.equal(await pairable(db, S.ASHA, S.KIRAN), false, 'suspended source');
    assert.equal(await pairable(db, S.KIRAN, S.ASHA), false, 'suspended viewer');
    assert.equal(await pairable(db, S.KIRAN, S.NEHA), true, 'classmates are not affected here');
  });

  it('pairable_ids keeps only open ids, without duplicates or myself', async () => {
    await grant(db, KTA, BRN, 'students', { students: [S.KIRAN] });
    await grant(db, BRN, KTA, 'all');
    const r = await one(db, 'SELECT public.live_duel_pairable_ids($1, $2::uuid[]) AS ids',
      [S.ASHA, [S.ASHA, S.RAVI, S.KIRAN, S.KIRAN, S.NEHA, S.MEERA, id(999)]]);
    assert.deepEqual(r.ids, [S.RAVI, S.KIRAN].sort());
  });

  it('accepting a challenge after the grant was removed is refused and expires it', async () => {
    await grant(db, KTA, BRN, 'all');
    await grant(db, BRN, KTA, 'all');
    const invite = async () => (await one(db,
      `INSERT INTO public.live_duels (kind, status, a_id, b_id, level, category_id, category_name, seed, questions, invite_expires_at)
       VALUES ('challenge', 'invited', $1, $2, 'Level 2', $3, '1d3r', 1, '[]'::jsonb, now() + interval '1 minute') RETURNING id`,
      [S.ASHA, S.KIRAN, CAT])).id;
    const first = await invite();
    const ok = await as(db, S.KIRAN, () => one(db, 'SELECT public.live_duel_respond($1, true) AS r', [first]));
    assert.equal(ok.r.ok, true);

    const second = await invite();
    await db.query('DELETE FROM public.centre_visibility WHERE source_centre_id = $1', [KTA]);
    const refused = await as(db, S.KIRAN, () => one(db, 'SELECT public.live_duel_respond($1, true) AS r', [second]));
    assert.equal(refused.r.ok, false);
    assert.match(refused.r.error, /closed/);
    assert.equal((await one(db, 'SELECT status FROM public.live_duels WHERE id = $1', [second])).status, 'expired');

    const third = await invite();
    const declined = await as(db, S.KIRAN, () => one(db, 'SELECT public.live_duel_respond($1, false) AS r', [third]));
    assert.equal(declined.r.ok, true, 'declining still works');
  });

  it('quick match never claims a pair that is not open', async () => {
    await db.query(`INSERT INTO public.live_duel_queue (student_id, level, rating) VALUES ($1, 'Level 2', 1000), ($2, 'Level 2', 1000)`,
      [S.ASHA, S.KIRAN]);
    assert.equal((await one(db, 'SELECT public.live_duel_claim_pair($1, $2) AS ok', [S.ASHA, S.KIRAN])).ok, false);
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM public.live_duel_queue')).n, 2, 'both still queued');
    await grant(db, KTA, BRN, 'all');
    await grant(db, BRN, KTA, 'all');
    assert.equal((await one(db, 'SELECT public.live_duel_claim_pair($1, $2) AS ok', [S.ASHA, S.KIRAN])).ok, true);
  });

  it('students and anon cannot call the helpers or read grants', async () => {
    await grant(db, KTA, BRN, 'all');
    for (const sql of [
      `SELECT public.live_duel_visible_to('${S.KIRAN}', '${BRN}')`,
      `SELECT public.live_duel_pairable('${S.ASHA}', '${S.KIRAN}')`,
      `SELECT public.live_duel_pairable_ids('${S.ASHA}', ARRAY['${S.KIRAN}']::uuid[])`,
      `SELECT public.live_duel_claim_pair('${S.ASHA}', '${S.KIRAN}')`,
    ]) {
      await assert.rejects(as(db, S.ASHA, () => db.query(sql)), /permission denied/, sql);
      await db.exec('SET ROLE anon;');
      await assert.rejects(db.query(sql), /permission denied/, `anon: ${sql}`);
      await db.exec('RESET ROLE;');
    }
    await assert.rejects(as(db, S.ASHA, () => db.query('SELECT * FROM public.centre_visibility')), /permission denied/);
  });

  it('a student cannot widen the lobby by asking for many ids or other levels', async () => {
    await db.query("UPDATE public.profiles SET level = 'Level 3' WHERE id = $1", [S.RAVI]);
    const many = Array.from({ length: 400 }, (_, i) => id(2000 + i)).concat(ALL);
    const r = await as(db, S.ASHA, () => one(db, 'SELECT public.live_duel_online_players($1::uuid[]) AS j', [many]));
    assert.deepEqual(r.j || [], [], 'ids past 300 are ignored; Ravi is another level; no grants');
  });
});

describe('migration 41 rollback', () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  it('brings back the pre-41 lobby (every centre) and removes the helpers', async () => {
    await db.exec(R41);
    await db.exec(R41);
    assert.deepEqual(await lobby(db, S.ASHA), ['Kiran', 'Meera', 'Neha', 'Ravi']);
    const left = await rows(db, "SELECT proname FROM pg_proc WHERE proname LIKE 'live_duel_pairable%' OR proname = 'live_duel_visible_to'");
    assert.deepEqual(left, []);
    await db.exec(M41);
    assert.deepEqual(await lobby(db, S.ASHA), ['Ravi'], 're-applies cleanly');
  });

  it('documents the pre-41 leak: without 41 the lobby lists every centre', async () => {
    const old = await freshDb({ with41: false });
    assert.deepEqual(await lobby(old, S.ASHA), ['Kiran', 'Meera', 'Neha', 'Ravi']);
  });

  it('migration 41 changes no tables and deletes nothing', () => {
    const code = M41.replace(/--.*$/gm, '');
    assert.doesNotMatch(code, /\b(DROP|DELETE FROM public\.(?!live_duel_queue)|TRUNCATE|ALTER TABLE)\b/i);
  });
});
