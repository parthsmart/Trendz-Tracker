/**
 * Multi-centre step 3: the owner and director panel.
 *
 *  - migration 33 (centres guard) and the database rules the panel relies on,
 *    including escalation attempts, on PGlite after migrations 30 and 32;
 *  - create_staff in the API (api/_networkStaff.js) with fake Supabase clients;
 *  - the page logic in js/networkModel.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createStaff, canCreateStaffRole, validateStaffInput } from '../api/_networkStaff.js';
import { resolveRailItems } from '../js/appRail.js';
import {
  assignableRoles,
  canManagePerson,
  centreActions,
  centreStats,
  creatableStaffRoles,
  describeAudit,
  describeGrant,
  filterPeople,
  grantRow,
  networkTotals,
  readActiveCentre,
  validateCentreInput,
  validateGrant,
  writeActiveCentre,
  ACTIVE_CENTRE_KEY,
} from '../js/networkModel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const ROLLBACK_33 = read('supabase/rollbacks/33_centres_guard_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = { OWNER: id(1), TEACHER: id(2), STU1: id(3), STU2: id(4), DIRECTOR: id(5), HEAD: id(6), OWNER2: id(7) };

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

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY,
    student_code text UNIQUE,
    full_name text,
    role text NOT NULL,
    level text,
    active boolean NOT NULL DEFAULT true,
    deleted_at timestamptz,
    deleted_by uuid,
    CONSTRAINT profiles_role_check CHECK (role IN ('student', 'teacher', 'admin')),
    CONSTRAINT profiles_level_allowed CHECK (level IS NULL OR public.is_standard_student_level(level)
      OR (role = 'teacher' AND level = 'Teacher') OR (role = 'admin' AND level = 'Admin'))
  );
  CREATE TABLE public.teacher_permissions (teacher_id uuid, permission text, allowed boolean);
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN RETURN NEW; END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());
  CREATE POLICY profiles_admin_update ON public.profiles FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.OWNER}', 'ADMIN01', 'Owner', 'admin', 'Admin'),
    ('${P.TEACHER}', 'TCH01', 'Teacher', 'teacher', 'Teacher'),
    ('${P.STU1}', 'STU001', 'Asha', 'student', 'Level 1'),
    ('${P.STU2}', 'STU002', 'Ravi', 'student', NULL),
    ('${P.DIRECTOR}', 'DIR01', 'Director', 'student', NULL),
    ('${P.HEAD}', 'HEAD01', 'Head', 'student', NULL),
    ('${P.OWNER2}', 'OWN02', 'Second owner', 'student', NULL);
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
  return (await db.query(sql, params)).rows;
}

const setRole = (db, target, role, centre = null) =>
  attempt(db, 'SELECT public.set_person_role($1, $2, $3)', [target, role, centre]);

/** Migrations 30, 32, 33; a director and a second centre (KTA). */
async function freshDb() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
  await as(db, P.OWNER);
  const d = await setRole(db, P.DIRECTOR, 'director');
  assert.equal(d.ok, true, d.error);
  const k = await attempt(db, "INSERT INTO public.centres (name, code) VALUES ('Kota Centre', 'KTA') RETURNING id");
  assert.equal(k.ok, true, k.error);
  const [{ id: brn }] = await rows(db, "SELECT id FROM public.centres WHERE code = 'BRN'");
  return { db, brn, kta: k.rows[0].id };
}

