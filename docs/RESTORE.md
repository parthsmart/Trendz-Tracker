# Trendz Tracker — Disaster Recovery & Data Restoration Guide (`docs/RESTORE.md`)

This document provides step-by-step instructions for restoring Trendz Tracker data from either:
1. **Option A: Manual ZIP Archive (`trendz-backup-YYYY-MM-DD.zip`)** — recommended when available because every CSV already contains exact current-state snapshots of all 18 tables.
2. **Option B: Nightly Google Sheet Backup (`BACKUP_SHEET_ID`)** — used when restoring from the automated Google Sheet backup (requires deduplicating the 6 append-mode tables by `id`).

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

## 2. Foreign-Key Safe Restoration Order (All 18 Tables)

Always restore tables in the following dependency order so foreign key constraints are satisfied:

### Tier 1 — Independent & Configuration Tables
1. `profiles` (`id`)
2. `round_series` (`id`)
3. `categories` (`id`)
4. `competition_settings` (`id`)

### Tier 2 — Category & Curriculum Mapping Tables
5. `category_series` (`category_id, series_id`) — depends on `categories`, `round_series`
6. `category_aliases` (`alias`) — depends on `categories`
7. `basics_thresholds` (`category_id, level`) — depends on `categories`, `profiles`
8. `daily_tasks` (`id`) — depends on `profiles`
9. `resources` (`id`) — depends on `profiles`

### Tier 3 — Sessions, Tests & Import Batches
10. `attendance_sessions` (`id`) — depends on `profiles`
11. `weekly_tests` (`id`) — depends on `categories`, `profiles`
12. `import_batches` (`id`) — depends on `profiles`

### Tier 4 — Student Rounds & Practice Records
13. `student_rounds` (`id`) — depends on `profiles`, `round_series`, `import_batches`
14. `results` (`id`) — depends on `profiles`, `categories`, `student_rounds`, `import_batches`
15. `weekly_test_scores` (`id`) — depends on `weekly_tests`, `profiles`
16. `attendance` (`id`) — depends on `attendance_sessions`, `profiles`
17. `activity_results` (`id`) — depends on `profiles`
18. `result_audit` (`id`) — audit log (restore last so triggers during `results` import do not collide)

---

## 3. Option A: Restoring from a Manual ZIP Archive (`trendz-backup-YYYY-MM-DD.zip`)

Each manual ZIP archive downloaded from `/pages/backup.html` contains 18 RFC 4180 CSV files (`<table_name>.csv`) plus `README.txt`. Every CSV represents the exact current table state at export time (no duplicate rows).

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

3. **Import Each CSV in Tier Order (1 → 18)**:
   Using `psql` (connected via your Supabase connection string) or Supabase Studio Table Editor CSV Import:
   ```bash
   \copy public.profiles FROM './restore_csv/profiles.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.round_series FROM './restore_csv/round_series.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.categories FROM './restore_csv/categories.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.competition_settings FROM './restore_csv/competition_settings.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.category_series FROM './restore_csv/category_series.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.category_aliases FROM './restore_csv/category_aliases.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.basics_thresholds FROM './restore_csv/basics_thresholds.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.daily_tasks FROM './restore_csv/daily_tasks.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.resources FROM './restore_csv/resources.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.attendance_sessions FROM './restore_csv/attendance_sessions.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_tests FROM './restore_csv/weekly_tests.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.import_batches FROM './restore_csv/import_batches.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.student_rounds FROM './restore_csv/student_rounds.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.results FROM './restore_csv/results.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.weekly_test_scores FROM './restore_csv/weekly_test_scores.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.attendance FROM './restore_csv/attendance.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.activity_results FROM './restore_csv/activity_results.csv' WITH (FORMAT csv, HEADER true, NULL '');
   \copy public.result_audit FROM './restore_csv/result_audit.csv' WITH (FORMAT csv, HEADER true, NULL '');
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
3. **Spot Check Admin Overview**:
   Sign in as an admin and open `/pages/admin.html` and `/pages/backup.html` to verify student counts, streaks, and recent backup status.
