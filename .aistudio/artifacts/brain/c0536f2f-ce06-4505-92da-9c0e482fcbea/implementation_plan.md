# Trendz Tracker — Phase 5c: Nightly Google Sheet Backup & Full ZIP Export

This plan delivers a two-layer data protection system for Trendz Tracker without adding any external npm packages: (1) an automated nightly and on-demand incremental backup of all 18 database tables to a private Google Sheet using Node's built-in `crypto` and `fetch`, and (2) an in-browser "Download all data (ZIP)" exporter that builds RFC 4180 CSVs and packages them into an uncompressed ("store" method) ZIP archive with a hand-written CRC32 implementation.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **Zero New Dependencies & Strict Security Boundaries**
> - **No new packages**: Google service-account RS256 JWT signing uses Node's built-in `node:crypto`, Google Sheets REST v4 calls use native `fetch`, and ZIP/CSV generation uses pure vanilla JavaScript (`Uint8Array` / `DataView`) in the browser.
> - **Secret isolation**: `GOOGLE_SERVICE_ACCOUNT_JSON` and `BACKUP_SHEET_ID` are read strictly on the server, validated against placeholders, and never logged or returned to the client. Error messages include only the HTTP status code and Google's short message—never tokens, keys, or data rows.
> - **Formula injection protection**: Sheets writes use `valueInputOption: 'RAW'` so cell strings are never evaluated as formulas. Browser CSV exports prefix non-numeric strings starting with `=`, `+`, `-`, or `@` with a single quote (`'`).

- **Confirmed Decision 1 — 8-Second Time Budget & Resumable Passes**: Each backup pass stops cleanly once 8,000 ms have elapsed, recording `status = 'partial'` with `"more to do"` so Vercel serverless functions never time out. The Admin UI loops up to 300 passes with a live progress bar and Cancel button until all tables report caught up (`status = 'done'`).
- **Confirmed Decision 2 — Exact Microsecond Timestamp Preservation**: Keyset paging for append tables (`(cursor_column, id)`) treats Postgres timestamps as opaque strings without passing them through JavaScript `Date` (which truncates microseconds to milliseconds) and URL-encodes `+00:00` offsets in PostgREST `.or()` filters.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Nightly & On-Demand Google Sheet Backup**: Backs up 12 small configuration/reference tables in **snapshot mode** (full rewrite + trailing row cleanup) and 6 high-volume activity tables in **append mode** (incremental keyset paging with a 1-minute safe horizon and dynamic column evolution) into tabs of a private Google Spreadsheet.
  2. **Browser-Side Full Data ZIP Export**: Allows an authenticated teacher/admin to download all 18 tables as individual CSV files plus a `README.txt` inside `trendz-backup-YYYY-MM-DD.zip` (IST date) using their own session, logging completion via `admin_log_export(p_rows, p_tables)`.
  3. **Proactive Backup Health Monitoring**: Surfaces backup staleness warnings on the Admin Backup page (> 2 days old or never run), the Admin Overview banner (> 3 days without a Google backup or manual export, or `"Backup is not set up yet"` if never run), and inside the Weekly Report Email (`Backup` section).
- **Target Audience / Persona**: Institute teachers and administrators who need verifiable off-site recovery against accidental edits, service outages, or project loss without managing cloud CLI tools.
- **Key Value**: Ensures student practice history, attendance, and weekly test scores can be audited in Google Sheets or restored into a fresh Supabase project using only the Supabase Dashboard and SQL Editor.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Inspecting Backup Health (Admin Overview & Setup → Backup)**:
     - On Admin Overview, if neither a completed Google backup (`cron` or `manual` with `status = 'done'`) nor a manual export (`kind = 'export'`) has occurred within the last 3 days, a prominent warning banner appears at the top with a direct link to the Backup page (or `"Backup is not set up yet"` if no backup run has ever been recorded).
     - Navigating to **Setup ▾ → Backup** opens the dedicated Admin Backup console displaying configuration status (`Yes`/`No`), last successful Google backup timestamp (IST), last manual ZIP export timestamp (IST), an **Open backup sheet ↗** link (when configured), and a spreadsheet capacity meter comparing total `cells_written` against Google's 10,000,000-cell limit (highlighting a warning above 70%).
  2. **Running "Back up to Google Sheet now"**:
     - Clicking **Back up to Google Sheet now** calls the backup endpoint in 8-second passes. A live progress bar, pass counter, cumulative rows written, and **Cancel** button update after each pass until the response transitions from `partial` to `done` (or stops immediately on `busy`, user cancellation, or error without auto-retrying errors).
  3. **Running "Download all data (ZIP)"**:
     - Clicking **Download all data (ZIP)** pages through all 18 tables (1,000 rows per page, ordered by primary key) using the admin's authenticated session, displays per-table progress, converts each table to an RFC 4180 CSV with formula-prefix protection, packages them with `README.txt` into `trendz-backup-YYYY-MM-DD.zip`, triggers the browser download, and records the export via `admin_log_export`. If any table read fails, the operation aborts with a clear error message and never downloads an incomplete ZIP.
