/**
 * Migration 29: report helper RPCs are no longer callable by anon or signed-in users.
 *
 * Runs the real migration on PGlite against stub functions with the production
 * signatures, then checks:
 *   - anon and authenticated get "permission denied" on the leaking functions;
 *   - service_role can still call them;
 *   - a SECURITY DEFINER caller (like leaderboard / admin_milestones) still works
 *     for a signed-in user, because nested calls run as the function owner.
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/29_revoke_public_report_rpcs.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'supabase/rollbacks/29_revoke_public_report_rpcs_rollback.sql'), 'utf8');

const LOCKED = [
  'weekly_report_data()',
  "mirror_student_data('00000000-0000-0000-0000-000000000001')",
  'mirror_fingerprints()',
  'milestones_recent(7)',
  "practice_stats_for('00000000-0000-0000-0000-000000000001', current_date, current_date)",
  "practice_days_for('00000000-0000-0000-0000-000000000001', current_date, current_date)",
  "points_for('00000000-0000-0000-0000-000000000001', current_date, current_date)",
];

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE FUNCTION public.weekly_report_data() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{"students":[]}'::jsonb $$;
    CREATE FUNCTION public.mirror_student_data(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.mirror_fingerprints() RETURNS TABLE(student_id uuid, fingerprint text) LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::uuid, 'x' $$;
    CREATE FUNCTION public.milestones_recent(p_days integer) RETURNS TABLE(n int) LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
    CREATE FUNCTION public.practice_stats_for(p uuid, a date, b date) RETURNS TABLE(n int) LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
    CREATE FUNCTION public.practice_days_for(p uuid, a date, b date) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 3 $$;
    CREATE FUNCTION public.points_for(p uuid, a date, b date) RETURNS numeric LANGUAGE sql SECURITY DEFINER AS $$ SELECT 5 $$;
    CREATE FUNCTION public.weekly_test_check(a uuid, b uuid, c uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.student_level(p uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'Master' $$;
    -- Stand-in for leaderboard / admin_milestones: a definer function that calls the helpers.
    CREATE FUNCTION public.definer_caller() RETURNS numeric LANGUAGE sql SECURITY DEFINER AS $$
      SELECT public.points_for(NULL, current_date, current_date) + public.practice_days_for(NULL, current_date, current_date)
             + (SELECT count(*) FROM public.milestones_recent(7))
    $$;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
  `);
  return db;
}

async function callAs(db, role, expr) {
  await db.exec(`SET ROLE ${role}`);
  try {
    await db.query(`SELECT public.${expr}`);
    return 'ok';
  } catch (err) {
    return /permission denied/i.test(err.message) ? 'denied' : `error: ${err.message}`;
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('migration 29: revoke public report RPCs', () => {
  let db;
  before(async () => {
    db = await freshDb();
    // Before the migration everyone can call them: this is the leak.
    assert.equal(await callAs(db, 'anon', 'weekly_report_data()'), 'ok');
    await db.exec(MIGRATION);
  });

  for (const expr of LOCKED) {
    it(`anon and authenticated cannot call ${expr.split('(')[0]}`, async () => {
      assert.equal(await callAs(db, 'anon', expr), 'denied');
      assert.equal(await callAs(db, 'authenticated', expr), 'denied');
    });
    it(`service_role can still call ${expr.split('(')[0]}`, async () => {
      assert.equal(await callAs(db, 'service_role', expr), 'ok');
    });
  }

  it('anon cannot call weekly_test_check or student_level; signed-in users still can', async () => {
    const wt = "weekly_test_check(NULL, NULL, NULL)";
    assert.equal(await callAs(db, 'anon', wt), 'denied');
    assert.equal(await callAs(db, 'anon', 'student_level(NULL)'), 'denied');
    assert.equal(await callAs(db, 'authenticated', wt), 'ok');
    assert.equal(await callAs(db, 'authenticated', 'student_level(NULL)'), 'ok');
  });

  it('SECURITY DEFINER callers (leaderboard, admin_milestones) keep working for signed-in users', async () => {
    assert.equal(await callAs(db, 'authenticated', 'definer_caller()'), 'ok');
  });

  it('rollback restores the previous grants', async () => {
    const rb = await freshDb();
    await rb.exec(MIGRATION);
    await rb.exec(ROLLBACK);
    assert.equal(await callAs(rb, 'anon', 'weekly_report_data()'), 'ok');
    assert.equal(await callAs(rb, 'authenticated', 'points_for(NULL, current_date, current_date)'), 'ok');
  });
});
