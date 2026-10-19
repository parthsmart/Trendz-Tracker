# Trendz Tracker — Ordered SQL Migrations (`supabase/migrations/`)

A data backup is only useful if an empty Supabase PostgreSQL project can be rebuilt from scratch in the exact dependency order.

This directory contains all **12 SQL migration scripts** from Phase 1 through Phase 5c, numbered in the exact order they must be executed in the Supabase SQL Editor (or backed up to your Google Drive folder).

---

## Execution Order

Run each file top-to-bottom in the **Supabase SQL Editor** in this exact sequence:

1. **`01_phase1_schema.sql`** — Phase 1 schema (`profiles`, `categories`, legacy `rounds`, `results`, `activity_results`, `daily_tasks`, `is_admin()`, RLS policies, indexes, and 24 round + 2 basics seeds).
2. **`02_security_fixes_and_seeds.sql`** — Security fixes: safe `handle_new_auth_user()` sign-up trigger (prevents self-promotion via `raw_user_meta_data`), case-insensitive category uniqueness index, and full basics speed drill seeds.
3. **`03_phase2_today_ist_and_validate_result.sql`** — Phase 2: `today_ist()` (`Asia/Kolkata` date authority) and `validate_result()` trigger (`correct <= total`, no future dates, 7-day student backdate window, immutable `entry_date` on student updates).
4. **`04_phase3_streak_todo_and_resources.sql`** — Phase 3: `resources` table + RLS, `streak_for(p_student)` RPC, and `todo_for(p_student)` RPC.
5. **`05_phase3b_admin_overview.sql`** — Phase 3b: `admin_overview()` single-query dashboard RPC.
6. **`06_phase4a_review_audit_and_attendance.sql`** — Phase 4a: teacher review & lock columns on `results`, `enforce_result_locks()` trigger, `result_audit` table, `admin_set_verified`, `admin_set_flag`, `admin_correct_result`, `attendance_sessions`, `attendance`, and `attendance_summary()` RPC.
7. **`07_phase4b_targets_and_weekly_tests.sql`** — Phase 4b: `basics_thresholds` table + category section trigger, `weekly_tests`, `weekly_test_scores`, and `results_with_target` view.
8. **`08_phase4c_0_round_rework.sql`** — Phase 4c-0: simulator series rework (`round_series`, `category_series`, `student_rounds`, `results.student_round_id`, and `start_round()` RPC).
9. **`09_phase4c_2_admin_import_rounds.sql`** — Phase 4c-2: historical CSV import (`category_aliases`, `import_batches`, and `admin_import_rounds()` RPC).
10. **`10_phase5a_competition_and_leaderboard.sql`** — Phase 5a: `profiles.leaderboard_visible`, `competition_settings`, `competition_rules()`, and role-scoped `leaderboard()` RPC.
11. **`11_phase5b_reports_and_milestones.sql`** — Phase 5b: `report_log` table with partial unique cron index, `admin_milestones(p_days)`, `student_month_report(p_student, p_month)`, and service-role-only `weekly_report_data()`.
12. **`12_phase5c_backup_and_health.sql`** — Phase 5c: `admin_schema_health()` verification helper.

---

## Saving a Copy to Google Drive

You can back up all 12 SQL scripts + this `README.md` directly to a folder in your Google Drive from the **Admin Overview** page (`/pages/admin.html`) under the **SQL Migrations & Google Drive Backup** card:
1. Click **Sign in with Google** to connect your Google Drive account.
2. Click **Save SQL Scripts to Google Drive** and confirm the upload dialog.
3. The app creates a folder named `Trendz Tracker SQL Migrations` in your Google Drive and saves all 12 `.sql` files and `README.md` in order.