- **Visual Identity & Theme**:
  - Follows the established Trendz Tracker light utilitarian dashboard aesthetic (`--bg-page`, `--bg-surface`, `--color-primary`, `--color-warning-subtle`, `--color-danger-subtle`).
  - All row counts, cell percentages, and IST timestamps use `font-variant-numeric: tabular-nums` (`.num`) for vertical alignment across data tables.
  - Navigation links in the Setup dropdown on all admin pages include **Backup**.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Nightly Incremental Batch vs. Real-Time Per-Save Mirroring**
  - *Chosen Approach*: Scheduled nightly cron (`30 20 * * *` UTC, ~2:00 AM IST) plus an on-demand multi-pass button in the Admin UI.
  - *Why*: Student round submissions and CSV imports are latency-sensitive and bursty. Synchronous Google Sheets writes on every score save would slow down student practice, hit Google Sheets rate limits (60 requests/min/user), and risk partial failures during class hours.
  - *Alternatives Considered*: Real-time webhook/trigger mirroring to Sheets (rejected due to quota exhaustion during batch imports and added latency on score saves); Supabase logical replication (rejected because it requires paid external infrastructure).

- **Decision 2: Snapshot Mode vs. Append Mode with Keyset Paging & 1-Minute Horizon**
  - *Chosen Approach*:
    - **12 Snapshot Tables** (`profiles`, `round_series`, `categories`, `category_series`, `basics_thresholds`, `daily_tasks`, `resources`, `competition_settings`, `category_aliases`, `attendance_sessions`, `weekly_tests`, `import_batches`): Read in 1,000-row pages (skipping with a warning if > 20,000 rows), written from `A2` in chunks of $\le 5,000$ rows via `values.update`, followed by `values.clear` on any leftover rows below the new dataset so the tab is never transiently blank.
    - **6 Append Tables** (`student_rounds`, `results`, `weekly_test_scores`, `attendance`, `activity_results` using `updated_at`; `result_audit` using `changed_at`): Read in 1,000-row pages ordered by `(cursor_column, id)` where `(cursor > cursor_value OR (cursor = cursor_value AND id > cursor_id))` and `cursor <= now() - interval '1 minute'`.
  - *Why*: Large tables (`results`, `result_audit`) grow to tens of thousands of rows and cannot be rewritten from scratch within serverless time limits or Google Sheets write quotas. Keyset paging on `(cursor_column, id)` prevents skipping or looping when batch imports assign the exact same `updated_at` timestamp to thousands of rows. The 1-minute safe horizon ensures slow or in-flight database transactions with slightly earlier timestamps are never skipped by a advancing cursor.
  - *Alternatives Considered*: `OFFSET`/`LIMIT` pagination (rejected because it degrades at scale and shifts if rows are updated mid-run); timestamp-only cursor without `id` tie-breaker (rejected because bulk imports share a single transaction timestamp).

- **Decision 3: Single-Active-Run Locking & 8-Second Time Budget**
  - *Chosen Approach*: Stale `backup_runs` stuck in `'running'` for $> 3$ minutes are first marked `'failed'` (`reason: "stale"`). A new `'running'` row is inserted, relying on the database partial unique index to reject concurrent runs with `{ busy: true }`. Before every page of work, elapsed time is checked against an `8000` ms budget.
  - *Why*: Prevents overlapping cron and manual runs from duplicating append rows while guaranteeing clean completion before serverless function timeouts.
  - *Alternatives Considered*: Unbounded single-request execution (rejected because initial full backups or large imports would exceed serverless execution limits and fail mid-table).