describe('migration 33: centres guard', () => {
  it('owners and directors can add centres; created_by is the signed-in person', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.DIRECTOR);
    const r = await attempt(db, "INSERT INTO public.centres (name, code, kind, created_by) VALUES ('Jaipur School', 'JPR', 'school', $1) RETURNING created_by",
      [P.TEACHER]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows[0].created_by, P.DIRECTOR, 'created_by cannot be forged');
    const [k] = await rows(db, 'SELECT created_by, status, is_default FROM public.centres WHERE id = $1', [kta]);
    assert.deepEqual(k, { created_by: P.OWNER, status: 'active', is_default: false });
  });

  it('a new centre cannot be the default or start suspended', async () => {
    const { db } = await freshDb();
    await as(db, P.OWNER);
    assert.match((await attempt(db, "INSERT INTO public.centres (name, code, is_default) VALUES ('X Centre', 'XC', true)")).error,
      /cannot be the default/);
    assert.match((await attempt(db, "INSERT INTO public.centres (name, code, status) VALUES ('Y Centre', 'YC', 'suspended')")).error,
      /must start active/);
  });

  it('the default centre stays active and default', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.OWNER);
    for (const status of ['suspended', 'archived']) {
      const r = await attempt(db, 'UPDATE public.centres SET status = $1 WHERE id = $2', [status, brn]);
      assert.match(r.error, /must stay active/, status);
    }
    assert.match((await attempt(db, 'UPDATE public.centres SET is_default = false WHERE id = $1', [brn])).error, /default centre cannot be changed/);
    assert.match((await attempt(db, 'UPDATE public.centres SET is_default = true WHERE id = $1', [kta])).error, /default centre cannot be changed/);
    // Renaming the default centre is fine.
    assert.equal((await attempt(db, "UPDATE public.centres SET city = 'Baran' WHERE id = $1", [brn])).ok, true);
  });

  it('a centre with people or an open head post cannot be archived; archived_at is set when it can', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.STU1, 'student', kta)).ok, true);
    assert.match((await attempt(db, "UPDATE public.centres SET status = 'archived' WHERE id = $1", [kta])).error, /Move everyone out/);

    assert.equal((await setRole(db, P.STU1, 'student', brn)).ok, true);
    assert.equal((await setRole(db, P.HEAD, 'centre_head', kta)).ok, true);
    // The head counts as a person in the centre too.
    assert.match((await attempt(db, "UPDATE public.centres SET status = 'archived' WHERE id = $1", [kta])).error, /Move everyone out/);
    assert.equal((await setRole(db, P.HEAD, 'teacher', brn)).ok, true, 'moving the head ends the post');

    const r = await attempt(db, "UPDATE public.centres SET status = 'archived', archived_by = $2 WHERE id = $1 RETURNING archived_at, archived_by",
      [kta, P.TEACHER]);
    assert.equal(r.ok, true, r.error);
    assert.ok(r.rows[0].archived_at);
    assert.equal(r.rows[0].archived_by, P.OWNER);

    // Restoring clears the archive stamp.
    const back = await attempt(db, "UPDATE public.centres SET status = 'active' WHERE id = $1 RETURNING archived_at", [kta]);
    assert.equal(back.rows[0].archived_at, null);
  });

  it('a centre can be suspended and reactivated; nobody new joins a suspended centre', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await attempt(db, "UPDATE public.centres SET status = 'suspended' WHERE id = $1", [kta])).ok, true);
    assert.match((await setRole(db, P.STU2, 'student', kta)).error, /not active/);
    assert.equal((await attempt(db, "UPDATE public.centres SET status = 'active' WHERE id = $1", [kta])).ok, true);
    assert.equal((await setRole(db, P.STU2, 'student', kta)).ok, true);
  });

  it('teachers, students and heads cannot add or change centres', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.HEAD, 'centre_head', kta)).ok, true);
    for (const who of [P.TEACHER, P.STU1, P.HEAD]) {
      await as(db, who);
      const ins = await attempt(db, "INSERT INTO public.centres (name, code) VALUES ('Sneaky', 'SNK')");
      assert.equal(ins.ok, false, `${who} insert`);
      await attempt(db, "UPDATE public.centres SET name = 'Hacked' WHERE id = $1", [kta]);
      await attempt(db, "UPDATE public.centres SET name = 'Hacked' WHERE id = $1", [brn]);
    }
    const names = await rows(db, 'SELECT name FROM public.centres ORDER BY name');
    assert.deepEqual(names.map((r) => r.name), ['Baran Centre', 'Kota Centre']);
  });

  it('nobody can delete a centre from the site', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await attempt(db, 'DELETE FROM public.centres WHERE id = $1', [kta])).ok, false);
  });

  it('the rollback removes the guard and keeps every centre', async () => {
    const { db } = await freshDb();
    await db.exec('RESET ROLE');
    await db.exec(ROLLBACK_33);
    const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'centres_guard'");
    assert.equal(n, 0);
    assert.equal((await rows(db, 'SELECT id FROM public.centres')).length, 2);
    await db.exec(MIGRATION_33); // and it can be applied again
  });
});

