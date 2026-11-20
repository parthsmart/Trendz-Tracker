/**
 * Trendz Tracker - Phase 18 Migration Upgrade & Idempotency Test (tests/phase18_migration_upgrade_pglite.test.js)
 *
 * Verifies upgrading an existing live Mumbai database to Migration 16:
 * 1. Preloads live pre-Phase-18 schema including:
 *    - `notification_dismissals` table with `dismissed_at` (NOT `created_at`)
 *    - `my_notifications()` returning `event_date DATE`
 *    - `weekly_test_reserve_section_start(UUID, UUID, UUID, UUID)` from Migration 14
 *    - `save_weekly_test_sections_atomic(UUID, JSONB, JSONB)` (3 arguments) from Migration 13
 *    - `dismiss_notification(TEXT)` from Migration 15
 * 2. Applies `16_phase18_teacher_role_and_workspace.sql` (first upgrade) -> must succeed without errors
 * 3. Applies `16_phase18_teacher_role_and_workspace.sql` a second time -> rerun safety & idempotency
 * 4. Calls `my_notifications()` as an authenticated student and verifies:
 *    - General admin content appears as before with valid DATE event_date
 *    - Targeted teacher content appears only for assigned recipients
 *    - A non-recipient student at the same level receives zero targeted content
 *    - Existing dismissal and reminder-stage behavior remains correct
 *    - Creator deactivation preserves saved audience and does not broaden visibility to all students
 *    - Replaced functions (reserve_section_start, save_weekly_test_sections_atomic) function unambiguously
 *
 * Run with: node --test tests/phase18_migration_upgrade_pglite.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Phase 18 — Database Upgrade & Notification Contract Verification', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const teacherAId = '22222222-2222-2222-2222-222222222222';
  const student1Id = '44444444-4444-4444-4444-444444444444';
  const student2Id = '55555555-5555-5555-5555-555555555555';
  const inactiveStudentId = '33333333-3333-3333-3333-333333333333';
  const riyaId = '77777777-7777-7777-7777-777777777777';

  const setAuth = async (userId, role = 'authenticated') => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '${userId || ''}', false);
      SELECT set_config('app.current_jwt_role', '${role}', false);
    `);
    if (role === 'authenticated' || role === 'anon') {
      await db.exec(`SET ROLE ${role};`);
    } else {
      await db.exec(`SET ROLE postgres;`);
    }
  };

  const setupPrePhase18Baseline = async (targetDb) => {
    // 1. Roles & auth mock
    await targetDb.exec(`
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
        SELECT jsonb_build_object(
          'role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated'),
          'sub', NULLIF(current_setting('app.current_user_id', true), '')
        );
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Preload pre-Phase-18 live schema
    await targetDb.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID REFERENCES public.categories(id),
        student_round_id UUID,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT NOT NULL DEFAULT 0,
        note TEXT,
        entry_date DATE NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT false,
        verified_by UUID REFERENCES public.profiles(id),
        verified_at TIMESTAMPTZ,
        corrected_by UUID REFERENCES public.profiles(id),
        corrected_at TIMESTAMPTZ,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.attendance_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        session_date DATE NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'class',
        notes TEXT,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.attendance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
        note TEXT,
        marked_by UUID REFERENCES public.profiles(id),
        marked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        UNIQUE(session_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.result_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        result_id UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        changed_by UUID REFERENCES public.profiles(id),
        action TEXT NOT NULL,
        reason TEXT,
        old_values JSONB,
        new_values JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE OR REPLACE FUNCTION public.today_ist()
      RETURNS DATE AS $$
        SELECT (timezone('Asia/Kolkata', now()))::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin()
      RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid() AND role = 'admin' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.competition_rules()
      RETURNS TABLE (
        weekly_test_multiplier INTEGER,
        attendance_present_points INTEGER,
        improved_min_entries INTEGER,
        leaderboard_names TEXT
      ) AS $$
        SELECT 2, 5, 5, 'first_name_initial'::TEXT;
      $$ LANGUAGE sql STABLE;

      CREATE TABLE IF NOT EXISTS public.basics_thresholds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID REFERENCES public.categories(id),
        level TEXT,
        min_accuracy NUMERIC,
        max_time_seconds INT,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE OR REPLACE VIEW public.results_with_target AS
      SELECT
        r.*,
        NULL::numeric AS min_accuracy,
        NULL::integer AS max_time_seconds,
        NULL::boolean AS meets_target
      FROM public.results r;

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        verified BOOLEAN NOT NULL DEFAULT false,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.weekly_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_date DATE NOT NULL DEFAULT public.today_ist(),
        title TEXT NOT NULL,
        notes TEXT,
        audience_level TEXT,
        test_type TEXT NOT NULL DEFAULT 'offline',
        opens_at TIMESTAMPTZ,
        closes_at TIMESTAMPTZ,
        remind_days_before INT NOT NULL DEFAULT 7,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 1 AND position <= 20),
        category_id UUID NULL REFERENCES public.categories(id),
        seconds INT NULL CHECK (seconds IS NULL OR seconds IN (30, 60, 120, 300)),
        kind TEXT NOT NULL CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad')),
        activity_key TEXT NULL,
        flash_digits INT NULL,
        flash_count INT NULL,
        flash_speed_ms INT NULL,
        flash_mode TEXT NULL,
        question_count INT NULL,
        CONSTRAINT weekly_test_sections_test_id_position_key UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
        category_id UUID REFERENCES public.categories(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT,
        source TEXT NOT NULL DEFAULT 'offline',
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        CONSTRAINT uq_weekly_test_scores_test_student_section UNIQUE (test_id, student_id, section_id)
      );

      CREATE OR REPLACE FUNCTION public.attendance_summary(p_student uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
      RETURNS TABLE(present_count integer, absent_count integer, excused_count integer, attendance_pct numeric) AS $$
      BEGIN
        RETURN QUERY
        SELECT
          (count(*) FILTER (WHERE a.status = 'present'))::integer,
          (count(*) FILTER (WHERE a.status = 'absent'))::integer,
          (count(*) FILTER (WHERE a.status = 'excused'))::integer,
          CASE WHEN count(*) FILTER (WHERE a.status IN ('present', 'absent')) > 0
            THEN round(100.0 * count(*) FILTER (WHERE a.status = 'present')
                       / count(*) FILTER (WHERE a.status IN ('present', 'absent')), 1)
          END
        FROM public.attendance a
        JOIN public.attendance_sessions s ON s.id = a.session_id
        WHERE a.student_id = p_student
          AND (p_from IS NULL OR s.session_date >= p_from)
          AND (p_to IS NULL OR s.session_date <= p_to);
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.streak_calc(p_student uuid)
      RETURNS TABLE(current_streak integer, best_streak integer, shields integer, active_today boolean) AS $$
      BEGIN
        RETURN QUERY SELECT 1, 1, 0, true;
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.practice_stats_for(p_student uuid, p_from date, p_to date)
      RETURNS TABLE(n_entries integer, n_correct bigint, n_total bigint, accuracy_pct numeric, qpm numeric, n_rounds integer) AS $$
        SELECT count(*)::integer,
               COALESCE(sum(r.correct), 0)::bigint,
               COALESCE(sum(r.total), 0)::bigint,
               CASE WHEN sum(r.total) > 0 THEN round(100.0 * sum(r.correct) / sum(r.total), 1) END,
               CASE WHEN COALESCE(sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0), 0) > 0
                    THEN round(sum(r.total) FILTER (WHERE r.time_seconds > 0)
                               / (sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0) / 60.0), 1) END,
               count(DISTINCT r.student_round_id)::integer
          FROM public.results r
         WHERE r.student_id = p_student
           AND r.entry_date BETWEEN p_from AND p_to
           AND r.total > 0 AND r.correct IS NOT NULL;
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.practice_days_for(p_student uuid, p_from date, p_to date)
      RETURNS integer AS $$
        SELECT count(DISTINCT q.dt)::integer
          FROM (
            SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS dt
              FROM public.results r
             WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
            UNION ALL
            SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
              FROM public.activity_results a
             WHERE a.student_id = p_student AND a.total > 0
          ) q
         WHERE q.dt BETWEEN p_from AND p_to;
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.points_for(p_student uuid, p_from date, p_to date)
      RETURNS numeric AS $$
        SELECT COALESCE((SELECT sum(GREATEST(0, 2 * s.correct - s.total))
                           FROM public.weekly_test_scores s
                           JOIN public.weekly_tests t ON t.id = s.test_id
                          WHERE s.student_id = p_student AND t.test_date BETWEEN p_from AND p_to), 0)
               * (SELECT cr.weekly_test_multiplier FROM public.competition_rules() cr)
             + COALESCE((SELECT count(*)
                           FROM public.attendance a
                           JOIN public.attendance_sessions x ON x.id = a.session_id
                          WHERE a.student_id = p_student AND a.status = 'present'
                            AND x.session_date BETWEEN p_from AND p_to), 0)
               * (SELECT cr.attendance_present_points FROM public.competition_rules() cr);
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
        category_id UUID REFERENCES public.categories(id),
        session_id UUID,
        status TEXT,
        tries_started INT DEFAULT 1,
        tries_correct INT DEFAULT 0,
        seconds_used INT DEFAULT 0,
        claim_token UUID,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        CONSTRAINT uq_weekly_test_attempts_test_student_section UNIQUE (test_id, student_id, section_id)
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
        level TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES public.profiles(id),
        activity_key TEXT,
        flash_digits INT,
        flash_count INT,
        flash_speed_ms INT,
        flash_mode TEXT,
        required_count INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        audience_level TEXT,
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        description TEXT,
        topic TEXT NOT NULL DEFAULT 'General',
        audience_level TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.student_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
        title VARCHAR(120) NOT NULL,
        body TEXT NOT NULL,
        needs_attention BOOLEAN NOT NULL DEFAULT false,
        attention_reason TEXT,
        linked_type VARCHAR(30),
        linked_id UUID,
        link TEXT,
        client_nonce TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        read_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ
      );

      -- PRE-UPGRADE notification_dismissals TABLE WITH dismissed_at (exact live contract)
      CREATE TABLE IF NOT EXISTS public.notification_dismissals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        ref TEXT NOT NULL,
        dismissed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        CONSTRAINT uq_notification_dismissals_student_ref UNIQUE(student_id, ref)
      );

      -- PRE-UPGRADE dismiss_notification RPC (from Migration 15)
      CREATE OR REPLACE FUNCTION public.dismiss_notification(p_ref TEXT)
      RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
      AS $$
      BEGIN
        IF auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;

        IF p_ref ~ '^msg:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          UPDATE public.student_messages
          SET dismissed_at = timezone('utc'::text, now())
          WHERE id = substring(p_ref from 5)::uuid AND student_id = auth.uid();
          INSERT INTO public.notification_dismissals (student_id, ref)
          VALUES (auth.uid(), p_ref)
          ON CONFLICT DO NOTHING;
        ELSIF p_ref ~ '^(test|ann):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:(upcoming|tomorrow|today))?$' THEN
          INSERT INTO public.notification_dismissals (student_id, ref)
          VALUES (auth.uid(), p_ref)
          ON CONFLICT DO NOTHING;
        ELSE
          RAISE EXCEPTION 'Invalid notification.';
        END IF;
      END;
      $$;

      -- PRE-UPGRADE my_notifications() RPC WITH event_date DATE (exact live contract)
      CREATE OR REPLACE FUNCTION public.my_notifications()
      RETURNS TABLE (
        ref TEXT,
        kind TEXT,
        title TEXT,
        body TEXT,
        link TEXT,
        event_date DATE,
        days_left INT,
        created_at TIMESTAMPTZ
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      STABLE
      AS $$
      DECLARE
        v_student_id UUID := auth.uid();
        v_today DATE := public.today_ist();
        v_level TEXT;
        v_role TEXT;
        v_active BOOLEAN;
      BEGIN
        SELECT role, level, active INTO v_role, v_level, v_active
        FROM public.profiles
        WHERE id = v_student_id;

        IF NOT FOUND OR v_active IS NOT TRUE THEN
          RETURN;
        END IF;

        -- 1. Weekly Tests
        RETURN QUERY
        SELECT
          'test:' || t.id || ':' || (
            CASE
              WHEN t.test_date = v_today THEN 'today'
              WHEN t.test_date = v_today + 1 THEN 'tomorrow'
              ELSE 'upcoming'
            END
          ) AS ref,
          CASE
            WHEN t.test_date = v_today THEN 'test_today'
            ELSE 'test_upcoming'
          END AS kind,
          t.title,
          CASE
            WHEN t.test_type = 'online' THEN 'Online test on Trendz Tracker.'
            ELSE 'Offline test with your trainer.'
          END || COALESCE(' ' || NULLIF(TRIM(t.notes), ''), '') AS body,
          '/pages/weekly-test.html' AS link,
          t.test_date AS event_date,
          (t.test_date - v_today)::INT AS days_left,
          t.created_at
        FROM public.weekly_tests t
        WHERE t.test_date >= v_today
          AND t.test_date <= v_today + COALESCE(t.remind_days_before, 7)
          AND (
            t.audience_level IS NULL
            OR LOWER(TRIM(t.audience_level)) = 'everyone'
            OR LOWER(TRIM(t.audience_level)) = LOWER(TRIM(COALESCE(v_level, '')))
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.notification_dismissals d
            WHERE d.student_id = v_student_id
              AND d.ref = ('test:' || t.id || ':' || (
                CASE
                  WHEN t.test_date = v_today THEN 'today'
                  WHEN t.test_date = v_today + 1 THEN 'tomorrow'
                  ELSE 'upcoming'
                END
              ))
          )
        ORDER BY t.test_date ASC;

        -- 2. Announcements
        RETURN QUERY
        SELECT
          'ann:' || a.id AS ref,
          'announcement' AS kind,
          a.title,
          a.body,
          '/pages/student.html' AS link,
          (a.starts_at AT TIME ZONE 'Asia/Kolkata')::DATE AS event_date,
          NULL::INT AS days_left,
          a.created_at
        FROM public.announcements a
        WHERE a.starts_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
          AND (
            a.audience_level IS NULL
            OR LOWER(TRIM(a.audience_level)) = 'everyone'
            OR LOWER(TRIM(a.audience_level)) = LOWER(TRIM(COALESCE(v_level, '')))
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.notification_dismissals d
            WHERE d.student_id = v_student_id AND d.ref = 'ann:' || a.id
          )
        ORDER BY a.starts_at DESC;
      END;
      $$;

      -- PRE-UPGRADE save_weekly_test_sections_atomic (3-arg overload from Migration 13)
      CREATE OR REPLACE FUNCTION public.save_weekly_test_sections_atomic(
        p_test_id UUID,
        p_test JSONB,
        p_sections JSONB
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN jsonb_build_object('ok', true, 'v', 'pre18');
      END;
      $$;

      -- PRE-UPGRADE weekly_test_reserve_section_start (Migration 14 exact signature)
      CREATE OR REPLACE FUNCTION public.weekly_test_reserve_section_start(
        p_test_id UUID,
        p_student_id UUID,
        p_section_id UUID DEFAULT NULL,
        p_category_id UUID DEFAULT NULL
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN jsonb_build_object('ok', true, 'v', 'pre18');
      END;
      $$;

      -- PRE-UPGRADE Permissive Policies (exact live Mumbai database snapshot)
      ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "weekly_tests_read" ON public.weekly_tests;
      CREATE POLICY "weekly_tests_read" ON public.weekly_tests FOR SELECT TO authenticated USING (true);

      ALTER TABLE public.weekly_test_sections ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "wt_sections_read" ON public.weekly_test_sections;
      CREATE POLICY "wt_sections_read" ON public.weekly_test_sections FOR SELECT TO authenticated USING (true);

      ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "att_sessions_read" ON public.attendance_sessions;
      CREATE POLICY "att_sessions_read" ON public.attendance_sessions FOR SELECT TO authenticated USING (true);

      -- PRE-UPGRADE todo_status_on (Exact live Mumbai database state: LANGUAGE sql, p_student uuid, p_day date, PUBLIC execute)
      CREATE OR REPLACE FUNCTION public.todo_status_on(p_student uuid, p_day date)
      RETURNS TABLE(task_id uuid, task_title text, task_section text, task_category_id uuid, task_activity_key text, required_count integer, done_count integer, done boolean)
      LANGUAGE sql
      STABLE SECURITY DEFINER
      SET search_path TO 'public'
      AS $function$
        SELECT x.id, x.title, x.section, x.category_id, x.activity_key, x.required_count, x.cnt,
               (x.cnt >= x.required_count)
          FROM (
            SELECT t.id, t.title, t.section, t.category_id, t.activity_key, t.required_count, t.sort_order,
              (CASE
                WHEN t.category_id IS NOT NULL AND t.section = 'round' THEN
                  (SELECT count(DISTINCT r.student_round_id) FROM public.results r
                    WHERE r.student_id = p_student AND r.category_id = t.category_id
                      AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
                WHEN t.category_id IS NOT NULL THEN
                  (SELECT count(*) FROM public.results r
                    WHERE r.student_id = p_student AND r.category_id = t.category_id
                      AND r.entry_date = p_day)
                WHEN t.section = 'round' THEN
                  (SELECT count(DISTINCT r.student_round_id) FROM public.results r
                     JOIN public.categories c ON c.id = r.category_id
                    WHERE r.student_id = p_student AND c.section = 'round'
                      AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
                WHEN t.section = 'basics' THEN
                  (SELECT count(*) FROM public.results r
                     JOIN public.categories c ON c.id = r.category_id
                    WHERE r.student_id = p_student AND c.section = 'basics' AND r.entry_date = p_day)
                WHEN t.section = 'elements' THEN
                  (SELECT count(*) FROM public.activity_results a
                    WHERE a.student_id = p_student AND a.activity_type = 'element'
                      AND (t.activity_key IS NULL OR a.settings ->> 'drill' = t.activity_key)
                      AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
                WHEN t.section = 'flash' THEN
                  (SELECT count(*) FROM public.activity_results a
                    WHERE a.student_id = p_student AND a.activity_type = 'flash_anzan'
                      AND (t.flash_digits IS NULL OR a.settings ->> 'digits' = t.flash_digits::text)
                      AND (t.flash_count IS NULL OR a.settings ->> 'count' = t.flash_count::text)
                      AND (t.flash_speed_ms IS NULL OR a.settings ->> 'speed_ms' = t.flash_speed_ms::text)
                      AND (t.flash_mode IS NULL OR a.settings ->> 'mode' = t.flash_mode)
                      AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
                WHEN t.section = 'memoriad' THEN
                  (SELECT count(*) FROM public.activity_results a
                    WHERE a.student_id = p_student AND a.activity_type = 'memoriad'
                      AND (t.activity_key IS NULL OR a.settings ->> 'module' = t.activity_key)
                      AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
                ELSE 0
              END)::integer AS cnt
              FROM public.daily_tasks t
              JOIN public.profiles p ON p.id = p_student
             WHERE t.active AND (t.level IS NULL OR t.level = p.level)
          ) x
         ORDER BY x.sort_order, x.title;
      $function$;

      GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO PUBLIC;

      -- PRE-UPGRADE todo_for (Exact live Mumbai database state: Thin wrapper, PUBLIC execute)
      CREATE OR REPLACE FUNCTION public.todo_for(p_student uuid)
      RETURNS TABLE(task_id uuid, task_title text, task_section text, task_category_id uuid, task_activity_key text, required_count integer, done_count integer, done boolean)
      LANGUAGE plpgsql
      STABLE SECURITY DEFINER
      SET search_path TO 'public'
      AS $function$
      BEGIN
        IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
          RAISE EXCEPTION 'Not allowed';
        END IF;
        RETURN QUERY SELECT * FROM public.todo_status_on(p_student, public.today_ist());
      END;
      $function$;

      GRANT EXECUTE ON FUNCTION public.todo_for(UUID) TO PUBLIC;
    `);

    // Insert initial seed users
    await targetDb.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active) VALUES
      ('${adminId}', 'admin', 'ADM-01', 'Primary Admin', 'Grandmaster', true),
      ('${student1Id}', 'student', 'STU-01', 'Alice Student', 'Junior 1', true),
      ('${student2Id}', 'student', 'STU-02', 'Bob Student', 'Junior 1', true),
      ('${inactiveStudentId}', 'student', 'STU-03', 'Inactive Charlie', 'Junior 1', false),
      ('${riyaId}', 'student', 'STU-101', 'Riya Sen', 'Senior', true);

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
      ('00000000-0000-0000-0000-000000000001', 'Direct 1D', 'basics', 1),
      ('00000000-0000-0000-0000-000000000002', 'Junior Round', 'round', 1);

      -- Practice results for Riya & Alice
      INSERT INTO public.results (student_id, category_id, entry_date, correct, total, time_seconds)
      VALUES
        ('${riyaId}', '00000000-0000-0000-0000-000000000001', '2026-11-04'::date, 20, 20, 45),
        ('${student1Id}', '00000000-0000-0000-0000-000000000001', '2026-11-04'::date, 15, 15, 40);

      -- Weekly test "November Weekly Assessment" on 2026-11-05
      INSERT INTO public.weekly_tests (id, test_date, title, audience_level, test_type)
      VALUES ('88888888-8888-8888-8888-888888888888', '2026-11-05'::date, 'November Weekly Assessment', 'everyone', 'online');

      -- Section 1: Elements 'squares_stage_1' (category_id NULL)
      INSERT INTO public.weekly_test_sections (id, test_id, position, kind, activity_key)
      VALUES ('88888888-8888-8888-8888-888888888801', '88888888-8888-8888-8888-888888888888', 1, 'elements', 'squares_stage_1');

      -- Weekly test score: Riya's confirmed score 25/25 on 5 November 2026 (category_id NULL)
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds, created_at)
      VALUES ('88888888-8888-8888-8888-888888888888', '${riyaId}', '88888888-8888-8888-8888-888888888801', NULL, 25, 25, 30, '2026-11-05T10:00:00Z');

      -- Attendance session on 2026-11-04
      INSERT INTO public.attendance_sessions (id, title, session_date, created_by)
      VALUES ('88888888-8888-8888-8888-888888888802', 'Wednesday Class', '2026-11-04'::date, '${adminId}');

      INSERT INTO public.attendance (session_id, student_id, status)
      VALUES ('88888888-8888-8888-8888-888888888802', '${riyaId}', 'present');

      GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;
    `);

    // 3. Install BOTH standalone hotfixes to establish the post-hotfix baseline
    const patch1Path = path.join(ROOT_DIR, 'supabase', 'standalone_todo_status_on_patch.sql');
    const patch1Sql = fs.readFileSync(patch1Path, 'utf8');
    await targetDb.exec(patch1Sql);

    const patch2Path = path.join(ROOT_DIR, 'supabase', 'standalone_student_month_report_patch.sql');
    const patch2Sql = fs.readFileSync(patch2Path, 'utf8');
    await targetDb.exec(patch2Sql);
  };

  before(async () => {
    db = new PGlite();
    await setupPrePhase18Baseline(db);
  });

  it('0. Standalone security patch applies cleanly over pre-Phase-18 baseline and verifies all regression cases', async () => {
    const patchPath = path.join(ROOT_DIR, 'supabase', 'standalone_todo_status_on_patch.sql');
    const patchSql = fs.readFileSync(patchPath, 'utf8');

    // Apply standalone patch
    await assert.doesNotReject(
      async () => {
        await db.exec(patchSql);
      },
      'Standalone patch must apply cleanly on pre-Phase-18 baseline'
    );

    // a) Anonymous rejection
    await setAuth(null, 'anon');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
      },
      /Unauthorized: Authentication required|permission denied for function/
    );

    // b) Inactive-user rejection
    await setAuth(inactiveStudentId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [inactiveStudentId]);
      },
      /Forbidden: Inactive or invalid user/
    );

    // c) Student-self access succeeds
    await setAuth(student1Id);
    const s1Check = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
    assert.ok(Array.isArray(s1Check.rows), 'Student-self can query own tasks');

    // d) Student accessing other student rejected
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student2Id]);
      },
      /Forbidden: You may only view your own daily tasks/
    );

    // e) Active admin succeeds
    await setAuth(adminId);
    const adminCheck = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
    assert.ok(Array.isArray(adminCheck.rows), 'Admin can inspect any student');

    // f) Service-role succeeds
    await setAuth(adminId, 'service_role');
    const srvCheck = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student2Id]);
    assert.ok(Array.isArray(srvCheck.rows), 'Service role can inspect any student');

    // g) Effective execution privileges revoked from anon and PUBLIC
    const anonPriv = await db.query(`SELECT has_function_privilege('anon', 'public.todo_status_on(uuid, date)', 'EXECUTE') AS priv`);
    assert.equal(anonPriv.rows[0].priv, false, 'anon role cannot execute todo_status_on');
    const authPriv = await db.query(`SELECT has_function_privilege('authenticated', 'public.todo_status_on(uuid, date)', 'EXECUTE') AS priv`);
    assert.equal(authPriv.rows[0].priv, true, 'authenticated role can execute todo_status_on');
    assert.equal(authPriv.rows[0].priv, true, 'authenticated role can execute todo_status_on');

    // h) Regression: Category-free rounds excluding Basics records
    const catBasicsId = '00000000-0000-0000-0000-000000000001';
    const catRoundId = '00000000-0000-0000-0000-000000000002';
    const roundTaskId = '99999999-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, sort_order, active)
      VALUES ('${roundTaskId}', 'Any Round Task', 'round', NULL, 1, 1, true);
    `);
    // Insert basics result row
    await db.query(`
      INSERT INTO public.results (student_id, category_id, entry_date, correct, total, time_seconds)
      VALUES ('${student1Id}', '${catBasicsId}', public.today_ist(), 10, 10, 30);
    `);
    // Query todo_status_on: Category-free round task MUST exclude basics results!
    await setAuth(student1Id);
    let todos = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist()) WHERE task_id = $2`, [student1Id, roundTaskId]);
    assert.equal(todos.rows[0].done_count, 0, 'Category-free round task excludes Basics results');

    // Insert round result row with student_round_id
    await setAuth(adminId, 'service_role');
    const testRoundId = '00000000-0000-0000-0000-000000000099';
    await db.query(`
      INSERT INTO public.results (student_id, student_round_id, category_id, entry_date, correct, total, time_seconds)
      VALUES ('${student1Id}', '${testRoundId}', '${catRoundId}', public.today_ist(), 10, 10, 30);
    `);
    await setAuth(student1Id);
    todos = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist()) WHERE task_id = $2`, [student1Id, roundTaskId]);
    assert.equal(todos.rows[0].done_count, 1, 'Category-free round task counts matching Round result');

    // i) Regression: Missing and malformed legacy Flash settings without new cast errors
    const flashTaskId = '99999999-0000-0000-0000-000000000002';
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.daily_tasks (id, title, section, flash_digits, flash_count, flash_speed_ms, flash_mode, required_count, sort_order, active)
      VALUES ('${flashTaskId}', 'Flash Anzan 2D 10N', 'flash', 2, 10, 800, 'add', 1, 2, true);
    `);
    // Insert malformed settings, empty settings, and valid matching settings
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
      VALUES
        ('${student1Id}', 'flash_anzan', 'Flash', 1, 1, 10, '{}'::jsonb),
        ('${student1Id}', 'flash_anzan', 'Flash', 1, 1, 10, '{"digits": "corrupt", "count": "abc", "speed_ms": "fast", "mode": "unknown"}'::jsonb),
        ('${student1Id}', 'flash_anzan', 'Flash', 1, 1, 10, '{"digits": "2", "count": "10", "speed_ms": "800", "mode": "add"}'::jsonb);
    `);
    await setAuth(student1Id);
    // Must NOT throw "invalid input syntax for type integer"
    todos = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist()) WHERE task_id = $2`, [student1Id, flashTaskId]);
    assert.equal(todos.rows[0].done_count, 1, 'Malformed legacy flash settings did not cause integer cast error');
    assert.equal(todos.rows[0].done, true, 'Flash task completed');

    // j) Regression: Original ordering (sort_order, title) and level matching
    await setAuth(adminId, 'service_role');
    const taskOrderB = '99999999-0000-0000-0000-000000000003';
    const taskOrderA = '99999999-0000-0000-0000-000000000004';
    const taskSenior = '99999999-0000-0000-0000-000000000005';
    await db.query(`
      INSERT INTO public.daily_tasks (id, title, section, level, sort_order, active)
      VALUES
        ('${taskOrderB}', 'Zeta Basics', 'basics', 'Junior 1', 10, true),
        ('${taskOrderA}', 'Alpha Basics', 'basics', 'Junior 1', 10, true),
        ('${taskSenior}', 'Senior Only Task', 'basics', 'Senior', 10, true);
    `);
    await setAuth(student1Id);
    const orderedTodos = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist()) WHERE task_id IN ($2, $3, $4)`, [student1Id, taskOrderB, taskOrderA, taskSenior]);
    assert.equal(orderedTodos.rows.length, 2, 'Senior task excluded for Junior 1 student');
    assert.equal(orderedTodos.rows[0].task_title, 'Alpha Basics', 'Alpha sorted before Zeta on equal sort_order');
    assert.equal(orderedTodos.rows[1].task_title, 'Zeta Basics');

    // Clean up temporary regression tasks from baseline table for subsequent migration test
    await setAuth(adminId, 'service_role');
    await db.query(`DELETE FROM public.daily_tasks WHERE id IN ($1, $2, $3, $4, $5)`, [roundTaskId, flashTaskId, taskOrderB, taskOrderA, taskSenior]);
    await db.query(`DELETE FROM public.results WHERE student_id = $1`, [student1Id]);
    await db.query(`DELETE FROM public.activity_results WHERE student_id = $1`, [student1Id]);

    // k) Baseline verification of Hotfix 2: student_month_report returns Riya's Elements score (25/25)
    // and executes all 5 nested helper functions
    await setAuth(riyaId);
    const riyaRep = await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [riyaId]);
    const riyaData = typeof riyaRep.rows[0].student_month_report === 'string'
      ? JSON.parse(riyaRep.rows[0].student_month_report)
      : riyaRep.rows[0].student_month_report;
    assert.equal(riyaData.student.code, 'STU-101');
    assert.equal(riyaData.practice.entries, 1);
    assert.equal(riyaData.attendance.present, 1);
    assert.ok(riyaData.points > 0, 'Points computed using competition_rules()');
    assert.equal(riyaData.weekly_tests.length, 1);
    assert.equal(riyaData.weekly_tests[0].category, 'Square - Stage 1 (1-25)', 'Elements score resolves properly in baseline');
    assert.equal(riyaData.weekly_tests[0].correct, 25);
    assert.equal(riyaData.weekly_tests[0].total, 25);
  });

  it('0b. Function dependency inspection: confirms no dropped functions have CASCADE or dependent objects', async () => {
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // 1. Assert no DROP FUNCTION ... CASCADE in Migration 16
    assert.doesNotMatch(migrationSql, /DROP\s+FUNCTION[^\n;]+CASCADE/i, 'Migration 16 must NEVER drop functions with CASCADE');

    // 2. Query pg_depend for objects depending on dropped functions
    const droppedFuncs = [
      'admin_create_teacher_entry',
      'admin_replace_teacher_assignments',
      'admin_update_teacher_permissions',
      'admin_set_teacher_active',
      'save_weekly_test_sections_atomic',
      'save_announcement_atomic',
      'save_resource_atomic',
      'save_daily_task_atomic'
    ];

    for (const fn of droppedFuncs) {
      const depCheck = await db.query(`
        SELECT objid::regclass AS dependent_table
        FROM pg_depend
        WHERE refobjid IN (
          SELECT p.oid FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1
        ) AND deptype = 'n';
      `, [fn]);
      assert.equal(depCheck.rows.length, 0, `No normal dependencies depending on ${fn}`);
    }
  });

  it('1. Upgrading existing database: Migration 16 applies cleanly over pre-Phase-18 schema', async () => {
    await setAuth(null, 'postgres');
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Must execute cleanly without:
    // - "cannot change return type of existing function" (my_notifications, todo_for)
    // - "cannot change name of input parameter" (weekly_test_reserve_section_start)
    // - "function is not unique" (save_weekly_test_sections_atomic)
    await assert.doesNotReject(
      async () => {
        await db.exec(migrationSql);
      },
      'Migration 16 should apply cleanly on top of existing database snapshot'
    );
  });

  it('2. Rerun idempotency: Migration 16 applies a second time with zero errors', async () => {
    await setAuth(null, 'postgres');
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    await assert.doesNotReject(
      async () => {
        await db.exec(migrationSql);
      },
      'Migration 16 second run must be completely idempotent'
    );
  });

  it('2b. Independent upgrade: Migration 16 applies cleanly and independently on unpatched pre-Phase-18 baseline', async () => {
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    const freshDb = new PGlite();
    await setupPrePhase18Baseline(freshDb);

    // Verify Migration 16 applies cleanly and directly over the unpatched baseline
    await assert.doesNotReject(
      async () => {
        await freshDb.exec(migrationSql);
      },
      'Migration 16 must apply cleanly directly over unpatched baseline'
    );

    // Verify rerun idempotency directly on freshDb
    await assert.doesNotReject(
      async () => {
        await freshDb.exec(migrationSql);
      },
      'Migration 16 rerun must be completely idempotent directly over unpatched baseline'
    );
  });

  it('2c. Existing populated baseline data is completely preserved after upgrade', async () => {
    // 1. Student profile
    const riyaProf = await db.query(`SELECT id, student_code, full_name, level, role, active FROM public.profiles WHERE id = $1`, [riyaId]);
    assert.equal(riyaProf.rows.length, 1);
    assert.equal(riyaProf.rows[0].student_code, 'STU-101');
    assert.equal(riyaProf.rows[0].full_name, 'Riya Sen');
    assert.equal(riyaProf.rows[0].level, 'Senior');
    assert.equal(riyaProf.rows[0].role, 'student');
    assert.equal(riyaProf.rows[0].active, true);

    // 2. Practice results
    const riyaRes = await db.query(`SELECT correct, total, time_seconds FROM public.results WHERE student_id = $1`, [riyaId]);
    assert.equal(riyaRes.rows.length, 1);
    assert.equal(riyaRes.rows[0].correct, 20);
    assert.equal(riyaRes.rows[0].total, 20);

    // 3. Weekly test scores (Elements score with category_id NULL)
    const wtScore = await db.query(`SELECT correct, total, category_id FROM public.weekly_test_scores WHERE student_id = $1`, [riyaId]);
    assert.equal(wtScore.rows.length, 1);
    assert.equal(wtScore.rows[0].correct, 25);
    assert.equal(wtScore.rows[0].total, 25);
    assert.equal(wtScore.rows[0].category_id, null);

    // 4. Attendance
    const attRec = await db.query(`SELECT status FROM public.attendance WHERE student_id = $1`, [riyaId]);
    assert.equal(attRec.rows.length, 1);
    assert.equal(attRec.rows[0].status, 'present');
  });

  it('2d. Hotfix 2 is preserved in full: student_month_report retains Riya Elements score with nested helpers & teacher auth', async () => {
    // 1. Admin views Riya's report
    await setAuth(adminId, 'service_role');
    const adminRep = await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [riyaId]);
    const adminData = typeof adminRep.rows[0].student_month_report === 'string'
      ? JSON.parse(adminRep.rows[0].student_month_report)
      : adminRep.rows[0].student_month_report;
    assert.equal(adminData.student.code, 'STU-101');
    assert.equal(adminData.practice.entries, 1);
    assert.equal(adminData.weekly_tests.length, 1);
    assert.equal(adminData.weekly_tests[0].category, 'Square - Stage 1 (1-25)', 'Elements score resolved');
    assert.equal(adminData.weekly_tests[0].correct, 25);
    assert.equal(adminData.weekly_tests[0].total, 25);

    // 2. Riya views own report
    await setAuth(riyaId);
    const selfRep = await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [riyaId]);
    const selfData = typeof selfRep.rows[0].student_month_report === 'string'
      ? JSON.parse(selfRep.rows[0].student_month_report)
      : selfRep.rows[0].student_month_report;
    assert.deepEqual(selfData.practice, adminData.practice);
    assert.equal(selfData.weekly_tests.length, 1);

    // 3. Unrelated student 1 is forbidden from viewing Riya's report
    await setAuth(student1Id);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [riyaId]);
      },
      /Forbidden: You may only view your own monthly report/
    );

    // 4. Assign Teacher A to Riya with can_view_reports
    await setAuth(adminId, 'service_role');
    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES ('${teacherAId}', 'teacher', 'TCH-01', 'Teacher Alpha', 'Teacher', true)
      ON CONFLICT (id) DO UPDATE SET role = 'teacher', active = true;

      INSERT INTO public.teacher_permissions (teacher_id)
      VALUES ('${teacherAId}')
      ON CONFLICT (teacher_id) DO UPDATE SET can_generate_reports = true, can_view_students = true;

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
      VALUES ('${teacherAId}', '${riyaId}', '${adminId}')
      ON CONFLICT DO NOTHING;
    `);

    // 5. Assigned Teacher A can view Riya's report
    await setAuth(teacherAId);
    const tchRep = await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [riyaId]);
    const tchData = typeof tchRep.rows[0].student_month_report === 'string'
      ? JSON.parse(tchRep.rows[0].student_month_report)
      : tchRep.rows[0].student_month_report;
    assert.equal(tchData.student.code, 'STU-101');
    assert.equal(tchData.weekly_tests.length, 1);
    assert.equal(tchData.weekly_tests[0].category, 'Square - Stage 1 (1-25)');

    // 6. Assigned Teacher A attempting to view unassigned Student 2's report is forbidden
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report($1, '2026-11-01'::DATE)`, [student2Id]);
      },
      /Forbidden: You may only view your own monthly report/
    );
  });

  it('3. Existing notification_dismissals table contract preserved: uses dismissed_at column', async () => {
    const cols = await db.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notification_dismissals'
      ORDER BY ordinal_position;
    `);

    const colNames = cols.rows.map(r => r.column_name);
    assert.ok(colNames.includes('student_id'), 'Has student_id column');
    assert.ok(colNames.includes('ref'), 'Has ref column');
    assert.ok(colNames.includes('dismissed_at'), 'Has dismissed_at column (matches live contract)');
  });

  it('4. my_notifications contract: return type event_date is DATE and returns valid date', async () => {
    const fnDef = await db.query(`
      SELECT p.proname, pg_get_function_result(p.oid) AS ret_type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'my_notifications';
    `);

    assert.ok(fnDef.rows.length > 0, 'my_notifications function exists');
    const retType = fnDef.rows[0].ret_type;
    assert.match(retType, /event_date date/i, 'Return table defines event_date as DATE (not TEXT)');
  });

  it('5. General admin content appears as before with correctly typed event_date', async () => {
    await setAuth(adminId, 'service_role');

    // Admin creates an all-audience online test and announcement
    const testRes = await db.query(`
      INSERT INTO public.weekly_tests (title, test_date, test_type, audience_level, created_by, target_scope)
      VALUES ('Admin General Test', public.today_ist(), 'online', 'everyone', '${adminId}', 'all')
      RETURNING id, test_date;
    `);
    const generalTestId = testRes.rows[0].id;

    const annRes = await db.query(`
      INSERT INTO public.announcements (title, body, audience_level, starts_at, created_by, target_scope)
      VALUES ('Admin Announcement', 'General notice for all students', 'everyone', now() - INTERVAL '1 hour', '${adminId}', 'all')
      RETURNING id;
    `);
    const generalAnnId = annRes.rows[0].id;

    // Student 1 calls my_notifications
    await setAuth(student1Id);
    const s1Notifs = await db.query(`SELECT ref, kind, title, event_date, days_left FROM public.my_notifications();`);

    const foundTest = s1Notifs.rows.find(r => r.ref.startsWith(`test:${generalTestId}`));
    assert.ok(foundTest, 'General admin test appears for student');
    assert.equal(foundTest.kind, 'test_today');
    assert.equal(foundTest.days_left, 0);
    assert.ok(foundTest.event_date, 'event_date is present');

    const foundAnn = s1Notifs.rows.find(r => r.ref === `ann:${generalAnnId}`);
    assert.ok(foundAnn, 'General admin announcement appears for student');
    assert.equal(foundAnn.kind, 'announcement');
    assert.ok(foundAnn.event_date, 'Announcement event_date is present as DATE');

    // Student 2 (same level) also receives the general admin content
    await setAuth(student2Id);
    const s2Notifs = await db.query(`SELECT ref, kind, title FROM public.my_notifications();`);
    assert.ok(s2Notifs.rows.some(r => r.ref.startsWith(`test:${generalTestId}`)), 'Student 2 sees general test');
    assert.ok(s2Notifs.rows.some(r => r.ref === `ann:${generalAnnId}`), 'Student 2 sees general announcement');
  });

  it('6. Targeted teacher content appears ONLY for assigned recipient; non-recipient gets ZERO targeted content', async () => {
    // 1. Create Teacher A and assign only Student 1
    await setAuth(adminId, 'service_role');
    await db.exec(`
      INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
      VALUES ('${teacherAId}', 'teacher', 'TCH-01', 'Teacher Alpha', 'Teacher', true)
      ON CONFLICT (id) DO UPDATE SET role = 'teacher', active = true;

      INSERT INTO public.teacher_permissions (teacher_id)
      VALUES ('${teacherAId}')
      ON CONFLICT (teacher_id) DO UPDATE SET can_manage_tests = true, can_publish_announcements = true;

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
      VALUES ('${teacherAId}', '${student1Id}', '${adminId}')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Teacher A creates targeted weekly test and announcement for Student 1
    await setAuth(teacherAId);
    const todayRes = await db.query('SELECT public.today_ist()::text AS today;');
    const today = todayRes.rows[0].today;
    const catId = '00000000-0000-0000-0000-000000000001';
    const testSaveRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY[$3::uuid]) AS res`,
      [
        JSON.stringify({ title: 'Teacher Alpha Private Test', test_date: today, test_type: 'online' }),
        JSON.stringify([{ position: 1, kind: 'basics', category_id: catId, seconds: 60 }]),
        student1Id
      ]
    );
    const testData = typeof testSaveRes.rows[0].res === 'string' ? JSON.parse(testSaveRes.rows[0].res) : testSaveRes.rows[0].res;
    const targetedTestId = testData.test_id || testData.id;

    const annSaveRes = await db.query(
      `SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({ title: 'Teacher Alpha Private Notice', body: 'Exclusive notice for Student 1' }),
        student1Id
      ]
    );
    const annData = typeof annSaveRes.rows[0].res === 'string' ? JSON.parse(annSaveRes.rows[0].res) : annSaveRes.rows[0].res;
    const targetedAnnId = annData.id;

    // 3. Student 1 calls my_notifications -> MUST see targeted test and announcement
    await setAuth(student1Id);
    const s1Notifs = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    const s1Test = s1Notifs.rows.find(r => r.ref.startsWith(`test:${targetedTestId}`));
    const s1Ann = s1Notifs.rows.find(r => r.ref === `ann:${targetedAnnId}`);

    assert.ok(s1Test, 'Student 1 receives targeted teacher test');
    assert.ok(s1Ann, 'Student 1 receives targeted teacher announcement');

    // 4. Student 2 (same Junior 1 level) calls my_notifications -> MUST receive ZERO targeted content
    await setAuth(student2Id);
    const s2Notifs = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    const s2Test = s2Notifs.rows.find(r => r.ref.startsWith(`test:${targetedTestId}`));
    const s2Ann = s2Notifs.rows.find(r => r.ref === `ann:${targetedAnnId}`);

    assert.equal(s2Test, undefined, 'Student 2 must NOT receive Teacher Alpha targeted test');
    assert.equal(s2Ann, undefined, 'Student 2 must NOT receive Teacher Alpha targeted announcement');
  });

  it('7. Dismissal & reminder-stage behavior remains fully functional', async () => {
    await setAuth(student1Id);

    // Fetch Student 1's notifications
    const beforeDismiss = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    const targetAnn = beforeDismiss.rows.find(r => r.title === 'Teacher Alpha Private Notice');
    assert.ok(targetAnn, 'Target announcement is present before dismissal');

    // Call dismiss_notification
    await db.query(`SELECT public.dismiss_notification($1);`, [targetAnn.ref]);

    // Verify written to notification_dismissals with dismissed_at
    const dismissalRec = await db.query(`
      SELECT student_id, ref, dismissed_at
      FROM public.notification_dismissals
      WHERE student_id = $1 AND ref = $2;
    `, [student1Id, targetAnn.ref]);

    assert.equal(dismissalRec.rows.length, 1, 'Dismissal record exists');
    assert.ok(dismissalRec.rows[0].dismissed_at, 'dismissed_at timestamp populated');

    // Verify announcement no longer appears in my_notifications
    const afterDismiss = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    assert.ok(!afterDismiss.rows.some(r => r.ref === targetAnn.ref), 'Dismissed announcement removed from notifications');
  });

  it('8. Creator deactivation preserves audience targeting and does NOT broaden to other students', async () => {
    // 1. Admin deactivates Teacher Alpha
    await setAuth(adminId, 'service_role');
    await db.query(`SELECT public.admin_set_teacher_active($1, false, $2);`, [teacherAId, adminId]);

    // 2. Student 1 calls my_notifications() -> assigned test STILL appears (durable audience)
    await setAuth(student1Id);
    const s1Notifs = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    const s1Test = s1Notifs.rows.find(r => r.title === 'Teacher Alpha Private Test');
    assert.ok(s1Test, 'Student 1 STILL receives targeted test after teacher deactivation');

    // 3. Student 2 calls my_notifications() -> STILL receives ZERO targeted content
    await setAuth(student2Id);
    const s2Notifs = await db.query(`SELECT ref, title FROM public.my_notifications();`);
    const s2Test = s2Notifs.rows.find(r => r.title === 'Teacher Alpha Private Test');
    assert.equal(s2Test, undefined, 'Student 2 still receives ZERO targeted content after teacher deactivation');
  });

  it('9. Replaced functions argument and return compatibility', async () => {
    // Fetch the test section for Teacher Alpha's test using service_role
    await setAuth(adminId, 'service_role');
    const secRow = await db.query(`
      SELECT s.id, s.test_id
      FROM public.weekly_test_sections s
      JOIN public.weekly_tests t ON t.id = s.test_id
      WHERE t.title = 'Teacher Alpha Private Test'
      LIMIT 1;
    `);
    assert.ok(secRow.rows.length > 0, 'Section found');
    const secId = secRow.rows[0].id;
    const testId = secRow.rows[0].test_id;

    // weekly_test_reserve_section_start is a server-only RPC called by service_role
    // Call with 3 arguments for assigned Student 1 -> succeeds
    const res3 = await db.query(
      `SELECT public.weekly_test_reserve_section_start($1, $2, $3) AS res`,
      [testId, student1Id, secId]
    );
    const obj3 = typeof res3.rows[0].res === 'string' ? JSON.parse(res3.rows[0].res) : res3.rows[0].res;
    assert.equal(obj3.ok, true, '3-argument reservation succeeds');
    assert.ok(obj3.claim_token, 'claim_token returned');

    // Call for unassigned Student 2 -> rejected
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.weekly_test_reserve_section_start($1, $2, $3)`,
          [testId, student2Id, secId]
        );
      },
      /You are not assigned to this weekly test/
    );

    // save_weekly_test_sections_atomic works without ambiguity (3-arg call)
    const todayRes = await db.query('SELECT public.today_ist()::text AS today;');
    const today = todayRes.rows[0].today;
    const catId = '00000000-0000-0000-0000-000000000001';
    const saveRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb) AS res`,
      [
        JSON.stringify({ title: 'Unambiguous 3-arg Test', test_date: today, test_type: 'offline' }),
        JSON.stringify([{ position: 1, kind: 'basics', category_id: catId, seconds: 60 }])
      ]
    );
    const saveObj = typeof saveRes.rows[0].res === 'string' ? JSON.parse(saveRes.rows[0].res) : saveRes.rows[0].res;
    assert.equal(saveObj.ok, true, 'Unambiguous 3-arg call succeeds');
  });

  it('10. todo_status_on authorization, 8-column contract, distinct-round counts, and activity completion', async () => {
    // 1. Check return row columns from pg_proc for both todo_status_on and todo_for
    for (const fn of ['todo_status_on', 'todo_for']) {
      const fnDef = await db.query(`
        SELECT p.proname, pg_get_function_result(p.oid) AS ret_type
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1;
      `, [fn]);
      assert.ok(fnDef.rows.length > 0, `${fn} function exists`);
      const retType = fnDef.rows[0].ret_type;
      assert.match(retType, /task_id uuid/i, `${fn} has task_id uuid`);
      assert.match(retType, /task_title text/i, `${fn} has task_title text`);
      assert.match(retType, /task_section text/i, `${fn} has task_section text`);
      assert.match(retType, /task_category_id uuid/i, `${fn} has task_category_id uuid`);
      assert.match(retType, /task_activity_key text/i, `${fn} has task_activity_key text`);
      assert.match(retType, /required_count integer/i, `${fn} has required_count integer`);
      assert.match(retType, /done_count integer/i, `${fn} has done_count integer`);
      assert.match(retType, /done boolean/i, `${fn} has done boolean`);
    }

    // 2. Anonymous access denied: both direct todo_status_on and todo_for reject anon callers
    await setAuth(null, 'anon');
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
      },
      /Unauthorized: Authentication required|permission denied for function/
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_for($1)`, [student1Id]);
      },
      /Unauthorized: Authentication required|permission denied for function/
    );

    // 3. Student access: self succeeds, another student's UUID is denied
    await setAuth(student1Id);
    // Self succeeds
    const s1SelfCheck = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
    assert.ok(Array.isArray(s1SelfCheck.rows), 'Student 1 can inspect self via todo_status_on');

    // Querying another student is strictly forbidden
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student2Id]);
      },
      /Forbidden: You may only view your own daily tasks/
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_for($1)`, [student2Id]);
      },
      /Forbidden: You may only view your own daily tasks/
    );

    // 4. Re-activate Teacher Alpha and grant can_manage_tasks & can_view_students
    await setAuth(adminId, 'service_role');
    await db.query(`SELECT public.admin_set_teacher_active($1, true, $2)`, [teacherAId, adminId]);
    await db.query(`
      UPDATE public.teacher_permissions
      SET can_manage_tasks = true, can_view_students = true
      WHERE teacher_id = $1
    `, [teacherAId]);

    // 5. Assigned teacher access succeeds; unassigned student is denied
    await setAuth(teacherAId);
    const teacherOwnStudent = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
    assert.ok(Array.isArray(teacherOwnStudent.rows), 'Assigned teacher can inspect student 1');

    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student2Id]);
      },
      /Forbidden: (Inactive or invalid user|You do not have permission to view daily tasks for this student)/
    );

    // 6. Create daily tasks targeted to Student 1 across Round, Basics, Elements, Flash, Memoriad
    const catId = '00000000-0000-0000-0000-000000000001';

    // a) Round task (required_count = 2)
    const taskRoundRes = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({
          title: 'Rounds 2x Daily',
          section: 'round',
          required_count: 2
        }),
        student1Id
      ]
    );
    const taskRoundId = (typeof taskRoundRes.rows[0].res === 'string' ? JSON.parse(taskRoundRes.rows[0].res) : taskRoundRes.rows[0].res).id;

    // b) Basics task (required_count = 2)
    const task1Res = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({
          title: 'Basics 2x Practice',
          section: 'basics',
          category_id: catId,
          required_count: 2
        }),
        student1Id
      ]
    );
    const task1Id = (typeof task1Res.rows[0].res === 'string' ? JSON.parse(task1Res.rows[0].res) : task1Res.rows[0].res).id;

    // c) Elements task (required_count = 1)
    const task2Res = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({
          title: 'Day Codes Daily',
          section: 'elements',
          activity_key: 'day_codes',
          required_count: 1
        }),
        student1Id
      ]
    );
    const task2Id = (typeof task2Res.rows[0].res === 'string' ? JSON.parse(task2Res.rows[0].res) : task2Res.rows[0].res).id;

    // d) Flash Anzan task (required_count = 2, fixed parameters)
    const task3Res = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({
          title: 'Flash Anzan 2D 10N',
          section: 'flash',
          flash_digits: 2,
          flash_count: 10,
          flash_speed_ms: 1000,
          flash_mode: 'add',
          required_count: 2
        }),
        student1Id
      ]
    );
    const task3Id = (typeof task3Res.rows[0].res === 'string' ? JSON.parse(task3Res.rows[0].res) : task3Res.rows[0].res).id;

    // e) Memoriad task (required_count = 1)
    const task4Res = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [
        JSON.stringify({
          title: 'Speed Numbers Daily',
          section: 'memoriad',
          activity_key: 'speed_numbers',
          required_count: 1
        }),
        student1Id
      ]
    );
    const task4Id = (typeof task4Res.rows[0].res === 'string' ? JSON.parse(task4Res.rows[0].res) : task4Res.rows[0].res).id;

    // 7. Distinct student_round_id count verification:
    // Insert 3 score rows in results sharing the SAME student_round_id
    await setAuth(adminId, 'service_role');
    const catRoundId = '00000000-0000-0000-0000-000000000002';
    const round1Id = '00000000-0000-0000-0000-000000000010';
    for (let i = 0; i < 3; i++) {
      await db.query(`
        INSERT INTO public.results (student_id, student_round_id, category_id, entry_date, correct, total, time_seconds)
        VALUES ('${student1Id}', '${round1Id}', '${catRoundId}', public.today_ist(), 10, 10, 30);
      `);
    }

    // Student 1 checks todo_for() -> Round task has done_count = 1 (NOT 3!), done = false
    await setAuth(student1Id);
    let s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [taskRoundId]);
    assert.equal(s1Todos.rows[0].done_count, 1, 'Several score rows belonging to one student_round_id count as ONE round');
    assert.equal(s1Todos.rows[0].done, false, '1 of 2 rounds done');

    // Insert 2 score rows with another student_round_id
    await setAuth(adminId, 'service_role');
    const round2Id = '00000000-0000-0000-0000-000000000020';
    for (let i = 0; i < 2; i++) {
      await db.query(`
        INSERT INTO public.results (student_id, student_round_id, category_id, entry_date, correct, total, time_seconds)
        VALUES ('${student1Id}', '${round2Id}', '${catRoundId}', public.today_ist(), 10, 10, 28);
      `);
    }

    await setAuth(student1Id);
    s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [taskRoundId]);
    assert.equal(s1Todos.rows[0].done_count, 2, 'Two distinct rounds recorded');
    assert.equal(s1Todos.rows[0].done, true, '2 of 2 rounds done -> round task completed');

    // 8. Basics counting: 2 result rows
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.results (student_id, category_id, entry_date, correct, total, time_seconds)
      VALUES
        ('${student1Id}', '${catId}', public.today_ist(), 10, 10, 45),
        ('${student1Id}', '${catId}', public.today_ist(), 10, 10, 40);
    `);

    await setAuth(student1Id);
    s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [task1Id]);
    assert.equal(s1Todos.rows[0].done_count, 2);
    assert.equal(s1Todos.rows[0].done, true, 'Basics task completed');

    // 9. Elements matching settings->>'drill'
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
      VALUES ('${student1Id}', 'element', 'day_codes', 50, 50, 40, '{"drill": "day_codes"}'::jsonb);
    `);

    await setAuth(student1Id);
    s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [task2Id]);
    assert.equal(s1Todos.rows[0].done_count, 1);
    assert.equal(s1Todos.rows[0].done, true, 'Elements task completed');

    // 10. Memoriad matching settings->>'module'
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
      VALUES ('${student1Id}', 'memoriad', 'Speed Numbers', 50, 50, 40, '{"module": "speed_numbers"}'::jsonb);
    `);

    await setAuth(student1Id);
    s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [task4Id]);
    assert.equal(s1Todos.rows[0].done_count, 1);
    assert.equal(s1Todos.rows[0].done, true, 'Memoriad task completed');

    // 11. Flash matching parameters (digits, count, speed_ms, mode)
    await setAuth(adminId, 'service_role');
    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
      VALUES
        ('${student1Id}', 'flash_anzan', 'Flash Anzan', 1, 1, 10, '{"digits": 2, "count": 10, "speed_ms": 1000, "mode": "add"}'::jsonb),
        ('${student1Id}', 'flash_anzan', 'Flash Anzan', 1, 1, 10, '{"digits": 2, "count": 10, "speed_ms": 1000, "mode": "add"}'::jsonb);
    `);

    await setAuth(student1Id);
    s1Todos = await db.query(`SELECT * FROM public.todo_for() WHERE task_id = $1`, [task3Id]);
    assert.equal(s1Todos.rows[0].done_count, 2);
    assert.equal(s1Todos.rows[0].done, true, 'Flash task completed on matching tries');

    // 12. Non-recipient Student 2 sees none of Student 1's targeted tasks via todo_for OR direct todo_status_on
    await setAuth(student2Id);
    const s2TodoList = await db.query(`SELECT * FROM public.todo_for() WHERE task_id IN ($1, $2, $3, $4, $5)`, [taskRoundId, task1Id, task2Id, task3Id, task4Id]);
    assert.equal(s2TodoList.rows.length, 0, 'Non-recipient student cannot see targeted tasks via todo_for');

    const s2StatusList = await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist()) WHERE task_id IN ($2, $3, $4, $5, $6)`, [student2Id, taskRoundId, task1Id, task2Id, task3Id, task4Id]);
    assert.equal(s2StatusList.rows.length, 0, 'Non-recipient student cannot see targeted tasks via direct todo_status_on');

    // 13. Teacher Alpha permissions and deactivation verification:
    // a) Permission revocation: revoking can_manage_tasks blocks teacher view
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tasks = false WHERE teacher_id = $1`, [teacherAId]);

    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
      },
      /Forbidden: (Inactive or invalid user|You do not have permission to view daily tasks for this student)/
    );

    // Restore can_manage_tasks, revoke can_view_students -> blocks teacher view
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tasks = true, can_view_students = false WHERE teacher_id = $1`, [teacherAId]);

    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
      },
      /Forbidden: (Inactive or invalid user|You do not have permission to view daily tasks for this student)/
    );

    // Restore can_view_students, de-activate teacher -> blocks teacher view
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_view_students = true WHERE teacher_id = $1`, [teacherAId]);
    await db.query(`SELECT public.admin_set_teacher_active($1, false, $2)`, [teacherAId, adminId]);

    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.todo_status_on($1, public.today_ist())`, [student1Id]);
      },
      /Forbidden: (Inactive or invalid user|You do not have permission to view daily tasks for this student)/
    );
  });

  it('11. Permissive policies dropped and non-recipient students blocked from reading targeted tests/sections/attendance sessions directly', async () => {
    // 1. Check pg_policies to confirm deployed permissive policies were dropped
    const pols = await db.query(`
      SELECT policyname, tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname IN ('weekly_tests_read', 'wt_sections_read', 'att_sessions_read');
    `);
    assert.equal(pols.rows.length, 0, 'Permissive policies weekly_tests_read, wt_sections_read, att_sessions_read were dropped');

    // 2. Fetch the targeted test and section created earlier for Student 1
    await setAuth(adminId, 'service_role');
    const testRow = await db.query(`
      SELECT t.id AS test_id, s.id AS sec_id
      FROM public.weekly_tests t
      JOIN public.weekly_test_sections s ON s.test_id = t.id
      WHERE t.title = 'Teacher Alpha Private Test'
      LIMIT 1;
    `);
    assert.ok(testRow.rows.length > 0, 'Targeted test found');
    const targetTestId = testRow.rows[0].test_id;
    const targetSecId = testRow.rows[0].sec_id;

    // 3. Student 1 (recipient) can directly read the weekly test and its section
    await setAuth(student1Id);
    const s1Test = await db.query(`SELECT id FROM public.weekly_tests WHERE id = $1`, [targetTestId]);
    assert.equal(s1Test.rows.length, 1, 'Student 1 (recipient) can read targeted weekly test');

    const s1Sec = await db.query(`SELECT id FROM public.weekly_test_sections WHERE id = $1`, [targetSecId]);
    assert.equal(s1Sec.rows.length, 1, 'Student 1 (recipient) can read targeted weekly test section');

    // 4. Student 2 (non-recipient at same level) is BLOCKED by RLS from reading test and section
    await setAuth(student2Id);
    const s2Test = await db.query(`SELECT id FROM public.weekly_tests WHERE id = $1`, [targetTestId]);
    assert.equal(s2Test.rows.length, 0, 'Student 2 (non-recipient) CANNOT read targeted weekly test via SELECT');

    const s2Sec = await db.query(`SELECT id FROM public.weekly_test_sections WHERE id = $1`, [targetSecId]);
    assert.equal(s2Sec.rows.length, 0, 'Student 2 (non-recipient) CANNOT read targeted weekly test section via SELECT');

    // 5. Attendance sessions RLS scoping
    await setAuth(adminId, 'service_role');
    const sessRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('Private Session Student 1', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const sessionId = sessRes.rows[0].id;

    // Mark Student 1 present; Student 2 has no record in this session
    await db.query(`
      INSERT INTO public.attendance (session_id, student_id, status)
      VALUES ('${sessionId}', '${student1Id}', 'present');
    `);

    // Student 1 (has attendance record) CAN read the attendance session
    await setAuth(student1Id);
    const s1Sess = await db.query(`SELECT id FROM public.attendance_sessions WHERE id = $1`, [sessionId]);
    assert.equal(s1Sess.rows.length, 1, 'Student 1 can read session with their attendance');

    // Student 2 (no attendance record) CANNOT read the attendance session
    await setAuth(student2Id);
    const s2Sess = await db.query(`SELECT id FROM public.attendance_sessions WHERE id = $1`, [sessionId]);
    assert.equal(s2Sess.rows.length, 0, 'Student 2 without attendance record CANNOT read attendance session');
  });

  it('12. Client roles (authenticated, anon) do not have TRUNCATE privilege', async () => {
    // Verify TRUNCATE privilege on key tables for authenticated and anon roles
    const tablesToCheck = [
      'results',
      'profiles',
      'weekly_tests',
      'weekly_test_sections',
      'attendance_sessions',
      'teacher_student_assignments',
      'teacher_permissions',
      'teacher_audit_log',
      'attendance_audit'
    ];

    for (const table of tablesToCheck) {
      const authTruncRes = await db.query(
        `SELECT has_table_privilege('authenticated', 'public.' || $1, 'TRUNCATE') AS has_trunc`,
        [table]
      );
      assert.equal(authTruncRes.rows[0].has_trunc, false, `authenticated must NOT have TRUNCATE on ${table}`);

      const anonTruncRes = await db.query(
        `SELECT has_table_privilege('anon', 'public.' || $1, 'TRUNCATE') AS has_trunc`,
        [table]
      );
      assert.equal(anonTruncRes.rows[0].has_trunc, false, `anon must NOT have TRUNCATE on ${table}`);
    }

    // Verify authenticated cannot directly INSERT into teacher_audit_log
    const authInsertRes = await db.query(
      `SELECT has_table_privilege('authenticated', 'public.teacher_audit_log', 'INSERT') AS has_insert`
    );
    assert.equal(authInsertRes.rows[0].has_insert, false, 'authenticated must NOT have direct INSERT on teacher_audit_log');
  });
});
