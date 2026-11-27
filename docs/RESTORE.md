# Trendz Tracker — Disaster Recovery & Data Restoration Guide (`docs/RESTORE.md`)

This document provides step-by-step instructions for restoring Trendz Tracker data. **Start with section 0 (Full Excel Backup) when you have one**: it covers every table and the login accounts. The older options are:
1. **Option A: Manual ZIP Archive (`trendz-backup-YYYY-MM-DD.zip`)** — recommended when available because every CSV already contains exact current-state snapshots of all 18 tables.
2. **Option B: Nightly Google Sheet Backup (`BACKUP_SHEET_ID`)** — used when restoring from the automated Google Sheet backup (requires deduplicating the 6 append-mode tables by `id`).

---

## 0. Recommended: Restoring from the Full Excel Backup (`trendz-full-backup-YYYY-MM-DD-HHMM.xlsx`)

**Download full backup (Excel)** on `/pages/backup.html` (admin only) saves the whole database in one workbook. Download one regularly and keep it somewhere private.

### What the workbook contains

- **Every table in the `public` schema, every column, every row.** The tables are found automatically from the live database, so a new table is included without code changes. `tests/fullBackup.test.js` fails if a `create table` in the repo is missing from `FULL_BACKUP_KNOWN_TABLES`. The only thing left out is the view `results_with_target`, because it is rebuilt from `results`.
- **Exact values:**
  - IDs and foreign keys are kept as they are.
  - Timestamps are kept to the microsecond, as the original `timestamptz` text.
  - Numbers are kept as their exact text.
  - `jsonb` and array columns are stored as JSON text.
  - An empty cell means NULL. An empty string is stored as an empty text cell.
- **Sheets:**
  - `README` explains the file.
  - `_meta` holds the export time, source project, schema version and format version.
  - `_tables` holds each table's row count, primary key, the tables it depends on, and the restore order.
  - `_columns` holds each column's type and foreign key.
  - `_auth_users` holds the login accounts.
  - Then one sheet per table, in restore order.
- **Limits:**
  - Values longer than 32,000 characters continue in the `_overflow` sheet and are joined back together on restore.
  - Tables larger than one Excel sheet continue in sheets named `table~2`, `table~3` and so on.
- **Excel safety:** every text cell is plain text, so a value like `=SUM()` is never run as a formula.
- **Sensitive data:** `jmcwc_payloads` (Main Round answer keys) is included, so treat the file as confidential.

### Login accounts (`auth.users`)

- **Included:** id, email, phone, role, the confirmed, last-sign-in, created, updated and banned timestamps, `is_anonymous`, `is_sso_user`, `user_metadata`, and `app_metadata`.
- **Never included:** password hashes, tokens, recovery or confirmation codes, MFA factors, or identities. They are removed on the server before the file is built.
- **How logins come back:**
  - `--recreate-auth` (below) recreates every account with its **original id and email**, so `profiles.id` and every foreign key still match.
  - Each recreated account gets a new random temporary password, written only to the CSV you name.
  - Give each student their temporary password, or reset it from the Students page.
  - Passwords can't be recovered from any backup, by design.

### Not included

- **Storage files** in the `lectures` and `recordings` buckets. Their rows (`lectures`, `live_class_recordings`) are in the workbook, but the files themselves are not. Copy the buckets separately from the Supabase dashboard.
- **Database structure** (tables, functions, policies, triggers). Recreate it from `supabase/migrations` (see section 1).
- **Point-in-time consistency:** tables are read one page at a time while the app is running. Export during a quiet period so that rows written mid-export don't leave a child row without its parent.

### Restore procedure

1. Create a new Supabase project and apply every migration in `supabase/migrations` in order.
2. Dry run. This checks the file and prints the restore order; it writes nothing:
   ```powershell
   node scripts/restoreFromBackup.js trendz-full-backup-2026-11-26-1030.xlsx
   ```
3. Recreate the login accounts first, because `profiles.id` references `auth.users`:
   ```powershell
   $env:SUPABASE_URL = "https://<new-project>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY = "<new service role key>"
   node scripts/restoreFromBackup.js trendz-full-backup-2026-11-26-1030.xlsx --recreate-auth --passwords-out temp-passwords.csv
   ```
4. Restore the data. Either:
   - insert it directly with `$env:RESTORE_DATABASE_URL = "postgresql://..."` and `--apply`; or
   - write a script with `--sql-out restore.sql` and run it with `psql -f restore.sql`.

   How the restore runs:
   - It is one transaction, parents first.
   - Each table's user triggers are paused, so audit, streak and notification triggers don't add extra rows.
   - Foreign keys and constraints stay enforced.
   - It refuses to run if any table other than `profiles` already has rows, unless you add `--allow-nonempty`. Profile rows created when logins were recreated are overwritten with the backup's values.
   - If any row fails, nothing is kept.
   - `--only table1,table2` restores just those tables.