describe('step 3: escalation attempts through the panel', () => {
  it('a director cannot make owners or directors, or touch an owner', async () => {
    const { db } = await freshDb();
    await as(db, P.DIRECTOR);
    assert.match((await setRole(db, P.STU2, 'owner')).error, /below your own level/);
    assert.match((await setRole(db, P.STU2, 'director')).error, /below your own level/);
    assert.match((await setRole(db, P.OWNER, 'student', null)).error, /below your own level|Choose a centre/);
    assert.match((await setRole(db, P.DIRECTOR, 'owner')).error, /own role/);
    // Deactivating the owner is blocked by the guard.
    const off = await attempt(db, 'UPDATE public.profiles SET active = false WHERE id = $1', [P.OWNER]);
    assert.equal(off.ok, false);
    const [o] = await rows(db, 'SELECT role, active FROM public.profiles WHERE id = $1', [P.OWNER]);
    assert.deepEqual(o, { role: 'owner', active: true });
  });

  it('a director can appoint heads and vice heads and move students between centres', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.HEAD, 'centre_head', kta)).ok, true);
    assert.equal((await setRole(db, P.STU2, 'vice_centre_head', kta)).ok, true);
    assert.match((await setRole(db, P.TEACHER, 'centre_head', kta)).error, /already has a head/);
    assert.equal((await setRole(db, P.STU1, 'student', kta)).ok, true);
    const posts = await rows(db, 'SELECT profile_id, role FROM public.centre_staff WHERE ended_at IS NULL ORDER BY role');
    assert.deepEqual(posts, [{ profile_id: P.HEAD, role: 'centre_head' }, { profile_id: P.STU2, role: 'vice_centre_head' }]);
    const [s] = await rows(db, 'SELECT centre_id FROM public.profiles WHERE id = $1', [P.STU1]);
    assert.equal(s.centre_id, kta);
    assert.notEqual(kta, brn);
  });

  it('an owner can make a second owner, and the last owner cannot be removed', async () => {
    const { db } = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.OWNER2, 'owner')).ok, true);
    await as(db, P.OWNER2);
    assert.equal((await setRole(db, P.OWNER, 'director')).ok, true, 'owners may manage owners');
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.OWNER2, 'director')).ok, false);
    const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM public.profiles WHERE role = 'owner' AND active");
    assert.equal(n, 1);
  });

  it('a centre head cannot use the network powers', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.HEAD, 'centre_head', kta)).ok, true);
    assert.equal((await setRole(db, P.STU2, 'student', kta)).ok, true);
    await as(db, P.HEAD);
    assert.match((await setRole(db, P.STU2, 'centre_head', kta)).error, /below your own level|already has a head/);
    assert.match((await setRole(db, P.STU1, 'student', kta)).error, /own centre/, 'cannot pull a student from another centre');
    assert.match((await setRole(db, P.STU2, 'student', brn)).error, /own centre/, 'cannot push a student to another centre');
    const g = await attempt(db, "INSERT INTO public.centre_visibility (source_centre_id, mode) VALUES ($1, 'all')", [kta]);
    assert.equal(g.ok, false, 'heads cannot open students for duels');
  });

  it('owners and directors can save duel openings; teachers cannot', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.DIRECTOR);
    const ok = await attempt(db, "INSERT INTO public.centre_visibility (source_centre_id, viewer_centre_id, mode, top_n) VALUES ($1, $2, 'top_n', 10) RETURNING id",
      [brn, kta]);
    assert.equal(ok.ok, true, ok.error);
    assert.equal((await attempt(db, 'DELETE FROM public.centre_visibility WHERE id = $1', [ok.rows[0].id])).ok, true);
    await as(db, P.TEACHER);
    assert.equal((await attempt(db, "INSERT INTO public.centre_visibility (source_centre_id, mode) VALUES ($1, 'all')", [brn])).ok, false);
  });

  it('the audit log records the panel changes and only network staff read all of it', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.HEAD, 'centre_head', kta)).ok, true);
    await attempt(db, "UPDATE public.centres SET status = 'suspended' WHERE id = $1", [kta]);
    const actions = (await rows(db, 'SELECT action FROM public.role_audit WHERE actor_id = $1', [P.DIRECTOR])).map((r) => r.action);
    for (const a of ['role_change', 'centre_staff_insert', 'centres_update']) assert.ok(actions.includes(a), a);
    await as(db, P.DIRECTOR);
    assert.ok((await attempt(db, 'SELECT * FROM public.role_audit')).rows.length > 0);
    await as(db, P.TEACHER);
    assert.equal((await attempt(db, 'SELECT * FROM public.role_audit')).rows.length, 0);
    await as(db, '', 'anon');
    assert.equal((await attempt(db, 'SELECT * FROM public.role_audit')).ok, false);
  });
});