- **Decision 4: Browser-Side Store-Mode ZIP & Formula-Safe CSV vs. Server-Side Export**
  - *Chosen Approach*: The admin's browser fetches all 18 tables in 1,000-row pages via their authenticated session, formats RFC 4180 CSVs (prefixing non-numeric strings starting with `=`, `+`, `-`, `@` with `'`), computes CRC32 in JS, and assembles a PKZIP "store" (method `0`) archive in memory.
  - *Why*: Avoids serverless memory/response-size ceilings and needs zero third-party ZIP libraries while respecting RLS and recording the audit trail via `admin_log_export`.
  - *Alternatives Considered*: Server-side streaming ZIP endpoint (rejected due to serverless payload size limits and memory pressure on full-database exports).

---

## 4. Technical Architecture & Data Strategy

### Architecture & Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        ADMIN BROWSER (Admin Guard)                           │
│                                                                              │
│  ┌───────────────────────────────┐      ┌─────────────────────────────────┐  │
│  │ Google Sheet Backup Controller│      │ Browser Full ZIP Exporter       │  │
│  │ • Polls status & cell usage   │      │ • Reads 18 tables (1000/page)   │  │
│  │ • Loops 8s passes (max 300)   │      │ • RFC 4180 CSV + formula guard  │  │
│  │ • Progress bar & Cancel btn   │      │ • Store-mode ZIP + CRC32 + log  │  │
│  └───────────────┬───────────────┘      └────────────────┬────────────────┘  │
└──────────────────┼───────────────────────────────────────┼───────────────────┘
                   │ POST {action:'status'|'run'}          │ Authenticated RLS
                   ▼                                       ▼
┌──────────────────────────────────────┐  ┌────────────────────────────────────┐
│     SERVERLESS BACKUP ENGINE         │  │       SUPABASE POSTGRESQL          │
│  • Constant-time CRON_SECRET (GET)   │  │  • 12 Snapshot + 6 Append Tables   │
│  • verifyAdminCaller (POST)          │◄─┼─►• backup_state (cursors, headers) │
│  • Stale lock cleanup (>3m) & lock   │  │  • backup_runs (unique 'running')  │
│  • 8s budget check before each page  │  │  • RPC admin_log_export            │
│  • RS256 JWT (node:crypto) + token   │  └────────────────────────────────────┘
└──────────────────┬───────────────────┘
                   │ HTTPS REST v4 (RAW mode, 1 retry after 2s on 429/5xx)
                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PRIVATE GOOGLE SPREADSHEET                               │
│  • Snapshot Tabs: values.update (<=5000 rows from A2) -> values.clear tail   │
│  • Append Tabs: dynamic header + _backed_up_at -> values.append INSERT_ROWS  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & Table Configuration
- **12 Snapshot Tables** (ordered by primary key, rewritten each run, skipped with warning if $> 20,000$ rows):
  `profiles` (`id`), `round_series` (`id`), `categories` (`id`), `category_series` (`category_id, series_id`), `basics_thresholds` (`category_id`), `daily_tasks` (`id`), `resources` (`id`), `competition_settings` (`id`), `category_aliases` (`alias`), `attendance_sessions` (`id`), `weekly_tests` (`id`), `import_batches` (`id`).
- **6 Append Tables** (ordered by `(cursor_column, id)` with keyset paging and 1-minute safe horizon):
  `student_rounds` (`updated_at`, `id`), `results` (`updated_at`, `id`), `weekly_test_scores` (`updated_at`, `id`), `attendance` (`updated_at`, `id`), `activity_results` (`updated_at`, `id`), `result_audit` (`changed_at`, `id`).
- **Value Serialization Rules (Sheets)**:
  - `null` / `undefined` $\rightarrow$ `""`
  - `boolean` $\rightarrow$ `boolean`
  - `number` $\rightarrow$ `number`
  - `object` / `array` $\rightarrow$ `JSON.stringify(val)`
  - `string` $> 49,000$ chars $\rightarrow$ `str.slice(0, 49000) + " [TRUNCATED]"`
  - Timestamps & dates $\rightarrow$ preserved as exact strings returned by Supabase.

### Interactive Component & State Mapping
- **Backup Status & Capacity View**: Fetches `{ action: 'status' }` on load, rendering configuration badges, staleness warning banner ($> 2$ days or never backed up), cell usage progress bar against `10,000,000` cells ($> 70\%$ warning), per-table status rows (`mode`, `rows_waiting`, `rows_written`, `cells_written`, `last_run_at`, `last_error`), and the last 10 `backup_runs`.
- **Multi-Pass Sheet Backup Runner**: Disables trigger button, reveals progress bar and **Cancel** button, iterates `{ action: 'run' }` up to 300 times while `status === 'partial'`, updates cumulative row counts and table statuses after each pass, and halts cleanly on `done`, `busy`, user cancel, or error.
- **Browser ZIP Exporter**: Iterates through all 18 tables sequentially, updating a per-table progress bar (`Reading table X of 18...`), builds CSVs and `README.txt`, constructs `trendz-backup-YYYY-MM-DD.zip`, triggers download, calls `admin_log_export`, and refreshes the status table. In Demo Mode, generates a deterministic sample ZIP download without touching Google or Supabase.