5. Check that the row counts printed by `--apply` match the `_tables` sheet. Then go through section 5.
6. Delete `temp-passwords.csv` once every student has their new password.

---

## 1. Prerequisites & Schema Setup

Before importing data rows into a new or reset Supabase project:

1. **Provision Schema & Functions**:
   Run the complete SQL schema in the Supabase SQL Editor:
   - Either execute `supabase/schema.sql`, **or**
   - Execute the ordered scripts in `supabase/migrations/` (`01_phase1_schema.sql` through `12_phase5c_backup_and_health.sql`).
2. **Verify Schema Health**:
   Run `SELECT public.admin_schema_health();` in the SQL Editor and confirm `"ok": true`.
3. **Auth Users (`auth.users`) Note**:
   `public.profiles.id` references `auth.users(id)`.
   - If restoring into the **same** Supabase project, `auth.users` rows already exist.
   - If restoring into a **brand-new** Supabase project, recreate the corresponding `auth.users` records (with matching UUID `id` and synthetic email `<student_code_lowercase>@students.trendz.local` or admin email) via the Supabase Admin Auth API or `auth.users` SQL seed before inserting `public.profiles`.

---

## 2. Foreign-Key Safe Restoration Order (Core + 7 JMCWC Tables)

Always restore tables in the following dependency order (`RESTORE_TABLE_ORDER` in `api/_backupTables.js`) so foreign key constraints are satisfied:

### Tier 1 — Independent & Configuration Tables
1. `profiles` (`id`)
2. `round_series` (`id`)
3. `categories` (`id`)
4. `competition_settings` (`id`)
5. `jmcwc_papers` (`id`) — shared JMCWC paper blueprints

### Tier 2 — Category, Curriculum & JMCWC Group Mapping Tables
6. `category_series` (`category_id, series_id`) — depends on `categories`, `round_series`
7. `category_aliases` (`alias`) — depends on `categories`
8. `basics_thresholds` (`category_id, level`) — depends on `categories`, `profiles`
9. `daily_tasks` (`id`) — depends on `profiles`
10. `resources` (`id`) — depends on `profiles`
11. `jmcwc_categories` (`key`) — depends on `categories(id)` via `legacy_category_id`
12. `jmcwc_assignments` (`student_id`) — depends on `profiles(id)`

### Tier 3 — Sessions, Tests, Import Batches & JMCWC Targets
13. `attendance_sessions` (`id`) — depends on `profiles`
14. `weekly_tests` (`id`) — depends on `categories`, `profiles`
15. `import_batches` (`id`) — depends on `profiles`
16. `jmcwc_targets` (`group_key, category_key`) — depends on `jmcwc_categories(key)`

### Tier 4 — Student Rounds, Practice Records & JMCWC Attempts
17. `student_rounds` (`id`) — depends on `profiles`, `round_series`, `import_batches`
18. `results` (`id`) — depends on `profiles`, `categories`, `student_rounds`, `import_batches`
19. `weekly_test_sections` (`id`) — depends on `weekly_tests`, `categories`
20. `weekly_test_scores` (`id`) — depends on `weekly_tests`, `profiles`
21. `weekly_test_attempts` (`id`) — depends on `weekly_tests`, `profiles`, `categories`
22. `weekly_test_section_removals` (`id`) — depends on `weekly_tests`, `categories`, `profiles`
23. `attendance` (`id`) — depends on `attendance_sessions`, `profiles`
24. `activity_results` (`id`) — depends on `profiles`
25. `jmcwc_attempts` (`id`) — depends on `profiles(id)`, `jmcwc_papers(id)`, `jmcwc_categories(key)`

### Tier 5 — Audit Logs, JMCWC Private Payloads & Graded Scores
26. `result_audit` (`id`) — audit log (restore after `results`)
27. `profile_audit` (`id`) — profile audit log (restore after `profiles`)
28. `jmcwc_payloads` (`attempt_id`) — depends on `jmcwc_attempts(id)` *(Private server backup only — contains question `answer_key` values; never exposed in public backups or Google Sheets mirrors)*
29. `jmcwc_scores` (`attempt_id`) — depends on `jmcwc_attempts(id)`

> **Security & Student Deletion Rules for JMCWC Tables:**
> - **Answer-Key Privacy:** `jmcwc_payloads` contains generated question `answer_key` objects (including for active/paused attempts). It is exported **only** in authenticated private server-side admin backups (`POST /api/backup` with `{ "action": "private_jmcwc_backup" }`) and is strictly excluded from public backups and Google Sheets mirrors (`FORBIDDEN_PUBLIC_OR_MIRROR_TABLES` / `MIRROR_FORBIDDEN_TABLES`).
> - **Student Deletion Scoping:** Deleting a single student previews and removes only that student's `jmcwc_scores`, `jmcwc_payloads`, `jmcwc_attempts`, and `jmcwc_assignments`. Shared institute tables (`jmcwc_papers`, `jmcwc_categories`, `jmcwc_targets`) are **never** deleted when deleting a student.

