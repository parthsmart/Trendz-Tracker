-- =============================================================================
-- Trendz Tracker — Phase 18 Staging Disposable Fixture
-- File: supabase/staging_disposable_fixture.sql
--
-- PREREQUISITES (Run in order):
-- 1. Apply Migration 16 to Staging: supabase/owner_phase18_atomic_migration.sql
-- 2. Create the 4 Auth users in Staging Supabase Dashboard (Authentication > Users)
--    with Auto-Confirm enabled:
--    - stg-adm@trendz.local (Admin)
--    - stg-tch@trendz.local (Teacher)
--    - stg-001@trendz.local (Student 1 - Assigned)
--    - stg-002@trendz.local (Student 2 - Unassigned Non-Recipient)
--
-- WHAT THIS SCRIPT DOES:
-- - Resolves the real auth.users.id UUIDs for these 4 accounts from auth.users.
-- - Fails immediately with clear descriptive errors if ANY of the 4 Auth users or
--   Migration 16 tables are missing.
-- - Uses the actual auth.users.id UUIDs for profiles, permissions, and assignments.
--   (Zero foreign key violations, zero hardcoded profile UUIDs, zero subsequent updates).
-- - Inserts a known synthetic category ('Staging Basics Fixture', UUID 'bb000000-0000-0000-0000-000000000001').
-- - Inserts a sample practice test result for stg-001 with entry_date = public.today_ist().
-- - Includes comprehensive teardown SQL at the bottom covering content, recipients,
--   audit records, profiles, and auth cleanup guidance.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_admin_id UUID;
  v_teacher_id UUID;
  v_stu1_id UUID;
  v_stu2_id UUID;
  v_cat_id UUID := 'bb000000-0000-0000-0000-000000000001'::UUID;
  v_today DATE;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Verify Migration 16 Prerequisites
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
  ) THEN
    RAISE EXCEPTION 'Prerequisite missing: Phase 18 migration has not been applied. Please run supabase/owner_phase18_atomic_migration.sql first.'
      USING ERRCODE = 'P0002';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 2. Resolve Real Auth User UUIDs from auth.users
  -- ---------------------------------------------------------------------------
  SELECT id INTO v_admin_id FROM auth.users WHERE email = 'stg-adm@trendz.local';
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Prerequisite missing: Auth user stg-adm@trendz.local not found in auth.users. Please create it in Authentication > Users first.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_teacher_id FROM auth.users WHERE email = 'stg-tch@trendz.local';
  IF v_teacher_id IS NULL THEN
    RAISE EXCEPTION 'Prerequisite missing: Auth user stg-tch@trendz.local not found in auth.users. Please create it in Authentication > Users first.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_stu1_id FROM auth.users WHERE email = 'stg-001@trendz.local';
  IF v_stu1_id IS NULL THEN
    RAISE EXCEPTION 'Prerequisite missing: Auth user stg-001@trendz.local not found in auth.users. Please create it in Authentication > Users first.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_stu2_id FROM auth.users WHERE email = 'stg-002@trendz.local';
  IF v_stu2_id IS NULL THEN
    RAISE EXCEPTION 'Prerequisite missing: Auth user stg-002@trendz.local not found in auth.users. Please create it in Authentication > Users first.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Resolve India date
  v_today := public.today_ist();

  -- ---------------------------------------------------------------------------
  -- 3. Upsert Profiles using Real Auth UUIDs
  -- ---------------------------------------------------------------------------
  INSERT INTO public.profiles (id, role, student_code, full_name, level, active)
  VALUES
    (v_admin_id,   'admin',   'STG-ADM', 'Staging Admin',            'Admin',   true),
    (v_teacher_id, 'teacher', 'STG-TCH', 'Staging Teacher (Trainer)', 'Teacher', true),
    (v_stu1_id,    'student', 'STG-001', 'Staging Student Alpha',      'Basic 1', true),
    (v_stu2_id,    'student', 'STG-002', 'Staging Student Beta',       'Basic 1', true)
  ON CONFLICT (id) DO UPDATE SET
    role = EXCLUDED.role,
    student_code = EXCLUDED.student_code,
    full_name = EXCLUDED.full_name,
    level = EXCLUDED.level,
    active = EXCLUDED.active;

  -- ---------------------------------------------------------------------------
  -- 4. Seed Teacher Initial Permissions (All 10 actual columns enabled)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.teacher_permissions (
    teacher_id,
    can_view_students,
    can_mark_attendance,
    can_correct_attendance,
    can_generate_reports,
    can_manage_tasks,
    can_manage_tests,
    can_publish_announcements,
    can_manage_resources,
    can_review_scores,
    can_request_corrections,
    updated_at,
    updated_by
  ) VALUES (
    v_teacher_id,
    true, true, true, true, true, true, true, true, true, true,
    now(),
    v_admin_id
  )
  ON CONFLICT (teacher_id) DO UPDATE SET
    can_view_students = EXCLUDED.can_view_students,
    can_mark_attendance = EXCLUDED.can_mark_attendance,
    can_correct_attendance = EXCLUDED.can_correct_attendance,
    can_generate_reports = EXCLUDED.can_generate_reports,
    can_manage_tasks = EXCLUDED.can_manage_tasks,
    can_manage_tests = EXCLUDED.can_manage_tests,
    can_publish_announcements = EXCLUDED.can_publish_announcements,
    can_manage_resources = EXCLUDED.can_manage_resources,
    can_review_scores = EXCLUDED.can_review_scores,
    can_request_corrections = EXCLUDED.can_request_corrections,
    updated_at = now(),
    updated_by = EXCLUDED.updated_by;

  -- ---------------------------------------------------------------------------
  -- 5. Seed Teacher-Student Assignment (STG-001 assigned, STG-002 unassigned)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
  VALUES (v_teacher_id, v_stu1_id, v_admin_id)
  ON CONFLICT (teacher_id, student_id) DO NOTHING;

  -- ---------------------------------------------------------------------------
  -- 6. Ensure Known Synthetic Category (Section: basics)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.categories (id, name, section, sort_order)
  VALUES (v_cat_id, 'Staging Basics Fixture (Category 1)', 'basics', 1)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    section = EXCLUDED.section,
    sort_order = EXCLUDED.sort_order;

  -- ---------------------------------------------------------------------------
  -- 7. Seed Sample Practice Result for STG-001 (Date: today_ist())
  -- ---------------------------------------------------------------------------
  INSERT INTO public.results (
    id, student_id, category_id, correct, total, time_seconds, entry_date, verified
  ) VALUES (
    'bb555555-5555-5555-5555-555555555555'::UUID,
    v_stu1_id,
    v_cat_id,
    8, 10, 45,
    v_today,
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    student_id = EXCLUDED.student_id,
    category_id = EXCLUDED.category_id,
    correct = EXCLUDED.correct,
    total = EXCLUDED.total,
    time_seconds = EXCLUDED.time_seconds,
    entry_date = EXCLUDED.entry_date,
    verified = EXCLUDED.verified;

  RAISE NOTICE 'Staging disposable fixture applied successfully using Auth IDs: Admin=%, Teacher=%, Student1=%, Student2=%',
    v_admin_id, v_teacher_id, v_stu1_id, v_stu2_id;
END $$;

COMMIT;

-- =============================================================================
-- COMPREHENSIVE TEARDOWN SCRIPT (Prepare-Only: Run only when destroying staging fixture)
--
-- Note: Replace placeholders with the actual Auth UUIDs recorded during provisioning,
-- or look them up directly by email as demonstrated below:
-- =============================================================================
-- DO $$
-- DECLARE
--   v_admin_id UUID;
--   v_teacher_id UUID;
--   v_stu1_id UUID;
--   v_stu2_id UUID;
-- BEGIN
--   SELECT id INTO v_admin_id FROM auth.users WHERE email = 'stg-adm@trendz.local';
--   SELECT id INTO v_teacher_id FROM auth.users WHERE email = 'stg-tch@trendz.local';
--   SELECT id INTO v_stu1_id FROM auth.users WHERE email = 'stg-001@trendz.local';
--   SELECT id INTO v_stu2_id FROM auth.users WHERE email = 'stg-002@trendz.local';
--
--   -- 1. Created content and targeting
--   DELETE FROM public.weekly_test_recipients WHERE student_id IN (v_stu1_id, v_stu2_id);
--   DELETE FROM public.weekly_tests WHERE created_by = v_teacher_id;
--   DELETE FROM public.daily_tasks WHERE created_by = v_teacher_id;
--
--   -- 2. Attendance & audit
--   DELETE FROM public.attendance WHERE student_id IN (v_stu1_id, v_stu2_id);
--   DELETE FROM public.attendance_sessions WHERE created_by = v_teacher_id;
--   DELETE FROM public.attendance_audit WHERE changed_by IN (v_admin_id, v_teacher_id);
--
--   -- 3. Score corrections & results audit
--   DELETE FROM public.score_correction_requests WHERE teacher_id = v_teacher_id OR student_id IN (v_stu1_id, v_stu2_id);
--   DELETE FROM public.result_audit WHERE student_id IN (v_stu1_id, v_stu2_id) OR changed_by IN (v_admin_id, v_teacher_id);
--   DELETE FROM public.results WHERE student_id IN (v_stu1_id, v_stu2_id);
--   DELETE FROM public.activity_results WHERE student_id IN (v_stu1_id, v_stu2_id);
--
--   -- 4. Assignments & Permissions
--   DELETE FROM public.teacher_student_assignments WHERE teacher_id = v_teacher_id OR student_id IN (v_stu1_id, v_stu2_id);
--   DELETE FROM public.teacher_permissions WHERE teacher_id = v_teacher_id;
--
--   -- 5. Profiles & Synthetic Category
--   DELETE FROM public.profiles WHERE id IN (v_admin_id, v_teacher_id, v_stu1_id, v_stu2_id);
--   DELETE FROM public.categories WHERE id = 'bb000000-0000-0000-0000-000000000001'::UUID;
--
--   -- 6. Auth Users deletion (can also be deleted in Supabase Dashboard > Authentication > Users)
--   DELETE FROM auth.users WHERE id IN (v_admin_id, v_teacher_id, v_stu1_id, v_stu2_id);
-- END $$;