// ---------------------------------------------------------------------------
// API: create_staff
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function fakeClients({ rpcError = null, centre = { id: id(90), status: 'active' }, createError = null } = {}) {
  const calls = { createUser: [], deleteUser: [], rpc: [] };
  const query = (table) => {
    const q = {
      _table: table,
      select() { return q; },
      eq() { return q; },
      maybeSingle: async () => (table === 'centres' ? { data: centre, error: null } : { data: { id: 'new-user' }, error: null }),
      single: async () => ({ data: { id: 'new-user', role: 'director' }, error: null }),
    };
    return q;
  };
  const adminClient = {
    from: query,
    auth: {
      admin: {
        createUser: async (args) => {
          calls.createUser.push(args);
          return createError ? { data: null, error: createError } : { data: { user: { id: 'new-user' } }, error: null };
        },
        deleteUser: async (uid) => { calls.deleteUser.push(uid); return { error: null }; },
      },
    },
  };
  const callerClient = {
    rpc: async (fn, args) => { calls.rpc.push({ fn, args }); return { error: rpcError }; },
  };
  return { adminClient, callerClient, calls };
}

const owner = { id: P.OWNER, role: 'admin', network_role: 'owner', active: true, accessToken: 't' };
const director = { id: P.DIRECTOR, role: 'admin', network_role: 'director', active: true, accessToken: 't' };
const body = (extra = {}) => ({ action: 'create_staff', staff_code: 'dir02', full_name: 'New Director', password: 'longpassword', role: 'director', ...extra });