---

## 3. Option A: Restoring from a Manual ZIP Archive (`trendz-backup-YYYY-MM-DD.zip`)

Each manual ZIP archive downloaded from `/pages/backup.html` contains RFC 4180 CSV files (`<table_name>.csv`) plus `README.txt`. Every CSV represents the exact current table state at export time (no duplicate rows).

### Step-by-Step Procedure

1. **Unzip the Archive**:
   ```bash
   unzip trendz-backup-YYYY-MM-DD.zip -d ./restore_csv
   ```
   Inspect `README.txt` to verify the expected row counts for each table.

2. **Temporarily Disable Triggers During Bulk Import (SQL Editor / `psql`)**:
   To prevent automatic `updated_at` overwrites or duplicate `result_audit` trigger rows while loading historical data:
   ```sql
   SET session_replication_role = 'replica';
   ```

3. **Import Each CSV in Tier Order**:
   Using `psql` (connected via your Supabase connection string) or Supabase Studio Table Editor CSV Import:
   ```bash
   \copy public.profiles FROM './restore_csv/profiles.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.round_series FROM './restore_csv/round_series.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.categories FROM './restore_csv/categories.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.competition_settings FROM './restore_csv/competition_settings.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_papers FROM './restore_csv/jmcwc_papers.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.category_series FROM './restore_csv/category_series.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.category_aliases FROM './restore_csv/category_aliases.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.basics_thresholds FROM './restore_csv/basics_thresholds.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.daily_tasks FROM './restore_csv/daily_tasks.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.resources FROM './restore_csv/resources.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_categories FROM './restore_csv/jmcwc_categories.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_assignments FROM './restore_csv/jmcwc_assignments.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.attendance_sessions FROM './restore_csv/attendance_sessions.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_tests FROM './restore_csv/weekly_tests.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.import_batches FROM './restore_csv/import_batches.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_targets FROM './restore_csv/jmcwc_targets.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.student_rounds FROM './restore_csv/student_rounds.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.results FROM './restore_csv/results.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_test_sections FROM './restore_csv/weekly_test_sections.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_test_scores FROM './restore_csv/weekly_test_scores.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_test_attempts FROM './restore_csv/weekly_test_attempts.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_test_section_removals FROM './restore_csv/weekly_test_section_removals.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.attendance FROM './restore_csv/attendance.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.activity_results FROM './restore_csv/activity_results.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_attempts FROM './restore_csv/jmcwc_attempts.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.result_audit FROM './restore_csv/result_audit.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.profile_audit FROM './restore_csv/profile_audit.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_payloads FROM './restore_csv/jmcwc_payloads.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.jmcwc_scores FROM './restore_csv/jmcwc_scores.csv' WITH (FORMAT csv, HEADER true, NULL '');
   ```

4. **Re-enable Triggers**:
   ```sql
   SET session_replication_role = 'origin';
   ```

---

## 4. Option B: Restoring from the Nightly Google Sheet Backup

The Google Sheet contains:
- **12 Snapshot Tabs** (`profiles`, `round_series`, `categories`, `category_series`, `basics_thresholds`, `daily_tasks`, `resources`, `competition_settings`, `category_aliases`, `attendance_sessions`, `weekly_tests`, `import_batches`): rewritten completely on every run. Export each tab via **File → Download → Comma Separated Values (.csv)** and import directly in Tier order.
- **6 Append Tabs** (`student_rounds`, `results`, `weekly_test_scores`, `attendance`, `activity_results`, `result_audit`): rows are appended whenever inserted or updated, and a table spanning >300,000 rows may be split across `<table_name>`, `<table_name>_2`, etc.

### Deduplicating Append Tabs Before Import

Because updates append a newer version of an existing row to the sheet tab, an append tab can contain multiple rows with the same primary key `id`. Always keep **only the row with the latest `updated_at` (or `changed_at` for `result_audit`)** for each `id`.

#### Option B1 — Deduplicate in SQL via a Staging Table
For any append table (for example, `results`):
```sql
CREATE TEMP TABLE staging_results (LIKE public.results);

-- Load all CSV parts (e.g., results.csv, results_2.csv) into staging_results:
-- \copy staging_results FROM './results.csv' WITH (FORMAT csv, HEADER true, NULL '');

INSERT INTO public.results
SELECT DISTINCT ON (id) *
FROM staging_results
ORDER BY id, updated_at DESC NULLS LAST
ON CONFLICT (id) DO UPDATE SET
  correct = EXCLUDED.correct,
  total = EXCLUDED.total,
  time_seconds = EXCLUDED.time_seconds,
  note = EXCLUDED.note,
  verified = EXCLUDED.verified,
  corrected_at = EXCLUDED.corrected_at,
  corrected_by = EXCLUDED.corrected_by,
  updated_at = EXCLUDED.updated_at;
```

