/**
 * Trendz Tracker — Phase 19 Implementation Enforcement & PostgreSQL Verification
 * File: tests/phase19_implementation_enforcement.test.js
 *
 * Verifies Phase 19 requirements against real implementations (no simulated stubs):
 * 1. Real PostgreSQL (PGlite) migration execution & baseline upgrade over Phase 18 definitions
 * 2. Database contract preservation for todo_status_on (exact arguments, types, error codes, auth logic)
 * 3. Migration idempotency (rerun safety)
 * 4. Credit rule in PostgreSQL: empty expiry attempts (total = 0) earn 0 credit in todo_status_on; non-zero attempts earn credit
 * 5. student_rounds_teacher_select RLS policy enforcement (is_teacher + permissions + assignment)
 * 6. save_daily_task_atomic accepting duration_seconds and enforcing constraints (5..3600)
 * 7. Real HTTP endpoint handlers (drillHandler and memoriadHandler):
 *    - Invalid task assignments: blank, non-string, forged (404), section mismatch (400), drill mismatch (400), unassigned student (403), inactive (400)
 *    - Memoriad: forged finished_by: 'time_up' rejected early (400); complete early submit accepted (200); empty expiry at deadline saved with total=0 and 0 credit; incomplete expiry at deadline saves and earns credit; duplicate submit returns 409
 *    - Elements Drill: incomplete early submit rejected (400); complete early submit accepted (200); empty expiry at deadline saved with total=0 and 0 credit; delayed delivery preserves frozen duration (no transit penalty); forged tiny duration rejected (400); duplicate submit returns 400
 *    - Basics: unlimited practice > 60s records true duration (not capped at 60s); timed assigned task earns credit
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import drillHandler from '../api/drill.js';
import memoriadHandler from '../api/memoriad.js';
import { resolveAndValidateDailyTask } from '../api/_dailyTasks.js';
import { DRILLS } from '../api/_drills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to create mock HTTP req/res
function createMockReq({ method = 'POST', body = {}, student, adminSupabase }) {
  return {
    method,
    body,
    _testStudent: student,
    _testAdminSupabase: adminSupabase,
    headers: {},
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

// Test Supabase client adapter connecting API handlers to in-memory tables and PGlite
function createTestAdminSupabase(db) {
  const store = {
    drill_sessions: new Map(),
    activity_results: new Map(),
    results: new Map(),
    daily_tasks: new Map(),
    daily_task_recipients: new Set(),
    categories: new Map(),
    basics_thresholds: new Map(),
    profiles: new Map(),
    mockErrors: { update: {} },
  };

  function from(table) {
    let selectedCols = '*';
    let countExact = false;
    const filters = [];
    let isSingle = false;
    let isMaybeSingle = false;

    async function runSelect() {
      if (table === 'daily_task_recipients') {
        let match = null;
        for (const key of store.daily_task_recipients) {
          const [tId, sId] = key.split(':');
          const candidate = { task_id: tId, student_id: sId };
          if (filters.every((fn) => fn(candidate))) {
            match = candidate;
            break;
          }
        }
        return { data: match, error: null };
      }
      const map = store[table];
      const allRows = map ? Array.from(map.values()) : [];
      const matching = allRows.filter((r) => filters.every((fn) => fn(r)));
      if (countExact) {
        return { count: matching.length, data: null, error: null };
      }
      if (isSingle) {
        if (matching.length === 0) return { data: null, error: new Error('Row not found') };
        return { data: matching[0], error: null };
      }
      if (isMaybeSingle) {
        return { data: matching[0] || null, error: null };
      }
      return { data: matching, error: null };
    }

    const selectBuilder = {
      select(cols = '*', options = {}) {
        selectedCols = cols;
        if (options?.count === 'exact') countExact = true;
        return selectBuilder;
      },
      eq(col, val) {
        filters.push((row) => row[col] === val);
        return selectBuilder;
      },
      neq(col, val) {
        filters.push((row) => row[col] !== val);
        return selectBuilder;
      },
      gte(col, val) {
        filters.push((row) => {
          const rowVal = row[col];
          if (typeof rowVal === 'string' && typeof val === 'string') {
            return new Date(rowVal).getTime() >= new Date(val).getTime();
          }
          return rowVal >= val;
        });
        return selectBuilder;
      },
      in(col, vals) {
        filters.push((row) => Array.isArray(vals) && vals.includes(row[col]));
        return selectBuilder;
      },
      single() {
        isSingle = true;
        return runSelect();
      },
      maybeSingle() {
        isMaybeSingle = true;
        return runSelect();
      },
      then(resolve, reject) {
        return runSelect().then(resolve, reject);
      },
      insert(payload) {
        let insertSingle = false;
        let insertMaybeSingle = false;

        async function runInsert() {
          const rows = Array.isArray(payload) ? payload : [payload];
          const inserted = [];
          for (const item of rows) {
            const row = {
              id: item.id || crypto.randomUUID(),
              created_at: item.created_at || new Date().toISOString(),
              ...item,
            };
            if (store[table]) {
              store[table].set(row.id, row);
            }
            if (table === 'activity_results') {
              await db.query(
                `INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, total, correct, time_seconds, settings, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  row.id,
                  row.student_id,
                  row.activity_type,
                  row.activity_name,
                  row.total || 0,
                  row.correct || 0,
                  row.time_seconds || 0,
                  JSON.stringify(row.settings || {}),
                  row.created_at,
                ]
              );
            } else if (table === 'results') {
              const formattedDate = row.entry_date instanceof Date
                ? row.entry_date.toISOString().slice(0, 10)
                : (typeof row.entry_date === 'string' && row.entry_date.includes('T')
                    ? row.entry_date.slice(0, 10)
                    : (typeof row.entry_date === 'string' && row.entry_date.length === 10
                        ? row.entry_date
                        : new Date().toISOString().slice(0, 10)));
              await db.query(
                `INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  row.id,
                  row.student_id,
                  row.category_id,
                  row.total || 0,
                  row.correct || 0,
                  row.time_seconds || 0,
                  formattedDate,
                  row.source || 'typed',
                  row.created_at,
                ]
              );
            } else if (table === 'drill_sessions') {
              await db.query(
                `INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, expires_at, status, submitted_at, result_id, result_row_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 ON CONFLICT (id) DO UPDATE SET
                   status = EXCLUDED.status,
                   submitted_at = EXCLUDED.submitted_at,
                   result_id = EXCLUDED.result_id,
                   result_row_id = EXCLUDED.result_row_id,
                   settings = EXCLUDED.settings;`,
                [
                  row.id,
                  row.student_id,
                  row.activity_type,
                  row.activity_name || row.activity_type,
                  JSON.stringify(row.settings || {}),
                  JSON.stringify(row.questions || []),
                  JSON.stringify(row.expected || []),
                  row.min_seconds || 0,
                  row.started_at || new Date().toISOString(),
                  row.expires_at || new Date(Date.now() + 3600000).toISOString(),
                  row.status || 'open',
                  row.submitted_at || null,
                  row.result_id || null,
                  row.result_row_id || null,
                ]
              );
            }
            inserted.push(row);
          }
          const resData = insertSingle
            ? inserted[0]
            : insertMaybeSingle
              ? (inserted[0] || null)
              : (Array.isArray(payload) ? inserted : inserted[0]);
          return { data: resData, error: null };
        }

        const insertBuilder = {
          select(cols = '*') {
            return insertBuilder;
          },
          single() {
            insertSingle = true;
            return runInsert();
          },
          maybeSingle() {
            insertMaybeSingle = true;
            return runInsert();
          },
          then(resolve, reject) {
            return runInsert().then(resolve, reject);
          },
        };
        return insertBuilder;
      },
      delete() {
        const deleteFilters = [];
        async function runDelete() {
          const map = store[table];
          if (map) {
            for (const [id, row] of map.entries()) {
              if (deleteFilters.every((fn) => fn(row))) {
                map.delete(id);
                if (table === 'results') {
                  await db.query('DELETE FROM public.results WHERE id = $1', [id]);
                } else if (table === 'drill_sessions') {
                  await db.query('DELETE FROM public.drill_sessions WHERE id = $1', [id]);
                } else if (table === 'activity_results') {
                  await db.query('DELETE FROM public.activity_results WHERE id = $1', [id]);
                }
              }
            }
          }
          return { data: null, error: null };
        }
        const deleteBuilder = {
          eq(col, val) {
            deleteFilters.push((row) => row[col] === val);
            return deleteBuilder;
          },
          then(resolve, reject) {
            return runDelete().then(resolve, reject);
          },
        };
        return deleteBuilder;
      },
      update(patch) {
        const updateFilters = [];
        async function runUpdate() {
          if (patch.result_row_id && store.mockErrors?.update?.drill_sessions_linkage) {
            const err = store.mockErrors.update.drill_sessions_linkage;
            delete store.mockErrors.update.drill_sessions_linkage;
            return { data: null, error: err };
          }
          if (store.mockErrors?.update?.[table]) {
            const err = store.mockErrors.update[table];
            delete store.mockErrors.update[table];
            return { data: null, error: err };
          }
          const map = store[table];
          if (!map) return { data: [], error: null };
          const updated = [];
          for (const [id, row] of map.entries()) {
            if (updateFilters.every((fn) => fn(row))) {
              const next = { ...row, ...patch };
              map.set(id, next);
              updated.push(next);
            }
          }
          if (table === 'drill_sessions') {
            for (const next of updated) {
              await db.query(
                `UPDATE public.drill_sessions
                 SET status = $1,
                     submitted_at = $2,
                     result_id = $3,
                     result_row_id = $4,
                     settings = $5
                 WHERE id = $6`,
                [
                  next.status,
                  next.submitted_at || null,
                  next.result_id || null,
                  next.result_row_id || null,
                  JSON.stringify(next.settings || {}),
                  next.id,
                ]
              );
            }
          }
          return { data: updated, error: null };
        }

        const updateBuilder = {
          eq(col, val) {
            updateFilters.push((row) => row[col] === val);
            return updateBuilder;
          },
          select(cols = '*') {
            return updateBuilder;
          },
          single() {
            return runUpdate().then((res) => ({ data: res.data ? res.data[0] || null : null, error: res.error }));
          },
          maybeSingle() {
            return runUpdate().then((res) => ({ data: res.data ? res.data[0] || null : null, error: res.error }));
          },
          then(resolve, reject) {
            return runUpdate().then(resolve, reject);
          },
        };
        return updateBuilder;
      },
    };
    return selectBuilder;
  }

  return {
    from,
    rpc: async (fn, args) => {
      if (fn === 'today_ist') {
        const res = await db.query('SELECT public.today_ist()::TEXT AS d;');
        return { data: String(res.rows[0].d).trim(), error: null };
      }
      return { data: null, error: null };
    },
    setNextUpdateError(table, error) {
      store.mockErrors.update[table] = error;
    },
    store,
  };
}

describe('Phase 19 — Real PostgreSQL (PGlite) Migration & Baseline Upgrade Verification', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const teacherAId = '22222222-2222-2222-2222-222222222222';
  const teacherBId = '33333333-3333-3333-3333-333333333333';
  const student1Id = '44444444-4444-4444-4444-444444444444';
  const student2Id = '55555555-5555-5555-5555-555555555555';
  const inactiveStudentId = '66666666-6666-6666-6666-666666666666';

  const setAuth = async (userId, role = 'authenticated') => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '${userId || ''}', false);
      SELECT set_config('app.current_jwt_role', '${role}', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
    `);
    if (role === 'authenticated' || role === 'anon') {
      await db.exec(`SET ROLE ${role};`);
    } else {
      await db.exec(`SET ROLE postgres;`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles and auth mock
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object('role', auth.role());
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Baseline Phase 18 schema
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        level TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID NULL,
        level TEXT NULL,
        activity_key TEXT NULL,
        flash_digits INT NULL,
        flash_count INT NULL,
        flash_speed_ms INT NULL,
        flash_mode TEXT NULL,
        required_count INT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID NULL,
        target_scope TEXT NOT NULL DEFAULT 'all'
      );

      CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.student_rounds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        series_id TEXT NULL,
        round_index INT NULL,
        total_score NUMERIC NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id),
        student_round_id UUID NULL,
        total INT NOT NULL DEFAULT 0,
        correct INT NOT NULL DEFAULT 0,
        time_seconds NUMERIC NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'typed',
        entry_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element', 'basics', 'round', 'memoriad')),
        activity_name TEXT NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds NUMERIC NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID
      );

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        total INT NOT NULL DEFAULT 0,
        correct INT NOT NULL DEFAULT 0,
        time_seconds NUMERIC NOT NULL DEFAULT 0,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.teacher_student_assignments (
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (teacher_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.teacher_permissions (
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        PRIMARY KEY (teacher_id, permission)
      );

      -- Helper functions
      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid() AND role = 'admin' AND active = true
        ) OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = p_uid AND role = 'teacher' AND active = true
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_uid UUID, p_perm TEXT) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_permissions
          WHERE teacher_id = p_uid AND permission = p_perm
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher UUID, p_student UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_student_assignments
          WHERE teacher_id = p_teacher AND student_id = p_student
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id UUID, p_student UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.daily_task_recipients
          WHERE task_id = p_task_id AND student_id = p_student
        );
      $$ LANGUAGE sql STABLE;

      -- Pre-Phase-19 Flash RPC baseline definitions
      CREATE OR REPLACE FUNCTION public.flash_generate_question(p_digits integer, p_count integer, p_mode text)
      RETURNS integer[]
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_nums integer[] := ARRAY[]::integer[];
        v_lo integer;
        v_hi integer;
        v_n integer;
        v_sign integer;
        v_total integer := 0;
        v_prev integer := NULL;
        v_tries integer;
      BEGIN
        v_lo := 10^(p_digits - 1);
        v_hi := (10^p_digits) - 1;
        FOR i IN 1..p_count LOOP
          v_tries := 0;
          LOOP
            v_tries := v_tries + 1;
            v_n := v_lo + floor(random() * (v_hi - v_lo + 1))::integer;
            v_sign := 1;
            IF p_mode = 'add_sub' AND i > 1 AND random() < 0.4 THEN
              v_sign := -1;
            END IF;
            IF v_sign = -1 AND v_total - v_n < 0 THEN
              v_sign := 1;
            END IF;
            EXIT WHEN v_prev IS NULL OR v_n <> v_prev OR v_tries > 20;
          END LOOP;
          v_nums := v_nums || (v_sign * v_n);
          v_total := v_total + v_sign * v_n;
          v_prev := v_n;
        END LOOP;
        RETURN v_nums;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.flash_start(p_settings jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      DECLARE
        v_digits integer;
        v_count integer;
        v_speed integer;
        v_mode text;
        v_nums integer[];
        v_sum integer;
        v_min numeric;
        v_settings jsonb;
        v_id uuid;
        v_profile public.profiles;
      BEGIN
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;

        SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
        IF NOT FOUND OR NOT v_profile.active THEN
          RAISE EXCEPTION 'This account is not active.';
        END IF;

        BEGIN
          v_digits := (p_settings ->> 'digits')::integer;
          v_count := (p_settings ->> 'count')::integer;
          v_speed := (p_settings ->> 'speed_ms')::integer;
          v_mode := COALESCE(p_settings ->> 'mode', 'add');
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'The settings are not valid.';
        END;

        IF v_digits IS NULL OR v_count IS NULL OR v_speed IS NULL
           OR v_digits < 1 OR v_digits > 5
           OR v_count < 2 OR v_count > 1000
           OR v_speed < 200 OR v_speed > 5000
           OR v_mode NOT IN ('add', 'add_sub') THEN
          RAISE EXCEPTION 'The settings are not valid.';
        END IF;

        v_nums := public.flash_generate_question(v_digits, v_count, v_mode);
        SELECT sum(x)::integer INTO v_sum FROM unnest(v_nums) AS x;
        v_min := 2.0 + (v_count * (v_speed + 80) / 1000.0);
        v_settings := jsonb_build_object('digits', v_digits, 'count', v_count, 'speed_ms', v_speed, 'mode', v_mode);

        INSERT INTO public.drill_sessions
          (student_id, activity_type, activity_name, settings, questions, expected, min_seconds, expires_at)
        VALUES
          (auth.uid(), 'flash_anzan', 'Flash anzan', v_settings,
           jsonb_build_array(to_jsonb(v_nums)), jsonb_build_array(v_sum), v_min,
           now() + (v_min + 1800) * interval '1 second')
        RETURNING id INTO v_id;

        RETURN jsonb_build_object('session_id', v_id, 'numbers', to_jsonb(v_nums), 'settings', v_settings);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.flash_submit(p_session uuid, p_answer jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      DECLARE
        s public.drill_sessions;
        v_elapsed numeric;
        v_exp jsonb;
        v_ok boolean;
        v_res uuid;
      BEGIN
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;

        SELECT * INTO s FROM public.drill_sessions
         WHERE id = p_session AND student_id = auth.uid() AND activity_type = 'flash_anzan'
           FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'This try was not found.';
        END IF;
        IF s.status <> 'open' THEN
          RAISE EXCEPTION 'This try was already submitted.';
        END IF;
        IF now() > s.expires_at THEN
          RAISE EXCEPTION 'This try expired. Please start a new one.';
        END IF;

        v_elapsed := extract(epoch FROM (now() - s.started_at));
        IF v_elapsed < (s.min_seconds * 0.8) THEN
          RAISE EXCEPTION 'Submitted faster than the numbers could be shown.';
        END IF;

        v_exp := s.expected -> 0;
        v_ok := (p_answer IS NOT NULL AND jsonb_typeof(p_answer) = 'number' AND p_answer = v_exp);

        INSERT INTO public.activity_results
          (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
        VALUES
          (s.student_id, s.activity_type, s.activity_name,
           CASE WHEN v_ok THEN 1 ELSE 0 END, 1,
           round(v_elapsed)::integer, s.settings || jsonb_build_object('session_id', s.id))
        RETURNING id INTO v_res;

        UPDATE public.drill_sessions
           SET status = 'submitted', submitted_at = now(), result_id = v_res
         WHERE id = s.id;

        RETURN jsonb_build_object('correct', v_ok, 'expected', v_exp, 'given', p_answer, 'seconds', round(v_elapsed));
      END;
      $$;

      ALTER TABLE public.student_rounds ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;
    `);

    // 3. Load Phase 18 standalone patch to establish the pre-Phase-19 baseline
    const patchPath = path.join(ROOT_DIR, 'supabase', 'standalone_todo_status_on_patch.sql');
    const patchSql = fs.readFileSync(patchPath, 'utf8');
    await db.exec(patchSql);

    // 4. Insert test fixtures
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, role, level, active) VALUES
        ('${adminId}', 'Admin User', 'admin', NULL, true),
        ('${teacherAId}', 'Teacher Alice', 'teacher', NULL, true),
        ('${teacherBId}', 'Teacher Bob', 'teacher', NULL, true),
        ('${student1Id}', 'Student One', 'student', 'Grand Master', true),
        ('${student2Id}', 'Student Two', 'student', 'Level 1', true),
        ('${inactiveStudentId}', 'Inactive User', 'student', 'Level 1', false);

      -- Teacher A assigned to Student 1 with view_students, manage_tasks, review_scores
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherAId}', '${student1Id}');

      INSERT INTO public.teacher_permissions (teacher_id, permission) VALUES
        ('${teacherAId}', 'view_students'),
        ('${teacherAId}', 'manage_tasks'),
        ('${teacherAId}', 'review_scores');
    `);
  });

  it('1. Verifies Phase 18 baseline contracts before migration', async () => {
    // a) Anonymous rejection
    await setAuth(null, 'anon');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', public.today_ist());`);
      },
      /permission denied|Authentication required|42501/
    );

    // b) Inactive caller rejection
    await setAuth(inactiveStudentId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', public.today_ist());`);
      },
      /Inactive or invalid user|42501/
    );

    // c) Student targeting another student rejected
    await setAuth(student2Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', public.today_ist());`);
      },
      /You may only view your own daily tasks|42501/
    );

    // d) Student targeting self succeeds
    await setAuth(student1Id, 'authenticated');
    const selfRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', public.today_ist());`);
    assert.ok(Array.isArray(selfRes.rows));

    // e) Admin targeting student succeeds
    await setAuth(adminId, 'authenticated');
    const adminRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', public.today_ist());`);
    assert.ok(Array.isArray(adminRes.rows));
  });

  it('2. Applies owner_phase19_improvements_migration.sql cleanly and idempotently with secure rollout_boundaries', async () => {
    // Migrations are executed by database owner
    await db.exec('RESET ROLE;');
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_improvements_migration.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // First execution (upgrade)
    await db.exec(sql);

    // Verify duration_seconds column was added
    const colRes = await db.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'daily_tasks' AND column_name = 'duration_seconds';
    `);
    assert.equal(colRes.rows.length, 1);

    // Verify rollout_boundaries table and seeded installed state (unactivated)
    const rolloutRes = await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `);
    assert.equal(rolloutRes.rows.length, 1);
    assert.equal(rolloutRes.rows[0].feature, 'phase19_authoritative_todo');
    assert.equal(rolloutRes.rows[0].status, 'installed');
    assert.equal(rolloutRes.rows[0].activated_at, null);

    // Verify RLS & privileges on public.rollout_boundaries
    // anon, student, and teacher callers must be rejected with 42501 (permission denied)
    for (const [userId, role] of [[null, 'anon'], [student1Id, 'authenticated'], [teacherAId, 'authenticated']]) {
      await setAuth(userId, role);
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.rollout_boundaries;`);
        },
        /permission denied|42501/
      );
      await assert.rejects(
        async () => {
          await db.query(`INSERT INTO public.rollout_boundaries (feature, status) VALUES ('test', 'installed');`);
        },
        /permission denied|42501/
      );
      await assert.rejects(
        async () => {
          await db.query(`UPDATE public.rollout_boundaries SET status = 'active';`);
        },
        /permission denied|42501/
      );
      await assert.rejects(
        async () => {
          await db.query(`DELETE FROM public.rollout_boundaries;`);
        },
        /permission denied|42501/
      );
    }

    // Reset role to postgres/owner for second execution
    await db.exec('RESET ROLE;');

    // Second execution (idempotent rerun)
    await db.exec(sql);
    assert.ok(true, 'Rerun of migration succeeded without errors.');

    // Ensure status is still installed and activated_at is still null across reruns
    const rerunRolloutRes = await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `);
    assert.equal(rerunRolloutRes.rows[0].status, 'installed');
    assert.equal(rerunRolloutRes.rows[0].activated_at, null);

    // Direct permission check: migration must revoke anon EXECUTE and preserve authenticated/service_role
    const targetFns = ['save_daily_task_atomic', 'flash_start', 'flash_submit', 'todo_status_on'];
    const permRows = (await db.query(`
      SELECT p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[]);
    `, [targetFns])).rows;

    assert.equal(permRows.length, 4, 'All 4 target functions must exist');
    for (const r of permRows) {
      assert.equal(r.anon_can_execute, false, `Migration must revoke anon EXECUTE for ${r.proname}`);
      assert.equal(r.authenticated_can_execute, true, `Migration must grant authenticated EXECUTE for ${r.proname}`);
      assert.equal(r.service_role_can_execute, true, `Migration must grant service_role EXECUTE for ${r.proname}`);
    }
  });

  it('2b. Direct permission checks: verifies explicit anon revocations remove existing anon grants while preserving authenticated and service-role', async () => {
    await db.exec('RESET ROLE;');

    // 1. Simulate prior state: explicit anon grants already exist in database (as occurred on staging)
    await db.exec(`
      GRANT EXECUTE ON FUNCTION public.flash_start(jsonb) TO anon;
      GRANT EXECUTE ON FUNCTION public.flash_submit(uuid, jsonb) TO anon;
      GRANT EXECUTE ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) TO anon;
      GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO anon;
    `);

    // Verify anon previously had execute privilege
    const targetFns = ['save_daily_task_atomic', 'flash_start', 'flash_submit', 'todo_status_on'];
    const preCheck = (await db.query(`
      SELECT p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[]);
    `, [targetFns])).rows;
    assert.equal(preCheck.length, 4);
    for (const row of preCheck) {
      assert.equal(row.anon_can_execute, true, `Prior state: anon had execute on ${row.proname}`);
    }

    // 2. Execute owner_phase19_permissions_fix.sql
    const fixSqlPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_permissions_fix.sql');
    const fixSql = fs.readFileSync(fixSqlPath, 'utf8');
    await db.exec(fixSql);

    // 3. Verify resulting permissions via pg_proc and has_function_privilege
    const postCheck = (await db.query(`
      SELECT p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[]);
    `, [targetFns])).rows;

    assert.equal(postCheck.length, 4, 'All 4 target functions checked');
    for (const row of postCheck) {
      assert.equal(row.anon_can_execute, false, `anon EXECUTE must be false for ${row.proname}`);
      assert.equal(row.authenticated_can_execute, true, `authenticated EXECUTE must be true for ${row.proname}`);
      assert.equal(row.service_role_can_execute, true, `service_role EXECUTE must be true for ${row.proname}`);
    }

    // 4. Verify PostgreSQL engine permission denial when called as role 'anon'
    await db.exec('SET ROLE anon;');
    for (const fn of [
      "SELECT public.flash_start('{}'::jsonb);",
      "SELECT public.flash_submit('00000000-0000-0000-0000-000000000000'::uuid, '1'::jsonb);",
      "SELECT public.save_daily_task_atomic('00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb, ARRAY[]::uuid[]);",
      "SELECT public.todo_status_on('00000000-0000-0000-0000-000000000000'::uuid, CURRENT_DATE);"
    ]) {
      await assert.rejects(
        async () => {
          await db.query(fn);
        },
        /permission denied for function/
      );
    }

    await db.exec('RESET ROLE;');
  });

  it('3. todo_status_on preserves exact parameter signature, provolatile = STABLE, and authorization contract', async () => {
    // Check function volatility is STABLE ('s')
    const procRes = await db.query(`
      SELECT provolatile
      FROM pg_proc
      WHERE proname = 'todo_status_on';
    `);
    assert.equal(procRes.rows.length, 1);
    assert.equal(procRes.rows[0].provolatile, 's', 'todo_status_on must be STABLE');

    // Null student ID -> throws ERRCODE 22023 'Target student ID is required.'
    await setAuth(adminId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on(NULL);`);
      },
      (err) => err.message.includes('Target student ID is required') || err.code === '22023'
    );

    // Anonymous caller -> error 42501
    await setAuth(null, 'anon');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
      },
      (err) => err.message.includes('Authentication required') || err.code === '42501'
    );

    // Inactive caller -> error 42501
    await setAuth(inactiveStudentId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
      },
      (err) => err.message.includes('Inactive or invalid user') || err.code === '42501'
    );

    // Student targeting another student -> error 42501
    await setAuth(student2Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
      },
      (err) => err.message.includes('You may only view your own daily tasks') || err.code === '42501'
    );

    // Service-role detection via request.jwt.claims JSON fallback:
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '', false);
      SELECT set_config('app.current_jwt_role', '', false);
      SELECT set_config('request.jwt.claim.role', '', false);
      SELECT set_config('request.jwt.claims', '{"role": "service_role"}', false);
      SET ROLE service_role;
    `);
    const serviceRoleRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    assert.ok(Array.isArray(serviceRoleRes.rows), 'Service role with request.jwt.claims JSON fallback accepted');
  });

  it('4. todo_status_on enforces teacher assignment and permissions', async () => {
    // Unassigned teacher B targeting Student 1 -> error 42501
    await setAuth(teacherBId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
      },
      (err) => err.message.includes('permission to view daily tasks') || err.code === '42501'
    );

    // Assigned teacher A targeting Student 1 -> succeeds!
    await setAuth(teacherAId, 'authenticated');
    const resA = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    assert.ok(Array.isArray(resA.rows));

    // Admin targeting Student 1 -> succeeds!
    await setAuth(adminId, 'authenticated');
    const resAdmin = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    assert.ok(Array.isArray(resAdmin.rows));

    // Student targeting self -> succeeds!
    await setAuth(student1Id, 'authenticated');
    const resSelf = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    assert.ok(Array.isArray(resSelf.rows));
  });

  it('5. todo_status_on credit rule: empty attempts (total = 0) earn 0 credit; attempts with total > 0 earn credit', async () => {
    await setAuth(adminId, 'authenticated');

    // Create an elements task for 'day_codes'
    const taskRes = await db.query(`
      INSERT INTO public.daily_tasks (title, section, activity_key, required_count, target_scope)
      VALUES ('Daily Day Codes', 'elements', 'day_codes', 1, 'all')
      RETURNING id;
    `);
    const taskId = taskRes.rows[0].id;

    // Student 1 checks todo status: initially done_count = 0, done = false
    await setAuth(student1Id, 'authenticated');
    let statusRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    let myTask = statusRes.rows.find((t) => t.task_id === taskId);
    assert.equal(myTask.done_count, 0);
    assert.equal(myTask.done, false);

    // Insert an empty expiry attempt with total = 0
    await setAuth(adminId, 'authenticated');
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, total, correct, time_seconds, settings)
      VALUES ('${student1Id}', 'element', 'Day Codes', 0, 0, 60, '{"drill": "day_codes"}'::jsonb);
    `);

    // Student checks again: total = 0 must NOT count! done_count remains 0
    await setAuth(student1Id, 'authenticated');
    statusRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    myTask = statusRes.rows.find((t) => t.task_id === taskId);
    assert.equal(myTask.done_count, 0, 'Empty expiry attempt with total=0 earned 0 credit');
    assert.equal(myTask.done, false);

    // Now insert a valid attempt with total = 5, correct = 3
    await setAuth(adminId, 'authenticated');
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, total, correct, time_seconds, settings)
      VALUES ('${student1Id}', 'element', 'Day Codes', 5, 3, 45, '{"drill": "day_codes"}'::jsonb);
    `);

    // Student checks again: valid attempt with total > 0 counts! done_count = 1, done = true
    await setAuth(student1Id, 'authenticated');
    statusRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`);
    myTask = statusRes.rows.find((t) => t.task_id === taskId);
    assert.equal(myTask.done_count, 1, 'Valid attempt with total>0 earned credit');
    assert.equal(myTask.done, true);
  });

  it('5b. todo_status_on: authoritative Basics task credit (pre-activation compatibility, explicit activation, early finish, full duration, all-wrong, empty expiry, free practice, manual offline, section-wide, and task edits)', async () => {
    await setAuth(adminId, 'authenticated');

    const cat1Id = '88888888-8888-8888-8888-888888888888';
    const cat2Id = '99999999-9999-9999-9999-999999999999';
    await db.query(`
      INSERT INTO public.categories (id, name, section, active) VALUES
        ('${cat1Id}', '1D 3R', 'basics', true),
        ('${cat2Id}', '2D 5R', 'basics', true)
      ON CONFLICT DO NOTHING;
    `);

    // 1. Category-specific Basics task (targeted to cat1Id, duration 60s, required 1 round)
    const taskRes = await db.query(`
      INSERT INTO public.daily_tasks (title, section, category_id, duration_seconds, required_count, target_scope)
      VALUES ('Daily 1D 3R Basics', 'basics', '${cat1Id}', 60, 1, 'all')
      RETURNING id;
    `);
    const basicsTaskId = taskRes.rows[0].id;

    // 2. Section-wide Basics task (category_id IS NULL, required 1 round)
    const secTaskRes = await db.query(`
      INSERT INTO public.daily_tasks (title, section, category_id, duration_seconds, required_count, target_scope)
      VALUES ('Any Basics Practice', 'basics', NULL, 60, 1, 'all')
      RETURNING id;
    `);
    const secWideTaskId = secTaskRes.rows[0].id;

    // Student 1 checks initial status: done_count = 0 for both
    await setAuth(student1Id, 'authenticated');
    let status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 0);
    assert.equal(status.find((t) => t.task_id === secWideTaskId).done_count, 0);

    // =========================================================================
    // Phase A: Pre-Activation Compatibility (Simulating Old Production Code)
    // When status = 'installed' and activated_at IS NULL, v_phase19_active is false.
    // Old production code does not link drill_sessions or pass todo_task_id.
    // Newly submitted scores with total > 0 MUST continue earning task credit!
    // =========================================================================
    await setAuth(adminId, 'authenticated');
    const preActivationResId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${preActivationResId}', '${student1Id}', '${cat1Id}', 6, 5, 20, public.today_ist(), 'site', now());
    `);

    // Student checks: under unactivated policy, unlinked online attempt EARNS credit!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      status.find((t) => t.task_id === basicsTaskId).done_count,
      1,
      'Pre-activation unlinked online attempt earned credit (backward-compatible with old production code)'
    );

    // Clean up temporary pre-activation test row
    await setAuth(adminId, 'authenticated');
    await db.query(`DELETE FROM public.results WHERE id = '${preActivationResId}';`);

    // =========================================================================
    // Phase B: Explicit Owner-Controlled Activation
    // The owner runs supabase/owner_phase19_activation.sql AFTER deploying Phase 19 code.
    // =========================================================================
    await db.exec('RESET ROLE;');
    const activationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_activation.sql');
    const activationSql = fs.readFileSync(activationPath, 'utf8');
    await db.exec(activationSql);

    const activatedRes = await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `);
    assert.equal(activatedRes.rows[0].status, 'active');
    const activationTime = activatedRes.rows[0].activated_at;
    assert.ok(activationTime, 'activated_at must be populated after running activation script');

    // Verify rerun of migration does NOT reset status or shift activated_at
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_improvements_migration.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);
    const postRerunRes = await db.query(`
      SELECT status, activated_at FROM public.rollout_boundaries WHERE feature = 'phase19_authoritative_todo';
    `);
    assert.equal(postRerunRes.rows[0].status, 'active');
    assert.equal(
      new Date(postRerunRes.rows[0].activated_at).getTime(),
      new Date(activationTime).getTime(),
      'Migration rerun preserved active status and activation timestamp'
    );

    // Verify rerun of activation script is idempotent
    await db.exec(activationSql);
    const postActivationRerunRes = await db.query(`
      SELECT status, activated_at FROM public.rollout_boundaries WHERE feature = 'phase19_authoritative_todo';
    `);
    assert.equal(postActivationRerunRes.rows[0].status, 'active');
    assert.equal(
      new Date(postActivationRerunRes.rows[0].activated_at).getTime(),
      new Date(activationTime).getTime(),
      'Activation script rerun preserved active status and activation timestamp'
    );

    // Reset student status check: done_count is back to 0
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 0);

    // =========================================================================
    // Phase C: Post-Activation Enforcement
    // Authoritative assigned-duration rules are now strictly enforced!
    // =========================================================================
    // Case A: Early Finish on assigned session (e.g. solved for 15s instead of full 60s)
    // Saves to results with total = 5, correct = 4, but drill_sessions setting todo_credit = false
    await setAuth(adminId, 'authenticated');
    const earlyResultId = crypto.randomUUID();
    const earlySessionId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${earlyResultId}', '${student1Id}', '${cat1Id}', 5, 4, 15, public.today_ist(), 'site', now());

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status, result_row_id)
      VALUES ('${earlySessionId}', '${student1Id}', 'basics', 'Basics',
              jsonb_build_object('todo_task_id', '${basicsTaskId}', 'todo_credit', false, 'early_finish', true),
              '[]'::jsonb, '[]'::jsonb, 60, 'submitted', '${earlyResultId}');
    `);

    // Student checks: early finish score is in results history, but earns ZERO task credit!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 0, 'Early finish earned zero task credit');
    assert.equal(status.find((t) => t.task_id === secWideTaskId).done_count, 0);

    // Case B: Empty expiry (student let 60s timer run out without attempting any answer, total = 0)
    // Saved with todo_credit = false and total = 0
    await setAuth(adminId, 'authenticated');
    const emptyResultId = crypto.randomUUID();
    const emptySessionId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${emptyResultId}', '${student1Id}', '${cat1Id}', 0, 0, 60, public.today_ist(), 'site', now());

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status, result_row_id)
      VALUES ('${emptySessionId}', '${student1Id}', 'basics', 'Basics',
              jsonb_build_object('todo_task_id', '${basicsTaskId}', 'todo_credit', false, 'empty_expiry', true),
              '[]'::jsonb, '[]'::jsonb, 60, 'submitted', '${emptyResultId}');
    `);

    // Student checks: empty expiry attempt earns zero task credit!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 0, 'Empty expiry earned zero task credit');

    // Case C: Short free practice (source = 'site', completed without todo_task_id)
    const freeResultId = crypto.randomUUID();
    const freeSessionId = crypto.randomUUID();
    await setAuth(adminId, 'authenticated');
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${freeResultId}', '${student1Id}', '${cat1Id}', 10, 8, 30, public.today_ist(), 'site', now());

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status, result_row_id)
      VALUES ('${freeSessionId}', '${student1Id}', 'basics', 'Basics',
              jsonb_build_object('todo_credit', false),
              '[]'::jsonb, '[]'::jsonb, 30, 'submitted', '${freeResultId}');
    `);

    // Student checks: free practice cannot bypass assigned task!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 0, 'Free practice cannot bypass assigned task');

    // Case D: Full duration completed with all incorrect answers (total = 5, correct = 0)
    // Confirmed owner decision: incorrect answers remain eligible!
    const allWrongResultId = crypto.randomUUID();
    const allWrongSessionId = crypto.randomUUID();
    await setAuth(adminId, 'authenticated');
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${allWrongResultId}', '${student1Id}', '${cat1Id}', 5, 0, 60, public.today_ist(), 'site', now());

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status, result_row_id)
      VALUES ('${allWrongSessionId}', '${student1Id}', 'basics', 'Basics',
              jsonb_build_object('todo_task_id', '${basicsTaskId}', 'todo_credit', true, 'completed_duration', true),
              '[]'::jsonb, '[]'::jsonb, 60, 'submitted', '${allWrongResultId}');
    `);

    // Student checks: all-wrong attempt earned credit for the assigned task!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 1, 'All-wrong full duration attempt earned credit');
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done, true);
    assert.equal(status.find((t) => t.task_id === secWideTaskId).done_count, 0, 'Section-wide task only matches its own task_id for site sessions');

    // Case D2: Assigned session specifically for section-wide task (secWideTaskId) in cat2Id
    const secWideResultId = crypto.randomUUID();
    const secWideSessionId = crypto.randomUUID();
    await setAuth(adminId, 'authenticated');
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${secWideResultId}', '${student1Id}', '${cat2Id}', 8, 8, 60, public.today_ist(), 'site', now());

      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, status, result_row_id)
      VALUES ('${secWideSessionId}', '${student1Id}', 'basics', 'Basics',
              jsonb_build_object('todo_task_id', '${secWideTaskId}', 'todo_credit', true, 'completed_duration', true),
              '[]'::jsonb, '[]'::jsonb, 60, 'submitted', '${secWideResultId}');
    `);

    // Student checks: secWideTaskId now has 1 credit
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === secWideTaskId).done_count, 1);

    // Case E: Manually logged offline practice across stored source values ('typed', 'practice', 'manual')
    // Preserved existing offline practice behavior across all non-site/non-online sources
    await setAuth(adminId, 'authenticated');
    const offlineResultId = crypto.randomUUID();
    const offlinePracticeId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES
        ('${offlineResultId}', '${student1Id}', '${cat2Id}', 8, 7, 60, public.today_ist(), 'typed', now()),
        ('${offlinePracticeId}', '${student1Id}', '${cat2Id}', 9, 8, 60, public.today_ist(), 'practice', now());
    `);

    // Student checks: offline practice in cat2Id does NOT match cat1Id task, but DOES match section-wide task!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 1, 'cat1Id task unchanged');
    assert.equal(status.find((t) => t.task_id === secWideTaskId).done_count, 3, 'Section-wide task counted both typed and practice cat2Id results');

    // Case F: Legacy online rows prior to Phase 19 rollout boundary
    await db.exec('RESET ROLE;');
    const rolloutBound = (await db.query(`SELECT activated_at FROM public.rollout_boundaries WHERE feature = 'phase19_authoritative_todo';`)).rows[0].activated_at;
    const rolloutIso = new Date(rolloutBound).toISOString();
    await setAuth(adminId, 'authenticated');
    const legacyResultId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${legacyResultId}', '${student1Id}', '${cat1Id}', 12, 11, 45, public.today_ist(), 'site', $1::timestamptz - interval '1 hour');
    `, [rolloutIso]);

    // Student checks: legacy row is counted without needing drill_sessions link!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 2, 'Legacy row preserved and credited');

    // Case F2: Online row created AFTER rollout boundary without drill_sessions link earns ZERO credit
    await setAuth(adminId, 'authenticated');
    const postRolloutUnlinkedId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${postRolloutUnlinkedId}', '${student1Id}', '${cat1Id}', 12, 11, 45, public.today_ist(), 'site', now() + interval '1 minute');
    `);
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done_count, 2, 'Post-rollout unlinked online row earns zero credit');

    // Case G: Task edits must not retroactively invalidate earned credit or alter frozen session settings
    await setAuth(adminId, 'authenticated');
    await db.query(`
      UPDATE public.daily_tasks
      SET required_count = 3, duration_seconds = 120
      WHERE id = '${basicsTaskId}';
    `);

    // The student's done_count remains 2 (earned credit preserved)
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    const editedTask = status.find((t) => t.task_id === basicsTaskId);
    assert.equal(editedTask.done_count, 2);
    assert.equal(editedTask.required_count, 3);
    assert.equal(editedTask.done, false, 'Requires 3 rounds now; done is false but 2 completed rounds are preserved');

    // Case H: Legitimate in-progress Basics session started BEFORE activation, but submitted AFTER activation
    // Session started 10 minutes before activation (ds.started_at < rolloutBound)
    // Submitted after activation (r.created_at > rolloutBound)
    // Lacks Phase 19 todo_credit setting because it ran old code
    await setAuth(adminId, 'authenticated');
    const inProgressResultId = crypto.randomUUID();
    const inProgressSessionId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, status, result_row_id)
      VALUES ('${inProgressSessionId}', '${student1Id}', 'basics', 'Basics',
              '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 60,
              '${rolloutIso}'::timestamptz - interval '10 minutes', 'submitted', '${inProgressResultId}');

      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${inProgressResultId}', '${student1Id}', '${cat1Id}', 10, 9, 60, public.today_ist(), 'site', now() + interval '2 minutes');
    `);

    // Student checks: legitimate pre-activation session EARNS task credit!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      status.find((t) => t.task_id === basicsTaskId).done_count,
      3,
      'Pre-activation in-progress session submitted after activation earned task credit via session start linkage'
    );
    assert.equal(status.find((t) => t.task_id === basicsTaskId).done, true);

    // Case I: Old browser tab starting a NEW session AFTER activation
    // The tab was open from Phase 18, so it starts a session without Phase 19 todo_task_id or todo_credit
    // However, it started AFTER activation (ds.started_at > rolloutBound)
    await setAuth(adminId, 'authenticated');
    const oldTabResultId = crypto.randomUUID();
    const oldTabSessionId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, status, result_row_id)
      VALUES ('${oldTabSessionId}', '${student1Id}', 'basics', 'Basics',
              '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 60,
              now() + interval '5 minutes', 'submitted', '${oldTabResultId}');

      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${oldTabResultId}', '${student1Id}', '${cat1Id}', 10, 9, 60, public.today_ist(), 'site', now() + interval '6 minutes');
    `);

    // Student checks: new session started in old tab after activation earns ZERO task credit!
    await setAuth(student1Id, 'authenticated');
    status = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      status.find((t) => t.task_id === basicsTaskId).done_count,
      3,
      'Old browser tab starting a new session after activation earns 0 task credit (count remains 3)'
    );
  });

  it('5c. Flash Anzan RPCs: exact contract, caller authentication, assigned task validation & settings freeze, 100% vs 80% presentation gate, "I don\'t know" participation credit, duplicate protection', async () => {
    // 1. Setup Flash daily tasks
    await setAuth(adminId, 'authenticated');

    // Task 1: General Flash task (3 digits, 4 count, 1200ms speed, add_sub mode, target_scope = 'all', level = 'Grand Master')
    const flashTaskRes = await db.query(`
      INSERT INTO public.daily_tasks (
        title, section, flash_digits, flash_count, flash_speed_ms, flash_mode,
        required_count, target_scope, level, active
      ) VALUES (
        'Daily Flash GM', 'flash', 3, 4, 1200, 'add_sub',
        1, 'all', 'Grand Master', true
      ) RETURNING id;
    `);
    const flashTaskId = flashTaskRes.rows[0].id;

    // Task 2: Targeted Flash task (only for student 2)
    const targetedFlashRes = await db.query(`
      INSERT INTO public.daily_tasks (
        title, section, flash_digits, flash_count, flash_speed_ms, flash_mode,
        required_count, target_scope, active
      ) VALUES (
        'Targeted Flash for Student 2', 'flash', 2, 5, 1000, 'add',
        1, 'targeted', true
      ) RETURNING id;
    `);
    const targetedFlashTaskId = targetedFlashRes.rows[0].id;
    await db.query(`
      INSERT INTO public.daily_task_recipients (task_id, student_id)
      VALUES ('${targetedFlashTaskId}', '${student2Id}');
    `);

    // Task 3: Inactive Flash task
    const inactiveFlashRes = await db.query(`
      INSERT INTO public.daily_tasks (
        title, section, flash_digits, flash_count, flash_speed_ms, flash_mode,
        required_count, target_scope, active
      ) VALUES (
        'Inactive Flash', 'flash', 2, 5, 1000, 'add',
        1, 'all', false
      ) RETURNING id;
    `);
    const inactiveFlashTaskId = inactiveFlashRes.rows[0].id;

    // 2. Unauthenticated caller
    // 2a. Role 'anon' -> rejected at PostgreSQL engine level with 'permission denied for function'
    await setAuth(null, 'anon');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"digits": 2, "count": 5, "speed_ms": 1000}'::jsonb);`);
      },
      /permission denied for function/
    );

    // 2b. Role 'authenticated' with missing auth.uid() -> rejected inside function body with 'Not allowed'
    await setAuth(null, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"digits": 2, "count": 5, "speed_ms": 1000}'::jsonb);`);
      },
      /Not allowed/
    );

    // 3. Inactive caller -> rejected with 'This account is not active.'
    await setAuth(inactiveStudentId, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"digits": 2, "count": 5, "speed_ms": 1000}'::jsonb);`);
      },
      /This account is not active/
    );

    // 4. Assigned practice validation (as Student 1)
    await setAuth(student1Id, 'authenticated');

    // 4a. Malformed task ID
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"todo_task_id": "not-a-uuid"}'::jsonb);`);
      },
      /Invalid daily task ID format/
    );

    // 4b. Nonexistent task ID
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"todo_task_id": "00000000-0000-0000-0000-000000000000"}'::jsonb);`);
      },
      /Assigned daily task not found or is no longer active/
    );

    // 4c. Inactive task ID
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"todo_task_id": "${inactiveFlashTaskId}"}'::jsonb);`);
      },
      /Assigned daily task not found or is no longer active/
    );

    // 4d. Unassigned student on targeted task
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"todo_task_id": "${targetedFlashTaskId}"}'::jsonb);`);
      },
      /You are not assigned to this daily task/
    );

    // 4e. Level mismatch (Student 2 is 'Level 1', task requires 'Grand Master')
    await setAuth(student2Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_start('{"todo_task_id": "${flashTaskId}"}'::jsonb);`);
      },
      /Daily task level mismatch/
    );

    // 5. Server-Authoritative Settings Freeze
    // Student 1 starts assigned task flashTaskId.
    // Client attempts to spoof easier parameters (digits: 1, count: 2, speed_ms: 500, mode: 'add')
    await setAuth(student1Id, 'authenticated');
    const startRes = await db.query(`
      SELECT public.flash_start(
        jsonb_build_object(
          'todo_task_id', '${flashTaskId}',
          'digits', 1,
          'count', 2,
          'speed_ms', 500,
          'mode', 'add'
        )
      ) AS res;
    `);
    const sessionData = startRes.rows[0].res;
    assert.ok(sessionData.session_id);
    const assignedSessionId = sessionData.session_id;

    // Verify settings were frozen from task (3 digits, 4 count, 1200ms speed, add_sub mode), NOT client values!
    assert.equal(sessionData.settings.digits, 3);
    assert.equal(sessionData.settings.count, 4);
    assert.equal(sessionData.settings.speed_ms, 1200);
    assert.equal(sessionData.settings.mode, 'add_sub');
    assert.equal(sessionData.settings.is_todo, true);
    assert.equal(sessionData.settings.todo_task_id, flashTaskId);

    // Expected presentation time: 2.1s prep (3-2-1 countdown + blank) + 4 * (1200 + 80) / 1000 = 2.1 + 5.12 = 7.22 seconds
    const minSecRow = await db.query(`SELECT min_seconds, expected FROM public.drill_sessions WHERE id = '${assignedSessionId}';`);
    assert.equal(Number(minSecRow.rows[0].min_seconds), 7.22);
    const expectedSum = minSecRow.rows[0].expected[0];

    // 6. Presentation duration gate
    // 6a. Assigned practice submitted at 6.0s (< 7.22s, even though 6.0s >= 80% tolerance) -> REJECTED!
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.drill_sessions SET started_at = now() - interval '6.0 seconds' WHERE id = '${assignedSessionId}';`);

    await setAuth(student1Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_submit('${assignedSessionId}', '${expectedSum}'::jsonb);`);
      },
      /This was answered faster than the numbers were shown, so it was not saved/
    );

    // 6b. Free practice: uses established (count * speed) / 1000.0 with 80% tolerance
    const freeStartRes = await db.query(`
      SELECT public.flash_start(
        jsonb_build_object('digits', 2, 'count', 3, 'speed_ms', 1000, 'mode', 'add')
      ) AS res;
    `);
    const freeSessionId = freeStartRes.rows[0].res.session_id;
    const freeRow = (await db.query(`SELECT min_seconds FROM public.drill_sessions WHERE id = '${freeSessionId}';`)).rows[0];
    assert.equal(Number(freeRow.min_seconds), 3.0, 'Free practice min_seconds = 3 * 1000 / 1000 = 3.0s');

    // Free practice submitted at 2.0s (< 80% tolerance of 2.4s) -> REJECTED with established exception!
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.drill_sessions SET started_at = now() - interval '2.0 seconds' WHERE id = '${freeSessionId}';`);

    await setAuth(student1Id, 'authenticated');
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_submit('${freeSessionId}', '10'::jsonb);`);
      },
      /Submitted faster than the numbers could be shown/
    );

    // Free practice submitted at 2.5s (>= 80% tolerance of 2.4s) -> ACCEPTED!
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.drill_sessions SET started_at = now() - interval '2.5 seconds' WHERE id = '${freeSessionId}';`);

    await setAuth(student1Id, 'authenticated');
    const freeSubmitRes = await db.query(`SELECT public.flash_submit('${freeSessionId}', '10'::jsonb) AS res;`);
    assert.equal(typeof freeSubmitRes.rows[0].res.correct, 'boolean');

    // Free practice must NOT earn credit for assigned task!
    let todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    let flashTaskTodo = todoCheck.find((t) => t.task_id === flashTaskId);
    assert.equal(flashTaskTodo.done_count, 0, 'Free practice did not earn credit for assigned Flash task');

    // 7. Full presentation duration completion for assigned task
    // Set started_at to 8.0s ago (8.0s >= 7.22s)
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.drill_sessions SET started_at = now() - interval '8.0 seconds' WHERE id = '${assignedSessionId}';`);

    // Student 1 submits the correct answer
    await setAuth(student1Id, 'authenticated');
    const submitSuccessRes = await db.query(`SELECT public.flash_submit('${assignedSessionId}', '${expectedSum}'::jsonb) AS res;`);
    const submitBody = submitSuccessRes.rows[0].res;
    assert.equal(submitBody.correct, true);
    assert.equal(submitBody.expected, expectedSum);
    assert.equal(submitBody.given, expectedSum);

    // Verify session status updated to 'submitted'
    const sessionAfter = (await db.query(`SELECT status, result_id FROM public.drill_sessions WHERE id = '${assignedSessionId}';`)).rows[0];
    assert.equal(sessionAfter.status, 'submitted');
    assert.ok(sessionAfter.result_id);

    // Verify activity_results has the persisted settings and todo_task_id
    const actRow = (await db.query(`SELECT * FROM public.activity_results WHERE id = '${sessionAfter.result_id}';`)).rows[0];
    assert.equal(actRow.activity_type, 'flash_anzan');
    assert.equal(actRow.correct, 1);
    assert.equal(actRow.total, 1);
    assert.equal(actRow.settings.todo_task_id, flashTaskId);

    // Verify task credit in todo_status_on
    todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    flashTaskTodo = todoCheck.find((t) => t.task_id === flashTaskId);
    assert.equal(flashTaskTodo.done_count, 1);
    assert.equal(flashTaskTodo.done, true);

    // 8. Duplicate submit rejection
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.flash_submit('${assignedSessionId}', '${expectedSum}'::jsonb);`);
      },
      /This try was already submitted/
    );

    // 9. "I don't know" handling (p_answer = null)
    // Start second assigned round
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${flashTaskId}';`);

    await setAuth(student1Id, 'authenticated');
    const round2Start = (await db.query(`
      SELECT public.flash_start(jsonb_build_object('todo_task_id', '${flashTaskId}')) AS res;
    `)).rows[0].res;
    const round2SessionId = round2Start.session_id;

    // Simulate presentation completion (set started_at in the past)
    await setAuth(adminId, 'authenticated');
    await db.query(`UPDATE public.drill_sessions SET started_at = now() - interval '8.0 seconds' WHERE id = '${round2SessionId}';`);

    // Student clicks "I don't know" -> sends p_answer = null
    await setAuth(student1Id, 'authenticated');
    const idkRes = (await db.query(`SELECT public.flash_submit('${round2SessionId}', 'null'::jsonb) AS res;`)).rows[0].res;
    assert.equal(idkRes.correct, false);
    assert.equal(idkRes.given, null);

    // Verify activity_results: correct = 0, total = 1
    const idkSession = (await db.query(`SELECT result_id FROM public.drill_sessions WHERE id = '${round2SessionId}';`)).rows[0];
    const idkAct = (await db.query(`SELECT * FROM public.activity_results WHERE id = '${idkSession.result_id}';`)).rows[0];
    assert.equal(idkAct.correct, 0);
    assert.equal(idkAct.total, 1);

    // In todo_status_on: total = 1 > 0 counts for participation credit!
    todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    flashTaskTodo = todoCheck.find((t) => t.task_id === flashTaskId);
    assert.equal(flashTaskTodo.done_count, 2, '"I don\'t know" attempt earned participation credit');
    assert.equal(flashTaskTodo.done, true);

    // 10. Legacy Flash rows matching:
    // Before rollout boundary, legacy rows without todo_task_id match task parameters verbatim (digits, count, speed_ms, mode)
    await db.exec('RESET ROLE;');
    const rolloutBound = (await db.query(`SELECT activated_at FROM public.rollout_boundaries WHERE feature = 'phase19_authoritative_todo';`)).rows[0].activated_at;
    const rolloutIso = new Date(rolloutBound).toISOString();

    // Create a task for legacy matching: 2 digits, 5 count, 800ms speed, 'add' mode
    const legacyTaskRes = await db.query(`
      INSERT INTO public.daily_tasks (
        title, section, flash_digits, flash_count, flash_speed_ms, flash_mode,
        required_count, target_scope, active
      ) VALUES (
        'Legacy Flash Task', 'flash', 2, 5, 800, 'add',
        1, 'all', true
      ) RETURNING id;
    `);
    const legacyTaskId = legacyTaskRes.rows[0].id;

    // Legacy row 1: MATCHING parameters (digits: '2', count: '5', speed_ms: '800', mode: 'add') before rollout
    const legacyMatchId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at)
      VALUES (
        '${legacyMatchId}', '${student1Id}', 'flash_anzan', 'Flash anzan', 1, 1, 4,
        jsonb_build_object('digits', '2', 'count', '5', 'speed_ms', '800', 'mode', 'add'),
        $1::timestamptz - interval '10 seconds'
      );
    `, [rolloutIso]);

    // Legacy row 2: NON-MATCHING parameters (digits: '3', count: '5', speed_ms: '800', mode: 'add') before rollout
    const legacyNonMatchId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at)
      VALUES (
        '${legacyNonMatchId}', '${student1Id}', 'flash_anzan', 'Flash anzan', 1, 1, 4,
        jsonb_build_object('digits', '3', 'count', '5', 'speed_ms', '800', 'mode', 'add'),
        $1::timestamptz - interval '10 seconds'
      );
    `, [rolloutIso]);

    // Check todo_status_on on legacy row date: legacy matching row counted towards legacyTaskId; non-matching ignored!
    const legacyDayRes = await db.query(`SELECT to_char(($1::timestamptz - interval '10 seconds') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d;`, [rolloutIso]);
    const legacyDay = legacyDayRes.rows[0].d;
    todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}', '${legacyDay}'::date);`)).rows;
    const legacyCheck = todoCheck.find((t) => t.task_id === legacyTaskId);
    assert.equal(legacyCheck.done_count, 1, 'Legacy Flash row matching parameters verbatim earned credit');
    assert.equal(legacyCheck.done, true);

    // 11. Legitimate in-progress Flash session started BEFORE activation, but submitted AFTER activation
    // Session started 10 minutes before activation (ds.started_at < rolloutBound)
    // Submitted after activation (a.created_at > rolloutBound)
    // Settings match parameters (2 digits, 5 count, 800ms speed, 'add' mode) but lack todo_task_id
    await setAuth(adminId, 'authenticated');
    const inProgressFlashSessionId = crypto.randomUUID();
    const inProgressFlashActId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, status, result_id)
      VALUES ('${inProgressFlashSessionId}', '${student1Id}', 'flash_anzan', 'Flash anzan',
              jsonb_build_object('digits', '2', 'count', '5', 'speed_ms', '800', 'mode', 'add'),
              '[]'::jsonb, '[]'::jsonb, 4,
              '${rolloutIso}'::timestamptz - interval '10 minutes', 'submitted', '${inProgressFlashActId}');

      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at)
      VALUES (
        '${inProgressFlashActId}', '${student1Id}', 'flash_anzan', 'Flash anzan', 1, 1, 4,
        jsonb_build_object('digits', '2', 'count', '5', 'speed_ms', '800', 'mode', 'add', 'session_id', '${inProgressFlashSessionId}'),
        now() + interval '2 minutes'
      );
    `);

    // Student checks: legitimate in-progress Flash session EARNS task credit!
    await db.query(`UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${legacyTaskId}';`);
    await setAuth(student1Id, 'authenticated');
    todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      todoCheck.find((t) => t.task_id === legacyTaskId).done_count,
      2,
      'Pre-activation in-progress Flash session submitted after activation earned task credit via session start linkage'
    );

    // 12. Old browser tab starting a NEW Flash session AFTER activation
    // Tab was open from Phase 18, so it starts a session without todo_task_id
    // But started AFTER activation (ds.started_at > rolloutBound)
    await setAuth(adminId, 'authenticated');
    const oldTabFlashSessionId = crypto.randomUUID();
    const oldTabFlashActId = crypto.randomUUID();
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, questions, expected, min_seconds, started_at, status, result_id)
      VALUES ('${oldTabFlashSessionId}', '${student1Id}', 'flash_anzan', 'Flash anzan',
              jsonb_build_object('digits', '2', 'count', '5', 'speed_ms', '800', 'mode', 'add'),
              '[]'::jsonb, '[]'::jsonb, 4,
              now() + interval '5 minutes', 'submitted', '${oldTabFlashActId}');

      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at)
      VALUES (
        '${oldTabFlashActId}', '${student1Id}', 'flash_anzan', 'Flash anzan', 1, 1, 4,
        jsonb_build_object('digits', '2', 'count', '5', 'speed_ms', '800', 'mode', 'add', 'session_id', '${oldTabFlashSessionId}'),
        now() + interval '6 minutes'
      );
    `);

    // Student checks: new session started in old tab after activation earns ZERO task credit!
    await setAuth(student1Id, 'authenticated');
    todoCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      todoCheck.find((t) => t.task_id === legacyTaskId).done_count,
      2,
      'Old browser tab starting a new Flash session after activation earns 0 task credit (count remains 2)'
    );
  });

  it('6. student_rounds RLS policy allows assigned teachers with permission, rejects unassigned teachers', async () => {
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.student_rounds (id, student_id, series_id, round_index, total_score)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${student1Id}', 'ser-2026', 1, 95);
    `);

    // Teacher A (assigned to Student 1, has view_students) -> can SELECT
    await setAuth(teacherAId, 'authenticated');
    const teacherARounds = await db.query(`SELECT * FROM public.student_rounds WHERE student_id = '${student1Id}';`);
    assert.equal(teacherARounds.rows.length, 1);

    // Teacher B (NOT assigned to Student 1) -> 0 rows returned due to RLS
    await setAuth(teacherBId, 'authenticated');
    const teacherBRounds = await db.query(`SELECT * FROM public.student_rounds WHERE student_id = '${student1Id}';`);
    assert.equal(teacherBRounds.rows.length, 0, 'Unassigned teacher cannot view student rounds');
  });

  it('7. save_daily_task_atomic accepts duration_seconds and enforces check constraint (5..3600)', async () => {
    await setAuth(adminId, 'authenticated');

    // Valid task with duration_seconds = 75
    const saveRes = await db.query(`
      SELECT public.save_daily_task_atomic(
        NULL,
        jsonb_build_object(
          'title', 'Timed Drill 75s',
          'section', 'elements',
          'activity_key', 'compliment_10',
          'required_count', 1,
          'duration_seconds', 75,
          'active', true
        ),
        NULL
      ) AS res;
    `);
    const saved = saveRes.rows[0].res;
    assert.equal(saved.success, true);
    assert.equal(saved.duration_seconds, 75);

    // Invalid task with duration_seconds = 2 (< 5) -> raises check constraint violation
    await assert.rejects(async () => {
      await db.query(`
        SELECT public.save_daily_task_atomic(
          NULL,
          jsonb_build_object(
            'title', 'Too short',
            'section', 'elements',
            'required_count', 1,
            'duration_seconds', 2,
            'active', true
          ),
          NULL
        );
      `);
    });
  });

  it('8. Database restore: verifies restoring an active deployment preserves rollout state and does not silently revert to permissive counting', async () => {
    // 1. Establish an active production milestone timestamp
    const originalActivationTime = new Date(Date.now() - 3600000 * 24).toISOString(); // 24 hours ago
    await db.exec('RESET ROLE;');
    await db.query(`
      UPDATE public.rollout_boundaries
      SET status = 'active', activated_at = $1::timestamptz
      WHERE feature = 'phase19_authoritative_todo';
    `, [originalActivationTime]);

    // Test private export script (owner_phase19_export_rollout.sql)
    const exportSqlPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_export_rollout.sql');
    const exportSql = fs.readFileSync(exportSqlPath, 'utf8');
    await db.exec(exportSql);

    // 2. Simulate disaster recovery / rebuilt database:
    // Drop rollout_boundaries to simulate a freshly provisioned database instance
    await db.exec(`DROP TABLE public.rollout_boundaries CASCADE;`);

    // Run migration script (as done during initial database rebuild)
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_improvements_migration.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    // Verify: fresh migration initializes rollout_boundaries in 'installed' state with activated_at = NULL
    let freshBoundary = (await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `)).rows[0];
    assert.equal(freshBoundary.status, 'installed');
    assert.equal(freshBoundary.activated_at, null);

    // 3. Test Fail-Closed Validation in owner_phase19_restore_activation.sql:
    const restoreSqlPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_restore_activation.sql');
    const rawRestoreSql = fs.readFileSync(restoreSqlPath, 'utf8');

    // Case 3a: Running unconfigured template (v_saved_status IS NULL) must ABORT
    await assert.rejects(
      async () => {
        await db.exec(rawRestoreSql);
      },
      (err) => {
        assert.match(err.message, /saved rollout status \(v_saved_status\) is required/);
        return true;
      },
      'Unconfigured restore script must abort instead of guessing'
    );
    try { await db.exec('ROLLBACK;'); } catch {}

    // Case 3b: Setting status = 'active' with missing timestamp (v_saved_activated_at IS NULL) must ABORT
    const missingTimestampSql = rawRestoreSql.replace(
      "v_saved_status TEXT := NULL;",
      "v_saved_status TEXT := 'active';"
    );
    await assert.rejects(
      async () => {
        await db.exec(missingTimestampSql);
      },
      (err) => {
        assert.match(err.message, /original activation timestamp \(v_saved_activated_at\) is NULL/);
        return true;
      },
      'Active restore without timestamp must abort instead of defaulting to now()'
    );
    try { await db.exec('ROLLBACK;'); } catch {}

    // Case 3c: Setting status = 'installed' with a non-null timestamp must ABORT
    const invalidInstalledSql = rawRestoreSql
      .replace("v_saved_status TEXT := NULL;", "v_saved_status TEXT := 'installed';")
      .replace("v_saved_activated_at TIMESTAMPTZ := NULL;", `v_saved_activated_at TIMESTAMPTZ := '${originalActivationTime}';`);
    await assert.rejects(
      async () => {
        await db.exec(invalidInstalledSql);
      },
      (err) => {
        assert.match(err.message, /saved status is 'installed' but v_saved_activated_at is set/);
        return true;
      },
      'Installed restore with timestamp must abort'
    );
    try { await db.exec('ROLLBACK;'); } catch {}

    // Case 3d: Restoring an originally unactivated deployment (status = 'installed', activated_at = NULL)
    const validInstalledSql = rawRestoreSql
      .replace("v_saved_status TEXT := NULL;", "v_saved_status TEXT := 'installed';");
    await db.exec(validInstalledSql);
    let installedBoundary = (await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `)).rows[0];
    assert.equal(installedBoundary.status, 'installed');
    assert.equal(installedBoundary.activated_at, null, 'Unactivated deployment must remain NULL activated_at');

    // 4. Test exact timestamp restoration for an active deployment:
    const validActiveSql = rawRestoreSql
      .replace("v_saved_status TEXT := NULL;", "v_saved_status TEXT := 'active';")
      .replace("v_saved_activated_at TIMESTAMPTZ := NULL;", `v_saved_activated_at TIMESTAMPTZ := '${originalActivationTime}';`);
    await db.exec(validActiveSql);

    // Verify exact timestamp preservation
    const restoredBoundary = (await db.query(`
      SELECT feature, status, activated_at
      FROM public.rollout_boundaries
      WHERE feature = 'phase19_authoritative_todo';
    `)).rows[0];
    assert.equal(restoredBoundary.status, 'active');
    assert.equal(
      new Date(restoredBoundary.activated_at).getTime(),
      new Date(originalActivationTime).getTime(),
      'Owner restore procedure preserved the exact pre-disaster activation timestamp down to the ms'
    );

    // 5. Verify post-restore enforcement:
    const testCatId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.categories (id, name, section, active)
      VALUES ('${testCatId}', 'Restore Test Cat', 'basics', true);
    `);
    const testTaskRes = await db.query(`
      INSERT INTO public.daily_tasks (title, section, category_id, duration_seconds, required_count, target_scope)
      VALUES ('Restore Test Task', 'basics', '${testCatId}', 60, 1, 'all')
      RETURNING id;
    `);
    const testTaskId = testTaskRes.rows[0].id;

    // A post-activation unlinked online score submitted now earns ZERO task credit!
    const unlinkedScoreId = crypto.randomUUID();
    await db.query(`
      INSERT INTO public.results (id, student_id, category_id, total, correct, time_seconds, entry_date, source, created_at)
      VALUES ('${unlinkedScoreId}', '${student1Id}', '${testCatId}', 5, 5, 20, public.today_ist(), 'site', now());
    `);
    await setAuth(student1Id, 'authenticated');
    const postRestoreCheck = (await db.query(`SELECT * FROM public.todo_status_on('${student1Id}');`)).rows;
    assert.equal(
      postRestoreCheck.find((t) => t.task_id === testTaskId).done_count,
      0,
      'Restored active deployment strictly enforces authoritative credit (does NOT silently return to permissive counting)'
    );

    // Clean up test task and score
    await db.exec('RESET ROLE;');
    await db.query(`DELETE FROM public.results WHERE id = '${unlinkedScoreId}';`);
    await db.query(`DELETE FROM public.daily_tasks WHERE id = '${testTaskId}';`);
  });
});

describe('Phase 19 — Real Endpoint Handlers (drillHandler & memoriadHandler) Verification', () => {
  let db;
  let adminSupabase;

  const studentAlice = { id: '44444444-4444-4444-4444-444444444444', level: 'Grand Master' };
  const studentBob = { id: '55555555-5555-5555-5555-555555555555', level: 'Level 1' };

  const elementsTaskId = '11111111-2222-3333-4444-555555555555';
  const memoriadTaskId = '22222222-3333-4444-5555-666666666666';
  const basicsTaskId = '33333333-4444-5555-6666-777777777777';
  const targetedTaskId = '44444444-5555-6666-7777-888888888888';
  const inactiveTaskId = '55555555-6666-7777-8888-999999999999';

  const basicsCatId = '77777777-7777-7777-7777-777777777777';

  before(async () => {
    db = new PGlite();

    // Roles and auth mock
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object('role', auth.role());
      $$ LANGUAGE sql STABLE;
    `);

    // Setup full PGlite schema with Phase 19 definitions
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        level TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID NULL,
        level TEXT NULL,
        activity_key TEXT NULL,
        flash_digits INT NULL,
        flash_count INT NULL,
        flash_speed_ms INT NULL,
        flash_mode TEXT NULL,
        required_count INT NOT NULL DEFAULT 1,
        duration_seconds INT NULL,
        sort_order INT NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID NULL,
        target_scope TEXT NOT NULL DEFAULT 'all'
      );

      CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id),
        student_round_id UUID NULL,
        total INT NOT NULL DEFAULT 0,
        correct INT NOT NULL DEFAULT 0,
        time_seconds NUMERIC NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'typed',
        entry_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element', 'basics', 'round', 'memoriad')),
        activity_name TEXT NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds NUMERIC NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID
      );

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        total INT NOT NULL DEFAULT 0,
        correct INT NOT NULL DEFAULT 0,
        time_seconds NUMERIC NOT NULL DEFAULT 0,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.student_rounds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        series_id TEXT NULL,
        round_index INT NULL,
        total_score NUMERIC NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
        SELECT true;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID) RETURNS BOOLEAN AS $$
        SELECT false;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_uid UUID, p_perm TEXT) RETURNS BOOLEAN AS $$
        SELECT false;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher UUID, p_student UUID) RETURNS BOOLEAN AS $$
        SELECT false;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id UUID, p_student UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.daily_task_recipients
          WHERE task_id = p_task_id AND student_id = p_student
        );
      $$ LANGUAGE sql STABLE;

      -- Pre-Phase-19 Flash RPC baseline definitions
      CREATE OR REPLACE FUNCTION public.flash_generate_question(p_digits integer, p_count integer, p_mode text)
      RETURNS integer[]
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_nums integer[] := ARRAY[]::integer[];
        v_lo integer;
        v_hi integer;
        v_n integer;
        v_sign integer;
        v_total integer := 0;
        v_prev integer := NULL;
        v_tries integer;
      BEGIN
        v_lo := 10^(p_digits - 1);
        v_hi := (10^p_digits) - 1;
        FOR i IN 1..p_count LOOP
          v_tries := 0;
          LOOP
            v_tries := v_tries + 1;
            v_n := v_lo + floor(random() * (v_hi - v_lo + 1))::integer;
            v_sign := 1;
            IF p_mode = 'add_sub' AND i > 1 AND random() < 0.4 THEN
              v_sign := -1;
            END IF;
            IF v_sign = -1 AND v_total - v_n < 0 THEN
              v_sign := 1;
            END IF;
            EXIT WHEN v_prev IS NULL OR v_n <> v_prev OR v_tries > 20;
          END LOOP;
          v_nums := v_nums || (v_sign * v_n);
          v_total := v_total + v_sign * v_n;
          v_prev := v_n;
        END LOOP;
        RETURN v_nums;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.flash_start(p_settings jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      DECLARE
        v_digits integer;
        v_count integer;
        v_speed integer;
        v_mode text;
        v_nums integer[];
        v_sum integer;
        v_min numeric;
        v_settings jsonb;
        v_id uuid;
        v_profile public.profiles;
      BEGIN
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;

        SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
        IF NOT FOUND OR NOT v_profile.active THEN
          RAISE EXCEPTION 'This account is not active.';
        END IF;

        BEGIN
          v_digits := (p_settings ->> 'digits')::integer;
          v_count := (p_settings ->> 'count')::integer;
          v_speed := (p_settings ->> 'speed_ms')::integer;
          v_mode := COALESCE(p_settings ->> 'mode', 'add');
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'The settings are not valid.';
        END;

        IF v_digits IS NULL OR v_count IS NULL OR v_speed IS NULL
           OR v_digits < 1 OR v_digits > 5
           OR v_count < 2 OR v_count > 1000
           OR v_speed < 200 OR v_speed > 5000
           OR v_mode NOT IN ('add', 'add_sub') THEN
          RAISE EXCEPTION 'The settings are not valid.';
        END IF;

        v_nums := public.flash_generate_question(v_digits, v_count, v_mode);
        SELECT sum(x)::integer INTO v_sum FROM unnest(v_nums) AS x;
        v_min := 2.0 + (v_count * (v_speed + 80) / 1000.0);
        v_settings := jsonb_build_object('digits', v_digits, 'count', v_count, 'speed_ms', v_speed, 'mode', v_mode);

        INSERT INTO public.drill_sessions
          (student_id, activity_type, activity_name, settings, questions, expected, min_seconds, expires_at)
        VALUES
          (auth.uid(), 'flash_anzan', 'Flash anzan', v_settings,
           jsonb_build_array(to_jsonb(v_nums)), jsonb_build_array(v_sum), v_min,
           now() + (v_min + 1800) * interval '1 second')
        RETURNING id INTO v_id;

        RETURN jsonb_build_object('session_id', v_id, 'numbers', to_jsonb(v_nums), 'settings', v_settings);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.flash_submit(p_session uuid, p_answer jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      DECLARE
        s public.drill_sessions;
        v_elapsed numeric;
        v_exp jsonb;
        v_ok boolean;
        v_res uuid;
      BEGIN
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;

        SELECT * INTO s FROM public.drill_sessions
         WHERE id = p_session AND student_id = auth.uid() AND activity_type = 'flash_anzan'
           FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'This try was not found.';
        END IF;
        IF s.status <> 'open' THEN
          RAISE EXCEPTION 'This try was already submitted.';
        END IF;
        IF now() > s.expires_at THEN
          RAISE EXCEPTION 'This try expired. Please start a new one.';
        END IF;

        v_elapsed := extract(epoch FROM (now() - s.started_at));
        IF v_elapsed < (s.min_seconds * 0.8) THEN
          RAISE EXCEPTION 'Submitted faster than the numbers could be shown.';
        END IF;

        v_exp := s.expected -> 0;
        v_ok := (p_answer IS NOT NULL AND jsonb_typeof(p_answer) = 'number' AND p_answer = v_exp);

        INSERT INTO public.activity_results
          (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
        VALUES
          (s.student_id, s.activity_type, s.activity_name,
           CASE WHEN v_ok THEN 1 ELSE 0 END, 1,
           round(v_elapsed)::integer, s.settings || jsonb_build_object('session_id', s.id))
        RETURNING id INTO v_res;

        UPDATE public.drill_sessions
           SET status = 'submitted', submitted_at = now(), result_id = v_res
         WHERE id = s.id;

        RETURN jsonb_build_object('correct', v_ok, 'expected', v_exp, 'given', p_answer, 'seconds', round(v_elapsed));
      END;
      $$;

      ALTER TABLE public.student_rounds ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;
    `);

    // Apply Phase 19 migration
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_improvements_migration.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(sql);

    // Explicitly activate Phase 19 authoritative task credit policy for endpoint verification
    const activationPath = path.join(ROOT_DIR, 'supabase', 'owner_phase19_activation.sql');
    const activationSql = fs.readFileSync(activationPath, 'utf8');
    await db.exec(activationSql);

    // Insert profiles
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, role, level, active) VALUES
        ('${studentAlice.id}', 'Alice Student', 'student', '${studentAlice.level}', true),
        ('${studentBob.id}', 'Bob Student', 'student', '${studentBob.level}', true);

      INSERT INTO public.categories (id, name, section, active) VALUES
        ('${basicsCatId}', '1D 3R', 'basics', true);
    `);

    // Create client adapter
    adminSupabase = createTestAdminSupabase(db);

    // Populate categories
    adminSupabase.store.categories.set(basicsCatId, {
      id: basicsCatId,
      name: '1D 3R',
      section: 'basics',
      active: true,
    });

    // Populate daily tasks
    const tasks = [
      {
        id: elementsTaskId,
        title: 'Daily Day Codes',
        section: 'elements',
        activity_key: 'day_codes',
        duration_seconds: 60,
        level: null,
        target_scope: 'all',
        active: true,
      },
      {
        id: memoriadTaskId,
        title: 'Daily Calendar Memoriad',
        section: 'memoriad',
        activity_key: 'calendar',
        duration_seconds: 60,
        level: null,
        target_scope: 'all',
        active: true,
      },
      {
        id: basicsTaskId,
        title: 'Daily Basics Round',
        section: 'basics',
        category_id: basicsCatId,
        duration_seconds: 60,
        level: null,
        target_scope: 'all',
        active: true,
      },
      {
        id: targetedTaskId,
        title: 'Targeted Day Codes for Alice Only',
        section: 'elements',
        activity_key: 'day_codes',
        duration_seconds: 60,
        level: null,
        target_scope: 'targeted',
        active: true,
      },
      {
        id: inactiveTaskId,
        title: 'Inactive Task',
        section: 'elements',
        activity_key: 'day_codes',
        duration_seconds: 60,
        level: null,
        target_scope: 'all',
        active: false,
      },
    ];

    for (const t of tasks) {
      adminSupabase.store.daily_tasks.set(t.id, t);
      await db.query(
        `INSERT INTO public.daily_tasks (id, title, section, category_id, activity_key, duration_seconds, target_scope, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [t.id, t.title, t.section, t.category_id || null, t.activity_key || null, t.duration_seconds, t.target_scope, t.active]
      );
    }

    // Alice is assigned to targeted task, Bob is not
    adminSupabase.store.daily_task_recipients.add(`${targetedTaskId}:${studentAlice.id}`);
    await db.query(
      `INSERT INTO public.daily_task_recipients (task_id, student_id) VALUES ($1, $2)`,
      [targetedTaskId, studentAlice.id]
    );

    // Set auth context for student Alice
    await setSuite2Auth(studentAlice.id, 'authenticated');
  });

  const setSuite2Auth = async (userId, role = 'authenticated') => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '${userId || ''}', false);
      SELECT set_config('app.current_jwt_role', '${role}', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
    `);
    if (role === 'authenticated' || role === 'anon') {
      await db.exec(`SET ROLE ${role};`);
    } else {
      await db.exec(`SET ROLE postgres;`);
    }
  };

  // ----------------------------------------------------------------------------
  // A. Invalid Task Assignments Coverage
  // ----------------------------------------------------------------------------
  it('1. Rejects invalid daily task IDs explicitly (blank, non-string, forged, section/drill mismatch, unassigned)', async () => {
    // a) Blank task ID -> 400
    const blankReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: '   ' },
      student: studentAlice,
      adminSupabase,
    });
    const blankRes = createMockRes();
    await drillHandler(blankReq, blankRes);
    assert.equal(blankRes.statusCode, 400);
    assert.match(blankRes.body.error, /must be a non-empty string/i);

    // b) Non-string task ID -> 400
    const numReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: 12345 },
      student: studentAlice,
      adminSupabase,
    });
    const numRes = createMockRes();
    await drillHandler(numReq, numRes);
    assert.equal(numRes.statusCode, 400);
    assert.match(numRes.body.error, /must be a non-empty string/i);

    // c) Forged task ID (valid UUID not in DB) -> 404
    const forgedReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: '00000000-0000-0000-0000-000000000000' },
      student: studentAlice,
      adminSupabase,
    });
    const forgedRes = createMockRes();
    await drillHandler(forgedReq, forgedRes);
    assert.equal(forgedRes.statusCode, 404);
    assert.match(forgedRes.body.error, /not found/i);

    // d) Section mismatch: task is memoriad, submitted to elements drill -> 400
    const secMismatchReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: memoriadTaskId },
      student: studentAlice,
      adminSupabase,
    });
    const secMismatchRes = createMockRes();
    await drillHandler(secMismatchReq, secMismatchRes);
    assert.equal(secMismatchRes.statusCode, 400);
    assert.match(secMismatchRes.body.error, /section mismatch/i);

    // e) Drill mismatch: task is day_codes, caller requests month_codes -> 400
    const drillMismatchReq = createMockReq({
      body: { action: 'start', drill: 'month_codes', todo_task_id: elementsTaskId },
      student: studentAlice,
      adminSupabase,
    });
    const drillMismatchRes = createMockRes();
    await drillHandler(drillMismatchReq, drillMismatchRes);
    assert.equal(drillMismatchRes.statusCode, 400);
    assert.match(drillMismatchRes.body.error, /drill mismatch/i);

    // f) Unassigned student on targeted task -> 403
    const unassignedReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: targetedTaskId },
      student: studentBob, // Bob is NOT assigned
      adminSupabase,
    });
    const unassignedRes = createMockRes();
    await drillHandler(unassignedReq, unassignedRes);
    assert.equal(unassignedRes.statusCode, 403);
    assert.match(unassignedRes.body.error, /not assigned/i);

    // g) Inactive task -> 404
    const inactiveReq = createMockReq({
      body: { action: 'start', drill: 'day_codes', todo_task_id: inactiveTaskId },
      student: studentAlice,
      adminSupabase,
    });
    const inactiveRes = createMockRes();
    await drillHandler(inactiveReq, inactiveRes);
    assert.equal(inactiveRes.statusCode, 404);
    assert.match(inactiveRes.body.error, /no longer active/i);
  });

  // ----------------------------------------------------------------------------
  // B. Memoriad Endpoint Verification
  // ----------------------------------------------------------------------------
  it('2. Memoriad: rejects forged finished_by: "time_up" early; accepts complete early submit; saves empty expiry at deadline with 0 credit; saves incomplete expiry with credit', async () => {
    // 2a. Start an assigned Memoriad session for Alice
    const startReq = createMockReq({
      body: { action: 'start', module: 'calendar', todo_task_id: memoriadTaskId },
      student: studentAlice,
      adminSupabase,
    });
    const startRes = createMockRes();
    await memoriadHandler(startReq, startRes);
    assert.equal(startRes.statusCode, 200);
    assert.ok(startRes.body.session_id);
    const sessionId = startRes.body.session_id;

    // 2b. Attacker tries to forge finished_by: 'time_up' before deadline (with only 2 of 5 answered)
    const forgedReq = createMockReq({
      body: {
        action: 'submit',
        session_id: sessionId,
        answers: [1, 2, null, null, null],
        finished_by: 'time_up', // Forged expiry!
      },
      student: studentAlice,
      adminSupabase,
    });
    const forgedRes = createMockRes();
    await memoriadHandler(forgedReq, forgedRes);
    assert.equal(forgedRes.statusCode, 400);
    assert.match(forgedRes.body.error, /All questions must be answered/i);

    // Verify session remained open
    const sessionStillOpen = adminSupabase.store.drill_sessions.get(sessionId);
    assert.equal(sessionStillOpen.status, 'open');

    // 2c. Early completion delivered AFTER deadline: student solved in 40s, packet arrived at 75s (> 65s deadline)
    sessionStillOpen.started_at = new Date(Date.now() - 75000).toISOString();

    const totalMemQ = sessionStillOpen.questions.length;

    // 2c-1. Forged timing claim: student claims 5.0s solve for 125 dates -> rejected with 400
    const forgedSpeedReq = createMockReq({
      body: {
        action: 'submit',
        session_id: sessionId,
        answers: new Array(totalMemQ).fill(1),
        finished_by: 'finish',
        client_duration_seconds: 5.0, // 5s < 31.25s plausibility floor
      },
      student: studentAlice,
      adminSupabase,
    });
    const forgedSpeedRes = createMockRes();
    await memoriadHandler(forgedSpeedReq, forgedSpeedRes);
    assert.equal(forgedSpeedRes.statusCode, 400);
    assert.match(forgedSpeedRes.body.error, /Submitted faster than plausible human calculation speed/i);

    // 2c-2. Genuine early finish delivered after deadline (solved in 40s, arrived at 75s) -> succeeds & preserves 40s!
    const earlyReq = createMockReq({
      body: {
        action: 'submit',
        session_id: sessionId,
        answers: new Array(totalMemQ).fill(1),
        finished_by: 'finish',
        client_duration_seconds: 40,
      },
      student: studentAlice,
      adminSupabase,
    });
    const earlyRes = createMockRes();
    await memoriadHandler(earlyReq, earlyRes);
    assert.equal(earlyRes.statusCode, 200);
    assert.equal(earlyRes.body.used_seconds, 40, 'Early solving duration preserved at 40s despite arriving after 65s deadline');

    // Verify persisted session & result state
    const completedSession = adminSupabase.store.drill_sessions.get(sessionId);
    assert.equal(completedSession.status, 'submitted');
    assert.ok(completedSession.result_id);

    // Verify task credit in PostgreSQL via todo_status_on
    const creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    const memTask = creditRes.rows.find((t) => t.task_id === memoriadTaskId);
    assert.equal(memTask.done_count, 1);
    assert.equal(memTask.done, true);

    // 2d. Duplicate submit on completed session -> returns 409
    const dupReq = createMockReq({
      body: {
        action: 'submit',
        session_id: sessionId,
        answers: new Array(totalMemQ).fill(1),
      },
      student: studentAlice,
      adminSupabase,
    });
    const dupRes = createMockRes();
    await memoriadHandler(dupReq, dupRes);
    assert.equal(dupRes.statusCode, 409);
    assert.match(dupRes.body.error, /already been submitted/i);

    // 2e. Empty expiry at deadline: 0 questions answered, deadline arrived
    // Start a new assigned Memoriad session
    const start2Res = createMockRes();
    await memoriadHandler(
      createMockReq({ body: { action: 'start', module: 'calendar', todo_task_id: memoriadTaskId }, student: studentAlice, adminSupabase }),
      start2Res
    );
    const session2Id = start2Res.body.session_id;

    // Simulate clock reaching deadline (set started_at in the past)
    const session2 = adminSupabase.store.drill_sessions.get(session2Id);
    session2.started_at = new Date(Date.now() - 70000).toISOString(); // 70s ago (> 63s deadline)

    // Submit empty answers at deadline
    const emptyExpiryRes = createMockRes();
    await memoriadHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: session2Id,
          answers: new Array(session2.questions.length).fill(null),
          finished_by: 'time_up',
        },
        student: studentAlice,
        adminSupabase,
      }),
      emptyExpiryRes
    );
    assert.equal(emptyExpiryRes.statusCode, 200);
    assert.equal(emptyExpiryRes.body.total, 0);

    // Check PostgreSQL: total=0 attempt must NOT increment done_count!
    const credit2Res = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    const memTask2 = credit2Res.rows.find((t) => t.task_id === memoriadTaskId);
    assert.equal(memTask2.done_count, 1, 'Empty expiry earned 0 credit, done_count stayed at 1');

    // 2f. Incomplete expiry at deadline: 2 questions answered, deadline arrived
    const start3Res = createMockRes();
    await memoriadHandler(
      createMockReq({ body: { action: 'start', module: 'calendar', todo_task_id: memoriadTaskId }, student: studentAlice, adminSupabase }),
      start3Res
    );
    const session3Id = start3Res.body.session_id;
    const session3 = adminSupabase.store.drill_sessions.get(session3Id);
    session3.started_at = new Date(Date.now() - 70000).toISOString();

    const partialAns = new Array(session3.questions.length).fill(null);
    partialAns[0] = 0;
    partialAns[1] = 1;

    const partialExpiryRes = createMockRes();
    await memoriadHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: session3Id,
          answers: partialAns,
          finished_by: 'time_up',
        },
        student: studentAlice,
        adminSupabase,
      }),
      partialExpiryRes
    );
    assert.equal(partialExpiryRes.statusCode, 200);
    assert.equal(partialExpiryRes.body.total, 2);

    // Check PostgreSQL: non-zero attempt increments done_count to 2!
    const credit3Res = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    const memTask3 = credit3Res.rows.find((t) => t.task_id === memoriadTaskId);
    assert.equal(memTask3.done_count, 2, 'Incomplete expiry with total=2 earned credit');
  });

  // ----------------------------------------------------------------------------
  // C. Elements Drill Endpoint Verification
  // ----------------------------------------------------------------------------
  it('3. Elements Drill: rejects early incomplete submit; accepts complete early submit; preserves frozen duration on delayed delivery; rejects forged tiny duration', async () => {
    // 3a. Start assigned Elements drill
    const startRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: { action: 'start', drill: 'day_codes', todo_task_id: elementsTaskId },
        student: studentAlice,
        adminSupabase,
      }),
      startRes
    );
    assert.equal(startRes.statusCode, 200);
    const sessionId = startRes.body.session_id;
    const drillObj = DRILLS['day_codes'];
    const totalQ = drillObj.questions; // 50

    // 3b. Early submit with incomplete answers (10 answered out of 50) -> 400
    const partialAnswers = new Array(totalQ).fill(null);
    for (let i = 0; i < 10; i++) partialAnswers[i] = '1';

    const earlyIncompleteRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: sessionId,
          answers: partialAnswers,
          client_duration_seconds: 15,
        },
        student: studentAlice,
        adminSupabase,
      }),
      earlyIncompleteRes
    );
    assert.equal(earlyIncompleteRes.statusCode, 400);
    assert.match(earlyIncompleteRes.body.error, /All questions must be answered to submit an assigned Daily Task before the deadline/i);

    // 3c. Forged physically impossible duration (e.g. 1.0s for 50 questions) -> 400
    const fullAnswers = new Array(totalQ).fill('1');
    const forgedSpeedRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: sessionId,
          answers: fullAnswers,
          client_duration_seconds: 1.0, // 1s for 50 questions is impossible
        },
        student: studentAlice,
        adminSupabase,
      }),
      forgedSpeedRes
    );
    assert.equal(forgedSpeedRes.statusCode, 400);
    assert.match(forgedSpeedRes.body.error, /finished faster than possible/i);

    // 3d. Early completion delivered after the deadline: student solved in 20s, network transit/retry arrived at 75s (> 63s deadline)
    const sessionRow = adminSupabase.store.drill_sessions.get(sessionId);
    sessionRow.started_at = new Date(Date.now() - 75000).toISOString(); // 75s elapsed on server (> 63s deadline)

    const delayedDeliveryRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: sessionId,
          answers: fullAnswers,
          client_duration_seconds: 20, // genuine 20s solve
        },
        student: studentAlice,
        adminSupabase,
      }),
      delayedDeliveryRes
    );
    assert.equal(delayedDeliveryRes.statusCode, 200);
    // Crucial assertion: duration must be 20s (preserved across deadline, NOT forced to 60s!)
    assert.equal(delayedDeliveryRes.body.seconds, 20, 'Duration preserved at frozen 20s despite delivery after deadline');

    // Verify task credit in PostgreSQL
    const creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    const elemTask = creditRes.rows.find((t) => t.task_id === elementsTaskId);
    assert.equal(elemTask.done_count, 1);
    assert.equal(elemTask.done, true);

    // 3e. Duplicate submit returns 400
    const dupRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: { action: 'submit', session_id: sessionId, answers: fullAnswers },
        student: studentAlice,
        adminSupabase,
      }),
      dupRes
    );
    assert.equal(dupRes.statusCode, 400);
    assert.match(dupRes.body.error, /already submitted/i);

    // 3f. Empty expiry at deadline saves with total = 0 and earns 0 credit
    const startEmptyRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: { action: 'start', drill: 'day_codes', todo_task_id: elementsTaskId },
        student: studentAlice,
        adminSupabase,
      }),
      startEmptyRes
    );
    const emptySessionId = startEmptyRes.body.session_id;
    const emptyRow = adminSupabase.store.drill_sessions.get(emptySessionId);
    emptyRow.started_at = new Date(Date.now() - 70000).toISOString(); // > 63s deadline

    const emptySubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: emptySessionId,
          answers: new Array(totalQ).fill(null),
        },
        student: studentAlice,
        adminSupabase,
      }),
      emptySubmitRes
    );
    assert.equal(emptySubmitRes.statusCode, 200);
    assert.equal(emptySubmitRes.body.attempted, 0);

    // Verify credit did NOT increase
    const creditEmptyRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    const elemTaskEmpty = creditEmptyRes.rows.find((t) => t.task_id === elementsTaskId);
    assert.equal(elemTaskEmpty.done_count, 1, 'Empty expiry earned 0 credit, done_count stayed at 1');
  });

  // ----------------------------------------------------------------------------
  // D. Basics Endpoint Verification
  // ----------------------------------------------------------------------------
  it('4. Basics: unlimited practice lasting > 60s records true duration (not clamped to 60s); timed assigned task earns credit', async () => {
    // 4a. Start unlimited practice session
    const startUnlimitedRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'unlimited',
        },
        student: studentAlice,
        adminSupabase,
      }),
      startUnlimitedRes
    );
    assert.equal(startUnlimitedRes.statusCode, 200);
    const unlimSessionId = startUnlimitedRes.body.session_id;

    // Student practiced for 115 seconds, answering 35 questions
    const unlimSession = adminSupabase.store.drill_sessions.get(unlimSessionId);
    unlimSession.started_at = new Date(Date.now() - 120000).toISOString(); // 120s ago

    const unlimSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: unlimSessionId,
          answers: new Array(35).fill('5'),
          client_duration_seconds: 115,
        },
        student: studentAlice,
        adminSupabase,
      }),
      unlimSubmitRes
    );
    assert.equal(unlimSubmitRes.statusCode, 200);
    // Crucial assertion: unlimited practice must record 115s (NOT clamped to 60s fallback!)
    assert.equal(unlimSubmitRes.body.used_seconds, 115, 'Unlimited practice duration recorded at 115s without 60s cap');
    const savedResult = await db.query(`SELECT time_seconds FROM public.results WHERE id = '${unlimSubmitRes.body.result_id}';`);
    assert.equal(Number(savedResult.rows[0].time_seconds), 115);

    // 4b. Assigned timed Basics task: Early finish delivered BEFORE deadline earns 0 credit
    const startEarlyBeforeRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startEarlyBeforeRes
    );
    assert.equal(startEarlyBeforeRes.statusCode, 200);
    const earlyBeforeSessionId = startEarlyBeforeRes.body.session_id;
    const earlyBeforeRow = adminSupabase.store.drill_sessions.get(earlyBeforeSessionId);
    earlyBeforeRow.started_at = new Date(Date.now() - 20000).toISOString(); // 20s ago (before 63s deadline)

    const earlyBeforeSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: earlyBeforeSessionId,
          answers: new Array(10).fill('5'),
          client_duration_seconds: 20,
        },
        student: studentAlice,
        adminSupabase,
      }),
      earlyBeforeSubmitRes
    );
    assert.equal(earlyBeforeSubmitRes.statusCode, 200);
    assert.equal(earlyBeforeSubmitRes.body.used_seconds, 20);

    // Verify: early finish saved to results history with 20s, but earned ZERO task credit in todo_status_on
    let creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    let basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 0, 'Early finish delivered before deadline earned 0 task credit');

    // 4c. Assigned timed Basics task: Early finish delivered AFTER deadline earns 0 credit
    // Student finished solving after 20s, but delivery delayed or retried to 75s (> 63s deadline)
    const startEarlyAfterRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startEarlyAfterRes
    );
    assert.equal(startEarlyAfterRes.statusCode, 200);
    const earlyAfterSessionId = startEarlyAfterRes.body.session_id;
    const earlyAfterRow = adminSupabase.store.drill_sessions.get(earlyAfterSessionId);
    earlyAfterRow.started_at = new Date(Date.now() - 75000).toISOString(); // 75s ago (> 63s deadline)

    const earlyAfterSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: earlyAfterSessionId,
          answers: new Array(10).fill('5'),
          client_duration_seconds: 20, // student only solved for 20s
        },
        student: studentAlice,
        adminSupabase,
      }),
      earlyAfterSubmitRes
    );
    assert.equal(earlyAfterSubmitRes.statusCode, 200);
    assert.equal(earlyAfterSubmitRes.body.used_seconds, 20, 'Early finish duration preserved at 20s');

    // Verify session settings: not labeled completed_duration, todo_credit: false
    const afterSessionSaved = adminSupabase.store.drill_sessions.get(earlyAfterSessionId);
    assert.equal(afterSessionSaved.settings.early_finish, true);
    assert.equal(afterSessionSaved.settings.completed_duration, false);
    assert.equal(afterSessionSaved.settings.todo_credit, false);

    // Check PostgreSQL: arrival after deadline alone must NOT convert early finish into full duration credit
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 0, 'Early finish arriving after deadline earned ZERO task credit');

    // 4d. Retry crossing deadline for the same early finish: zero credit
    const retryEarlyRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: earlyAfterSessionId,
          answers: new Array(10).fill('5'),
          client_duration_seconds: 20,
        },
        student: studentAlice,
        adminSupabase,
      }),
      retryEarlyRes
    );
    assert.equal(retryEarlyRes.statusCode, 400); // Already submitted
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 0, 'Retry of early finish earned 0 credit');

    // 4e. Genuine full-duration positive attempt: Alice solves full 60s until timer runs out
    const startTimedRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startTimedRes
    );
    assert.equal(startTimedRes.statusCode, 200);
    const timedSessionId = startTimedRes.body.session_id;

    const timedRow = adminSupabase.store.drill_sessions.get(timedSessionId);
    timedRow.started_at = new Date(Date.now() - 65000).toISOString(); // 65s ago

    const timedSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: timedSessionId,
          answers: new Array(20).fill('5'),
          client_duration_seconds: 60,
        },
        student: studentAlice,
        adminSupabase,
      }),
      timedSubmitRes
    );
    assert.equal(timedSubmitRes.statusCode, 200);

    // Verify task credit in PostgreSQL: exactly 1 credit earned
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 1, 'Genuine full duration attempt earned credit');
    assert.equal(basicsTask.done, true);

    // 4f. Genuine empty expiry: student lets 60s timer run out with zero answers attempted -> 0 credit
    await db.query(`UPDATE public.daily_tasks SET required_count = 3 WHERE id = '${basicsTaskId}';`);

    const startEmptyRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startEmptyRes
    );
    const emptySessionId = startEmptyRes.body.session_id;
    const emptyRow = adminSupabase.store.drill_sessions.get(emptySessionId);
    emptyRow.started_at = new Date(Date.now() - 65000).toISOString();

    const emptySubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: emptySessionId,
          answers: [],
        },
        student: studentAlice,
        adminSupabase,
      }),
      emptySubmitRes
    );
    assert.equal(emptySubmitRes.statusCode, 200);
    assert.equal(emptySubmitRes.body.empty_expiry, true);
    assert.equal(emptySubmitRes.body.attempted, 0);

    // Verify done_count remained 1 (zero credit for empty expiry)
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 1, 'Empty expiry earned zero credit');

    // 4g. All-wrong full-duration attempt: student attempts 5 questions, all incorrect, completes full 60s
    const startAllWrongRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startAllWrongRes
    );
    const allWrongSessionId = startAllWrongRes.body.session_id;
    const allWrongRow = adminSupabase.store.drill_sessions.get(allWrongSessionId);
    allWrongRow.started_at = new Date(Date.now() - 65000).toISOString();

    const allWrongSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: allWrongSessionId,
          answers: ['999', '999', '999', '999', '999'], // 5 all wrong
          client_duration_seconds: 60,
        },
        student: studentAlice,
        adminSupabase,
      }),
      allWrongSubmitRes
    );
    assert.equal(allWrongSubmitRes.statusCode, 200);
    assert.equal(allWrongSubmitRes.body.attempted, 5);
    assert.equal(allWrongSubmitRes.body.correct, 0);

    // In todo_status_on: all-wrong full duration attempt earns task credit!
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 2, 'All-wrong full duration attempt earned credit');

    // 4h. Final session/result linkage update failure handling:
    // If the final update fails, cleans up the inserted result row and reopens session so retry succeeds
    const startFailLinkRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
          todo_task_id: basicsTaskId,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startFailLinkRes
    );
    const failLinkSessionId = startFailLinkRes.body.session_id;
    const failLinkRow = adminSupabase.store.drill_sessions.get(failLinkSessionId);
    failLinkRow.started_at = new Date(Date.now() - 65000).toISOString();

    // Configure linkage update to simulate a transient network/db failure
    adminSupabase.setNextUpdateError('drill_sessions_linkage', new Error('Simulated transient linkage error'));

    const failLinkSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: failLinkSessionId,
          answers: new Array(15).fill('5'),
          client_duration_seconds: 60,
        },
        student: studentAlice,
        adminSupabase,
      }),
      failLinkSubmitRes
    );
    assert.equal(failLinkSubmitRes.statusCode, 500);
    assert.match(failLinkSubmitRes.body.error, /Could not record task credit linkage/i);

    // Verify session is reopened to 'open' and submitted_at is null
    const reopenedSession = adminSupabase.store.drill_sessions.get(failLinkSessionId);
    assert.equal(reopenedSession.status, 'open', 'Session was cleanly reopened for retry');
    assert.equal(reopenedSession.submitted_at, null);

    // Verify retry succeeds cleanly without simulated failure
    const retrySubmitSuccessRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: failLinkSessionId,
          answers: new Array(15).fill('5'),
          client_duration_seconds: 60,
        },
        student: studentAlice,
        adminSupabase,
      }),
      retrySubmitSuccessRes
    );
    assert.equal(retrySubmitSuccessRes.statusCode, 200);

    // Verify final credit: done_count is now 3, done = true
    creditRes = await db.query(`SELECT * FROM public.todo_status_on('${studentAlice.id}');`);
    basicsTask = creditRes.rows.find((t) => t.task_id === basicsTaskId);
    assert.equal(basicsTask.done_count, 3, 'Retry after transient linkage failure earned credit');
    assert.equal(basicsTask.done, true);

    // 4i. Forged timing claim: 20 questions claimed in 2 seconds (faster than 20 * 0.25 = 5.0s) -> 400
    const startForgedRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'start',
          kind: 'basics',
          category_id: basicsCatId,
          mode: 'timed',
          seconds: 60,
        },
        student: studentAlice,
        adminSupabase,
      }),
      startForgedRes
    );
    const forgedSessionId = startForgedRes.body.session_id;
    const forgedRow = adminSupabase.store.drill_sessions.get(forgedSessionId);
    forgedRow.started_at = new Date(Date.now() - 75000).toISOString();

    const forgedSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: forgedSessionId,
          answers: new Array(20).fill('5'),
          client_duration_seconds: 2, // 2s for 20 questions is impossible
        },
        student: studentAlice,
        adminSupabase,
      }),
      forgedSubmitRes
    );
    assert.equal(forgedSubmitRes.statusCode, 400);
    assert.match(forgedSubmitRes.body.error, /finished faster than possible/i);

    // 4j. Duplicate submission on submitted session returns 400
    const dupSubmitRes = createMockRes();
    await drillHandler(
      createMockReq({
        body: {
          action: 'submit',
          session_id: earlyBeforeSessionId,
          answers: new Array(10).fill('5'),
        },
        student: studentAlice,
        adminSupabase,
      }),
      dupSubmitRes
    );
    assert.equal(dupSubmitRes.statusCode, 400);
    assert.match(dupSubmitRes.body.error, /already submitted/i);
  });
});