describe('API create_staff', () => {
  it('an owner creates a director: the role is given through the caller session, not the service key', async () => {
    const { adminClient, callerClient, calls } = fakeClients();
    const res = fakeRes();
    await createStaff({ body: body() }, res, owner, { adminClient, callerClient });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.createUser[0].email, 'dir02@trendz.local');
    assert.deepEqual(calls.createUser[0].user_metadata, { student_code: 'DIR02', full_name: 'New Director' });
    assert.equal(calls.createUser[0].user_metadata.role, undefined, 'no role in user metadata');
    assert.deepEqual(calls.rpc, [{ fn: 'set_person_role', args: { p_target: 'new-user', p_role: 'director', p_centre: null } }]);
    assert.equal(JSON.stringify(res.body).includes('longpassword'), false, 'password is never returned');
  });

  it('an owner can create a second owner', async () => {
    const { adminClient, callerClient, calls } = fakeClients();
    const res = fakeRes();
    await createStaff({ body: body({ role: 'owner', staff_code: 'OWN02' }) }, res, owner, { adminClient, callerClient });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.rpc[0].args.p_role, 'owner');
  });

  for (const role of ['owner', 'director']) {
    it(`a director cannot create an ${role}; no account is made`, async () => {
      const { adminClient, callerClient, calls } = fakeClients();
      const res = fakeRes();
      await createStaff({ body: body({ role }) }, res, director, { adminClient, callerClient });
      assert.equal(res.statusCode, 403);
      assert.equal(calls.createUser.length, 0);
    });
  }

  it('a director can create a centre head for an active centre', async () => {
    const { adminClient, callerClient, calls } = fakeClients();
    const res = fakeRes();
    await createStaff({ body: body({ role: 'centre_head', centre_id: id(90) }) }, res, director, { adminClient, callerClient });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(calls.rpc[0].args, { p_target: 'new-user', p_role: 'centre_head', p_centre: id(90) });
  });

  it('refuses a suspended centre before creating anything', async () => {
    const { adminClient, callerClient, calls } = fakeClients({ centre: { id: id(90), status: 'suspended' } });
    const res = fakeRes();
    await createStaff({ body: body({ role: 'vice_centre_head', centre_id: id(90) }) }, res, director, { adminClient, callerClient });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.createUser.length, 0);
  });

  it('heads, teachers, students and inactive owners are refused', async () => {
    for (const caller of [
      { id: 'h', role: 'centre_head', network_role: 'centre_head', active: true },
      { id: 't', role: 'teacher', network_role: 'teacher', active: true },
      { id: 's', role: 'student', network_role: 'student', active: true },
      { ...owner, active: false },
      // A forged network_role on a non-admin profile does not help.
      { id: 'x', role: 'teacher', network_role: 'teacher', active: true, claimed: 'owner' },
    ]) {
      const { adminClient, callerClient, calls } = fakeClients();
      const res = fakeRes();
      await createStaff({ body: body({ role: 'vice_centre_head', centre_id: id(90) }) }, res, caller, { adminClient, callerClient });
      assert.equal(res.statusCode, 403, caller.id);
      assert.equal(calls.createUser.length, 0);
    }
  });

  it('if the database refuses the role, the new login is deleted again', async () => {
    const { adminClient, callerClient, calls } = fakeClients({ rpcError: { message: 'This centre already has a head. Change the current head first.' } });
    const res = fakeRes();
    await createStaff({ body: body({ role: 'centre_head', centre_id: id(90) }) }, res, director, { adminClient, callerClient });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /already has a head/);
    assert.deepEqual(calls.deleteUser, ['new-user']);
  });

  it('a taken login code gives a clear message', async () => {
    const { adminClient, callerClient } = fakeClients({ createError: { message: 'A user with this email address has already been registered' } });
    const res = fakeRes();
    await createStaff({ body: body() }, res, owner, { adminClient, callerClient });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'That login code is already in use.');
  });

  it('validates the form', () => {
    assert.match(validateStaffInput(body({ password: 'short' })).error, /8 characters/);
    assert.match(validateStaffInput(body({ staff_code: 'a b' })).error, /Login code/);
    assert.match(validateStaffInput(body({ role: 'teacher' })).error, /Choose a role/);
    assert.match(validateStaffInput(body({ role: 'centre_head' })).error, /Choose a centre/);
    assert.match(validateStaffInput(body({ role: 'director', centre_id: id(90) })).error, /leave the centre empty/);
    assert.deepEqual(validateStaffInput(body({ role: 'centre_head', centre_id: id(90) })),
      { code: 'DIR02', name: 'New Director', password: 'longpassword', role: 'centre_head', centreId: id(90) });
  });

  it('rank rule matches the database', () => {
    assert.equal(canCreateStaffRole('owner', 'owner'), true);
    assert.equal(canCreateStaffRole('admin', 'director'), true);
    assert.equal(canCreateStaffRole('director', 'director'), false);
    assert.equal(canCreateStaffRole('director', 'centre_head'), true);
    assert.equal(canCreateStaffRole('centre_head', 'vice_centre_head'), false, 'heads use their own panel (step 4)');
    assert.equal(canCreateStaffRole('owner', 'teacher'), false, 'teachers are made on the Teachers page');
  });

  it('the endpoint routes create_staff to verifyStaffCaller (401 without a token)', async () => {
    const { teacherEndpointHandler } = await import('../api/_teacherAdmin.js');
    const res = fakeRes();
    await teacherEndpointHandler({ method: 'POST', headers: {}, body: body() }, res);
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

describe('network panel logic', () => {
  const centres = [
    { id: 'brn', name: 'Baran Centre', code: 'BRN', status: 'active', is_default: true },
    { id: 'kta', name: 'Kota Centre', code: 'KTA', status: 'active', is_default: false },
    { id: 'old', name: 'Old', code: 'OLD', status: 'archived', is_default: false },
  ];
  const people = [
    { id: 'o', full_name: 'Owner', role: 'owner', centre_id: null, active: true },
    { id: 'd', full_name: 'Dee', role: 'director', centre_id: null, active: true },
    { id: 'h', full_name: 'Hari', role: 'centre_head', centre_id: 'kta', active: true },
    { id: 't', full_name: 'Tara', role: 'teacher', centre_id: 'brn', active: true },
    { id: 's1', full_name: 'Asha', student_code: 'STU001', role: 'student', centre_id: 'brn', active: true },
    { id: 's2', full_name: 'Ravi', student_code: 'STU002', role: 'student', centre_id: 'kta', active: false },
    { id: 's3', full_name: 'Gone', role: 'student', centre_id: 'brn', active: true, deleted_at: '2026-01-01' },
  ];
  const posts = [{ centre_id: 'kta', profile_id: 'h', role: 'centre_head', ended_at: null }];

  it('roles each network role can give and create', () => {
    assert.deepEqual(assignableRoles('owner'), ['owner', 'director', 'centre_head', 'vice_centre_head', 'teacher', 'student']);
    assert.deepEqual(assignableRoles('director'), ['centre_head', 'vice_centre_head', 'teacher', 'student']);
    assert.deepEqual(creatableStaffRoles('director'), ['centre_head', 'vice_centre_head']);
    assert.deepEqual(creatableStaffRoles('centre_head'), []);
  });

  it('who can be managed', () => {
    const dir = people[1];
    const own = people[0];
    assert.equal(canManagePerson(dir, own), false);
    assert.equal(canManagePerson(dir, people[1]), false, 'not yourself');
    assert.equal(canManagePerson(dir, people[2]), true);
    assert.equal(canManagePerson(own, { id: 'o2', role: 'owner' }), true);
    assert.equal(canManagePerson({ id: 'h', role: 'centre_head' }, people[4]), false, 'heads do not use this panel');
  });

  it('centre buttons: the default centre can only be edited; archive needs an empty centre', () => {
    assert.deepEqual(centreActions(centres[0], { people: 0 }), ['edit']);
    assert.deepEqual(centreActions(centres[1], { people: 2, posts: 1 }), ['edit', 'suspend']);
    assert.deepEqual(centreActions(centres[1], { people: 0, posts: 0 }), ['edit', 'suspend', 'archive']);
    assert.deepEqual(centreActions({ ...centres[1], status: 'suspended' }, {}), ['edit', 'activate', 'archive']);
    assert.deepEqual(centreActions(centres[2], {}), ['edit', 'restore']);
  });

  it('dashboard counts per centre and for the network, ignoring deleted people', () => {
    const stats = centreStats(centres, people, posts);
    const kta = stats.find((s) => s.centre.id === 'kta');
    const brn = stats.find((s) => s.centre.id === 'brn');
    assert.equal(brn.students, 1);
    assert.equal(brn.teachers, 1);
    assert.equal(kta.students, 1);
    assert.equal(kta.activeStudents, 0);
    assert.equal(kta.head.full_name, 'Hari');
    assert.equal(kta.people, 2);
    assert.deepEqual(networkTotals(people), { students: 2, activeStudents: 1, teachers: 1, heads: 1, network: 2 });
  });

  it('people filter by centre, role and search', () => {
    assert.deepEqual(filterPeople(people, { centreId: 'brn' }).map((p) => p.id), ['t', 's1']);
    assert.deepEqual(filterPeople(people, { centreId: 'network' }).map((p) => p.id), ['o', 'd']);
    assert.deepEqual(filterPeople(people, { role: 'staff' }).map((p) => p.id), ['o', 'd', 'h', 't']);
    assert.deepEqual(filterPeople(people, { query: 'stu002' }).map((p) => p.id), ['s2']);
    assert.deepEqual(filterPeople(people, { role: 'student', showInactive: false }).map((p) => p.id), ['s1']);
  });

  it('centre and grant validation', () => {
    assert.equal(validateCentreInput({ name: 'Kota Centre', code: 'kta' }), null);
    assert.match(validateCentreInput({ name: 'K', code: 'KTA' }), /2–80/);
    assert.match(validateCentreInput({ name: 'Kota', code: 'K-1' }), /2–8/);
    assert.match(validateGrant({ mode: 'all' }), /Choose the centre/);
    assert.match(validateGrant({ source_centre_id: 'brn', viewer_centre_id: 'brn', mode: 'all' }), /different centre/);
    assert.match(validateGrant({ source_centre_id: 'brn', mode: 'top_n', top_n: '0' }), /1 to 500/);
    assert.match(validateGrant({ source_centre_id: 'brn', mode: 'students', student_ids: [] }), /at least one/);
    assert.deepEqual(grantRow({ source_centre_id: 'brn', viewer_centre_id: '', mode: 'top_n', top_n: '5', student_ids: ['x'] }),
      { source_centre_id: 'brn', viewer_centre_id: null, mode: 'top_n', top_n: 5, student_ids: null, purpose: 'duels' });
  });

  it('readable audit lines and grant summaries', () => {
    const names = new Map([['d', 'Dee'], ['h', 'Hari']]);
    const byId = new Map(centres.map((c) => [c.id, c]));
    assert.equal(describeAudit({ action: 'role_change', actor_id: 'd', target_id: 'h', before: { role: 'teacher' }, after: { role: 'centre_head' } }, names, byId),
      'Dee changed Hari from Teacher to Centre head');
    assert.equal(describeAudit({ action: 'transfer', actor_id: 'd', target_id: 'h', before: { centre_id: 'brn' }, after: { centre_id: 'kta' } }, names, byId),
      'Dee moved Hari from Baran Centre to Kota Centre');
    assert.equal(describeAudit({ action: 'centres_update', actor_id: 'd', before: { name: 'Kota Centre', status: 'active' }, after: { name: 'Kota Centre', status: 'suspended' } }, names, byId),
      'Dee set centre Kota Centre to suspended');
    assert.equal(describeGrant({ source_centre_id: 'brn', viewer_centre_id: null, mode: 'top_n', top_n: 10 }, byId),
      'Baran Centre: top 10 students, open to every centre for duels');
  });

  it('the centre switcher remembers only centres that exist', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    writeActiveCentre(storage, 'kta');
    assert.equal(store.get(ACTIVE_CENTRE_KEY), 'kta');
    assert.equal(readActiveCentre(storage, centres), 'kta');
    assert.equal(readActiveCentre(storage, [centres[0]]), '', 'a removed centre falls back to all');
    writeActiveCentre(storage, '');
    assert.equal(readActiveCentre(storage, centres), '');
  });

  it('the Network link shows only for owners and directors', () => {
    const has = (p) => resolveRailItems(p, '/pages/admin.html')?.byId.has('admin-network') || false;
    assert.equal(has({ role: 'admin', network_role: 'owner' }), true);
    assert.equal(has({ role: 'admin', network_role: 'director' }), true);
    assert.equal(has({ role: 'admin', network_role: 'admin' }), true);
    assert.equal(has({ role: 'admin' }), false, 'no network_role, no link');
    assert.equal(has({ role: 'teacher', network_role: 'teacher' }), false);
  });
});