#### Option B2 — Deduplicate in Node.js Using `deduplicateAppendRows`
You can also use the built-in helper in `js/backupExport.js`:
```js
import { deduplicateAppendRows } from './js/backupExport.js';
// Keeps the row with the maximum (cursorColumn, id) for each id
const latestRows = deduplicateAppendRows(rawSheetRows, 'updated_at');
```

---

## 5. Post-Restore Verification Checklist

1. **Row Counts**:
   Compare `SELECT count(*) FROM public.<table_name>;` against `README.txt` (from ZIP) or the `_Runs` / `backup_state` summary.
2. **Schema Health**:
   Run `SELECT public.admin_schema_health();` and confirm `"ok": true`.
3. **Rollout Boundary & Authoritative Policy State (`supabase/owner_phase19_restore_activation.sql`)**:
   `public.rollout_boundaries` stores platform deployment milestones (`feature`, `status`, `activated_at`) and is excluded from user data exports and student mirrors. On a restored database, initial migration sets `status = 'installed'` with `activated_at = NULL`.
   - **Do NOT default to `now()` or guess timestamps**: inventing a timestamp shifts the historical eligibility boundary and can corrupt task credit calculations or incorrectly grandfather scores.
   - Retrieve your saved rollout state from your private deployment records (exported via `supabase/owner_phase19_export_rollout.sql`).
   - If the pre-disaster deployment was `'active'`, set `v_saved_status := 'active'` and `v_saved_activated_at := '<exact_original_timestamp>'` in `supabase/owner_phase19_restore_activation.sql` and run it in the SQL Editor.
   - If the pre-disaster deployment was `'installed'` (unactivated), set `v_saved_status := 'installed'` and `v_saved_activated_at := NULL`. This restores the unactivated state without prematurely enforcing authoritative task credit.
   - If required state is missing, the script aborts immediately with a clear error.
   - Verify that `SELECT feature, status, activated_at FROM public.rollout_boundaries WHERE feature = 'phase19_authoritative_todo';` matches your private record exactly.
4. **Spot Check Admin Overview**:
   Sign in as an admin and open `/pages/admin.html` and `/pages/backup.html` to verify student counts, streaks, and recent backup status.

---

## 6. Private Rollout Boundary State Export & Restoration Procedure

Because `public.rollout_boundaries` tracks deployment infrastructure milestones rather than student records, it must be exported and restored via the private owner procedures:

### Export Procedure (Before Disaster / After Rollout Activation)
1. Run `supabase/owner_phase19_export_rollout.sql` in the Supabase SQL Editor:
   ```sql
   SELECT feature, status, activated_at
   FROM public.rollout_boundaries
   WHERE feature = 'phase19_authoritative_todo';
   ```
2. Or generate a structured JSON audit snapshot:
   ```sql
   SELECT json_build_object(
     'exported_at', now(),
     'feature', feature,
     'status', status,
     'activated_at', activated_at
   ) AS private_rollout_state
   FROM public.rollout_boundaries
   WHERE feature = 'phase19_authoritative_todo';
   ```
3. Securely record the resulting `status` (`'active'` or `'installed'`) and exact `activated_at` timestamp alongside your off-site disaster recovery credentials and backup archives.

### Restore Procedure (During Disaster Recovery Rebuild)
1. Re-run base schema and `supabase/owner_phase19_improvements_migration.sql` to provision tables.
2. Open `supabase/owner_phase19_restore_activation.sql`.
3. Set the required variables in the `DO $$ DECLARE` block:
   - For an active deployment:
     ```sql
     v_saved_status TEXT := 'active';
     v_saved_activated_at TIMESTAMPTZ := '2026-11-07 10:15:30.123456+00'::timestamptz;
     ```
   - For an unactivated deployment:
     ```sql
     v_saved_status TEXT := 'installed';
     v_saved_activated_at TIMESTAMPTZ := NULL;
     ```
4. Execute `supabase/owner_phase19_restore_activation.sql` as database owner (postgres) in the Supabase SQL Editor.
5. If variables are left unset (`v_saved_status := NULL`), the script aborts with error code `22023` to prevent accidental auto-activation or boundary shifting.
6. Verify the restored boundary:
   ```sql
   SELECT feature, status, activated_at
   FROM public.rollout_boundaries
   WHERE feature = 'phase19_authoritative_todo';
   ```

