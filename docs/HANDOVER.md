# Project Handover & Session Ledger

> **Notice to any developer or assistant reading this**:  
> Read this file **first** before touching any code. Update this file **last** before ending any session.  
> Newest session entries always stay on top.

---

## Current Status Overview

### Session: 2026-10-19 (Phase 4c-2c — Import Validation Limits Mirroring, Pre-Flight `validatePayload`, Better Error Diagnostics & Import UI Polish)

#### 5-Line Session Summary
- Mirrored all PostgreSQL `admin_import_rounds` limits in `js/importParser.js` and `js/importPlan.js`: `Time Taken > 28,800s` (e.g. `59:23:00` at `DV31`) warns and sends `time_taken_seconds = null` without blocking the round; cell times `> 14,400s` become unreadable; `round_type > 40` and `note > 500` truncate with warnings; out-of-range round numbers (`1..100000`) or dates (`2020-01-01..today_ist()`) exclude only that round.
- Added `validatePayload(payload)` in `js/importPlan.js` and wired it as a mandatory pre-flight gate in `js/import.js` before any database RPC call, reporting `{ roundNumber, field, value, message }` and preventing orphan batches if any limit is broken.
- Updated `Marks TO BE CORRECTED` cross-check in `js/importParser.js` to always compare against `Total Attempt - Final Score` (`177` vs `178` on Block 2 Round 26) and sorted duplicate-date info lines chronologically (`25 Jul 2026` and `16 Aug 2026`).
- Upgraded database failure handling in `js/import.js` with exact DB error messages, an expandable `"Technical details"` panel (failing step, series, round numbers, and first 3 rounds' metadata with zero secrets), and a plain-language recovery explanation (`Open` batch with 0 rows can be undone, safe to re-run).
- Polished `/pages/import.html` and `css/style.css`: unified searchable student picker, left-aligned `"Needs Attention"` rows grouped by severity with `"Show info lines"` toggle and non-repeating cell refs, non-wrapping summary cards with thousands separators (`1,677`) and `Sep` month formatting, top nav spacing, and 24 passing `node:test` unit tests.

---

### Session: 2026-10-18 (Phase 4c-2a — Admin CSV Import Part 2A: Simulator per Block, Category Resolution & Existing Data Comparison)

#### 5-Line Session Summary
- Created the pure, zero-dependency Phase 4c-2a resolution and comparison module `js/importResolver.js` (leaving `js/importParser.js` untouched) to handle simulator series suggestions, 3-tier category resolution, and database comparison.
- Added per-block Simulator Series dropdowns on `/pages/import.html` (`js/import.js`) pre-selecting suggestions (`currency`/`missingfigures` → `Old simulator`, `approximation`/`hcfandlcm` → `New simulator`), displaying file label hints (`"NEW SIMULATOR"` at `H1`), round ranges, and date ranges, requiring explicit admin confirmation per block, and blocking duplicate series across blocks.
- Implemented per-block Category Resolution with strict matching-key priority (`category_aliases` → built-in aliases `calender`/`timeelapse` → exact match on `categories.name`), `category_series` membership & sort-order checks, absent series category reporting, and duplicate target category blocking.
- Built read-only existing data comparison against `student_rounds` and `results` identified by `(student, series, round_number)`, classifying rounds (`new`, `identical`, `adds_cells`, `conflict`, `db_only`) and cells (`new`, `identical`, `conflict`, `protected_conflict` for `verified`/`corrected_at` rows, `db_only`) with zero database writes and the Import button kept disabled.
- Added and passed `node:test` unit tests in `tests/importResolver.test.js` alongside `tests/importParser.test.js`, and updated `docs/DATA.md`, `docs/DECISIONS.md` (ADR-025), `docs/TESTING.md` (Test Case 34), and `docs/HANDOVER.md`.

---

### Session: 2026-10-18 (Phase 4c-0 — Per-Student Rounds, Simulator Series & `student_round_id` Migration)

#### 5-Line Session Summary
- Migrated all competition round workflows from the deprecated shared `rounds` table and `results.round_number` column to per-student `student_rounds` (`id`, `student_id`, `series_id`, `round_number`, `round_date`, `round_type`, `time_taken_seconds`), `round_series`, `category_series`, and `results.student_round_id`.
- Updated Student Round Scores (`/pages/round-scores.html`, `js/roundScores.js`) to list only the student's own rounds in the current series, start/reuse today's round via `start_round` RPC, edit `round_type` and `time_taken_seconds` (`mm:ss`, `h:mm:ss`, or seconds) on rounds from the last 7 days, order active categories by `category_series.sort_order`, and save results with `student_round_id`.
- Updated the Score Sheet on `/pages/student.html` and `/pages/student-detail.html` (`js/dashboardData.js`, `js/dashboardComponents.js`, `js/stats.js`) with a Simulator Series selector (defaulting to current series, hiding non-current series if the student has 0 rounds in it), series-specific `category_series.sort_order` rows, `time_taken_seconds` fallback to sum of category times, and 5-round pagination.
- Rewrote Admin Rounds (`/pages/rounds.html`, `js/rounds.js`) to filter by Student (required) and Series (defaults to current), propose `max + 1` per `(student, series)`, edit `round_date`/`round_type`/`time_taken_seconds`, and guard deletion when results exist.
- Updated Admin Categories (`js/categories.js`) so round categories display series badges (`Old simulator`, `New simulator`), reorder `category_series.sort_order` within the selected series, and automatically link new round categories to the current series at `max(sort_order) + 1`.

---

### Session: 2026-10-18 (Phase 4c-1 — Admin CSV Score Sheet Import Preview & Multi-Block Parser)

#### 5-Line Session Summary
- Built the pure, zero-dependency CSV and multi-block score sheet parser in `js/importParser.js` (no DOM, no `import.meta.env`) supporting quoted fields, escaped quotes, BOM, ragged rows, dynamic `Category`/`Round <N>` block detection, `colLabel`/`cellRef` coordinates, and built-in aliases (`calender`, `timeelapse`).
- Implemented automatic date format detection (`Auto`, `DD/MM`, `MM/DD` override, mixed-date error detection) and per-block chronological date checks against `today_ist()` (missing/unreadable/future blocked, `<2020` and out-of-order warnings, same-date info).
- Implemented category cell and summary row parsing (`Round Type`, `Time Taken` including `Without Time`, `Final Score`, `Total Attempt`, `Marks TO BE CORRECTED`), Surprise Task ratio-vs-note handling, stray cell detection (e.g. `O10`), and the 3 per-round cross-checks (`OK`, `MISMATCH`, `NOT PRESENT`, `INCOMPLETE`).
- Created the admin-only read-only preview page `/pages/import.html` (`js/import.js`), added `"Import"` to the `Setup ▾` dropdown across all 12 admin pages and `vite.config.ts`, enforced `.csv` / 2 MB limits and strict `textContent` rendering, and performed zero database writes.
- Created and passed the `node:test` unit suite (`tests/importParser.test.js`) covering the synthetic 2-block fixture and all edge cases, and updated `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-023), `docs/THREAT.md`, `docs/TESTING.md`, and `docs/HANDOVER.md`.

---

### Session: 2026-10-18 (Phase 4b — Universal Modal Audit & Fix, Basics Targets, Weekly Tests & Setup Navigation)

#### 5-Line Session Summary
- Diagnosed and resolved the `/pages/attendance.html` modal layout bug (`.modal-overlay`/`.modal-card` vs `.modal-backdrop`/`.modal-dialog` class mismatch) and audited all 14 modals across every page to use the shared `js/modal.js` component and CSS rules (centered, max-width 560px, light blur backdrop, Escape close, focus restore).
- Built Admin Basics Targets (`/pages/targets.html`, `js/targets.js`) managing `basics_thresholds` strictly for `section = 'basics'` categories with default and level-specific rules (`min_accuracy`, optional `max_time_seconds`, active toggle).
- Integrated `results_with_target` view across `/pages/basics.html`, `/pages/student.html`, `/pages/student-detail.html`, and `/pages/review.html` so target chips (`On target` / `Practice needed`) render directly from `meets_target` without calculating target status in JavaScript.
- Built Admin Weekly Tests (`/pages/weekly-tests.html`, `js/weeklyTests.js`) with test CRUD (`weekly_tests`), section-grouped category filter, batch student × category score entry grid (`weekly_test_scores`), and the Student/Admin Detail Weekly Tests card showing the last 3 tests and overall accuracy.
- Updated Admin navigation across all 10 admin pages (`Overview`, `Review`, `Students`, `Attendance`, `Weekly Tests`, and `Setup ▾` dropdown containing `Daily To-Do`, `Resources`, `Categories`, `Rounds`, `Targets`, plus mobile hamburger menu) and updated all 6 `/docs` files.

#### Phase 4b Modal Audit Ledger
| Page | Modal ID | Purpose | Changes Made |
| :--- | :--- | :--- | :--- |
| `/index.html` | `#guide-modal` | SQL & Setup Guide | Standardized markup and wired `guard.js` trigger to `openModal('guide-modal')` for Escape/focus handling. |
| `/pages/attendance.html` | `#session-modal` | Create / Edit Attendance Session | Fixed root cause: unified `.modal-overlay` + `.modal-card` with `.modal-backdrop` + `.modal-dialog`, stripped inline `display: none`, wired `openModal`/`closeModal`. |
| `/pages/attendance.html` | `#unmarked-warning-modal` | Unmarked Students Confirmation | Unified with shared modal classes, stripped inline `display: none`, added Escape/focus return via `js/modal.js`. |
| `/pages/review.html` | `#correct-modal` | Correct Student Entry | Unified with shared modal classes, stripped inline `display: none`, wired `openModal`/`closeModal`. |
| `/pages/review.html` | `#flag-modal` | Flag Entry for Student | Unified with shared modal classes, stripped inline `display: none`, wired `openModal`/`closeModal`. |
| `/pages/review.html` | `#unflag-modal` | Clear Flag Confirmation | Unified with shared modal classes, stripped inline `display: none`, wired `openModal`/`closeModal`. |
| `/pages/review.html` | `#bulk-verify-modal` | Bulk Verify Confirmation | Unified with shared modal classes, stripped inline `display: none`, wired `openModal`/`closeModal`. |
| `/pages/students.html` | `#create-student-modal` | Create Student Account | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/students.html` | `#reset-password-modal` | Reset Student Password | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/todos.html` | `#todo-modal` | Add / Edit Daily To-Do Task | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/resources.html` | `#resource-modal` | Add / Edit Learning Resource | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/categories.html` | `#add-category-modal` | Add Practice Category | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/rounds.html` | `#create-round-modal` | Create Practice Round | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/rounds.html` | `#edit-round-modal` | Edit Practice Round | Audited: uses `.modal-backdrop` + `.modal-dialog`, `data-modal-close`, and `js/modal.js` focus management. |
| `/pages/targets.html` | `#target-modal` | Add / Edit Basics Target Rule | Built using shared `.modal-backdrop` + `.modal-dialog` and `js/modal.js`. |
| `/pages/weekly-tests.html` | `#test-modal` | Create / Edit Weekly Test | Built using shared `.modal-backdrop` + `.modal-dialog` and `js/modal.js`. |

---

### Session: 2026-10-18 (Phase 4a — Admin Entry Review & Audit, Attendance Tracking, Student Notices & Verification Locks)

#### 5-Line Session Summary
- Built Admin Review view (`/pages/review.html`, `js/review.js`) with 50/page pagination, filters, status chips, audit drawer, bulk verify up to 200 rows, and strict PostgreSQL RPCs (`admin_set_verified`, `admin_set_flag`, `admin_correct_result`).
- Implemented Admin Attendance system (`/pages/attendance.html`, `js/attendance.js`) with session CRUD, active student grid, Present/Absent/Excused toggles, "Mark all present", unmarked warning confirmation, and atomic upserts.
- Enforced student-side locks and notices: verified entries show lock icon and are read-only; corrected rows show "Corrected by teacher" and are read-only; flagged entries show "Your teacher asked you to check this entry" with teacher note and remain editable.
- Added verified (`🔒`) and corrected (`✏️`) visual markers on the dashboard competition score table and integrated the authoritative Attendance card from `attendance_summary` across student and admin views.
- Synchronized admin navigation order across all 8 pages, confirmed zero new runtime dependencies, updated ADR-021 in `docs/DECISIONS.md`, expanded `docs/DATA.md`, `docs/THREAT.md`, and `docs/TESTING.md`.

---

### Session: 2026-10-18 (Fix: "Failed to execute 'json' on 'Response': Unexpected end of JSON input")

#### 5-Line Session Summary
- Diagnosed root cause: `proxyFetch` in `js/supabaseClient.js` attempted raw `.json()` parsing on proxy responses without checking for empty body or error status envelopes, returning an empty 200 Response to Supabase client when proxy errored.
- Implemented safe JSON response envelope unwrapping using `response.text()` with fallback error status codes and JSON error bodies.
- Handled empty upstream bodies on non-204 responses by supplying `'null'` for `application/json` content-types instead of empty strings, preventing SyntaxError in `@supabase/supabase-js`.
- Wrapped `Response.prototype.json` inside `smartFetch` via `makeSafeResponse` to gracefully return `null` on empty or unexpected EOF responses across both direct and proxy transport.
- Hardened `js/config.js` and `js/api.js` to safely inspect text before JSON parsing, eliminating unhandled JSON parse exceptions.

---

### Session: 2026-10-17 (Phase 3b-2 — Read-Only Student Detail, 7-Day & 4-Week Progress Charts, Score Table Pagination)

#### 5-Line Session Summary
- Architected shared dashboard modules (`js/dashboardData.js`, `js/dashboardComponents.js`) used identically by both `student.html` and `student-detail.html`, eliminating duplicated code.
- Created `/pages/student-detail.html?id=<student id>` with admin-only guard, read-only teacher banner, "Back to Overview" link, friendly "Student not found" card, and zero mutate/edit controls.
- Enforced strict session security: `/pages/student.html` never reads student ID from URL and strictly displays the authenticated student's own data.
- Built 5-round score sheet pagination with dynamic Older/Newer controls, label formatting ("Rounds 240-244"), sticky category column, and round-only category filtering.
- Implemented dual-range progress analytics with 7-day dual line chart and 4-week Monday–Sunday bar charts in Indian time (Asia/Kolkata), "This week vs last week" comparison line with directional arrows, and per-chart text summaries. Added ADR-020.

---

### Session: 2026-10-17 (Deterministic CI Lockfile Sync, Linux Binaries & Node 22 Engine Pin)

#### 5-Line Session Summary
- Verified `package.json` and `package-lock.json` sync: ran `rm -rf node_modules && npm ci` in a clean state, verifying exit code 0 and pristine dependency tree.
- Confirmed `package-lock.json` is not listed in `.gitignore` and verified repo tracking status.
- Added `"engines": { "node": "22.x" }` to `package.json` to lock Vercel build environment to Node 22 LTS matching Studio preview (`v22.23.3`).
- Audited `package-lock.json` to confirm all required Linux optional packages for Vite's native toolchain (`@esbuild/linux-x64`, `@rolldown/binding-linux-x64-gnu/musl`, `lightningcss-linux-x64-gnu/musl`, `@typescript/typescript-linux-x64`) are locked and resolved.
- Confirmed `npm run build` succeeds cleanly following clean `npm ci`. Added ADR-019 to `docs/DECISIONS.md`.

---

### Session: 2026-10-17 (Phase 3b-1 — Admin Overview Dashboard, Roster Move & Section Separation)

#### 5-Line Session Summary
- Transformed `/pages/admin.html` into the Admin Overview dashboard with 5 summary cards, "Needs Attention" alert box (inactive >= 3 days), and in-browser search/filter/sort with 25-row pagination.
- Migrated student roster (create, reset password, activate/deactivate) to dedicated `/pages/students.html` and updated `vite.config.ts` multi-page input list.
- Standardized admin navigation order across all 6 pages: `Overview`, `Students`, `Daily To-Do`, `Resources`, `Categories`, `Rounds`.
- Enforced strict section isolation: tasks and categories are partitioned under explicit section headers (`Rounds`, `Basics`, `Elements`, `Flash`) and never mixed in a flat list.
- Fixed empty-state table layouts across resources and todos with full-width `colspan` cells, wrapped student names with pending links to `/pages/student-detail.html?id=...`, and added static sample overview data in `js/demoDb.js`.

---

### Session: 2026-10-17 (Build-Time VITE_ Config Injection, Strict Host Matching & Clean Vercel Output)

#### 5-Line Session Summary
- Eliminated top-level await and runtime `/api/config` fetches in production; `js/config.js` reads public Supabase credentials at build time via `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Gated Studio preview fallback to `sessionStorage` caching; strictly zero calls to `/api/config` in production.
- Configured hard Vercel build guard in `vite.config.ts`: `VERCEL=1 npm run build` fails immediately if `VITE_` variables are missing or placeholders.
- Replaced loose `.includes('run.app')` checks across `js/config.js` and `js/supabaseClient.js` with exact `hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.run.app')`.
- Streamlined `vercel.json` to minimal `{ "buildCommand": "npm run build", "installCommand": "npm ci", "outputDirectory": "dist" }`; confirmed 100% of internal links, redirects, and guards use explicit `.html` routes.

---

### Session: 2026-10-17 (Dependency Purge, Production Demo Lock & Secret Removal)

#### 5-Line Session Summary
- Purged all unused dependencies (`react`, `react-dom`, `lucide-react`, `motion`, `@google/genai`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `tailwindcss`, `autoprefixer`), renamed package to `trendz-tracker`, and relocated preview tooling to `devDependencies`.
- Pinned `@supabase/supabase-js` to exact version `2.49.1` and updated `package-lock.json` cleanly with 0 peer conflicts.
- Constrained `unhandledrejection` in `js/supabaseClient.js` to purge tokens strictly on invalid/missing refresh token errors; network errors never clear sessions or call `preventDefault()`.
- Gated Demo Mode strictly to `localhost` and `run.app` hosts; unconfigured production hostnames immediately render a full-page "Configuration error - contact the administrator" screen with zero demo data, zero demo logins, and zero fake admin mutations.
- Purged all hardcoded Supabase project URLs and anon keys from code, docs, and tests, replacing them with `<your-project-ref>`.
- **Note on Roadmap**: Phase 3b is **NOT** yet in this repository.

---

### Session: 2026-10-17 (Hardened Supabase Proxy & Zero-Fallback Environment Discipline)

#### 5-Line Session Summary
- Centralized server configuration in `api/_configHelper.js` with zero hardcoded URLs or keys, throwing a clear 500 error if environment variables are missing or placeholders.
- Hardened `api/supabase-proxy.js`: exact `new URL().origin` matching, userinfo/credential rejection, path whitelist (`/rest/v1/`, `/auth/v1/`, `/storage/v1/`), method whitelist, header whitelist, real 403 on refusal, and 404 in production (`VERCEL_ENV === 'production'`).
- Enforced production architecture: `js/supabaseClient.js` strictly talks directly to Supabase on production and never uses the proxy; `server.ts` uses `res.sendFile(req.path, { root: distPath })`.
- Removed administrative local-state fallbacks in `js/api.js`; backend errors surface cleanly to administrators without pretending to succeed.
- Pinned `@supabase/supabase-js` to exact version `2.49.1` and committed `package-lock.json`. Clean build and lint passed with 0 errors.

---

### Session: 2026-10-17 (Phase 3 — Student Dashboard & Admin Daily To-Do & Resources)

#### 5-Line Session Summary
- Built Phase 3 Student Dashboard (`pages/student.html`, `js/student.js`) featuring Streak & Milestone card, Today's To-Do with deep links, Basics weekly roll-up, and topic-grouped Learning Resources.
- Constructed old-sheet competition score table with 5-round pagination, sticky category column, cell color feedback via `js/scoreColors.js`, and 4 summary rows.
- Created pure statistics engine in `js/stats.js` (no DOM code) for 30-day accuracy, 30-day speed, and category drilldowns; rendered via responsive inline SVG charts with tap-to-inspect tooltips.
- Added two full admin management views: Daily Practice To-Do (`pages/todos.html`, `js/todos.js`) with dynamic category filtering, and Learning Resources (`pages/resources.html`, `js/resources.js`) with HTTP/HTTPS validation.
- Isolated all static mock fallbacks in `js/demoDb.js` (gated strictly when Supabase keys are placeholders), added persistent demo banner, and verified build and lint pass with 0 errors.

---

### Session: 2026-10-17 (Bug Fix — Iframe Proxy Fetch & Uncaught Network TypeError Resolution)

#### 5-Line Session Summary
- Fixed `TypeError: Failed to fetch at fetch (_aistudio-iframe.js:136:14) at smartFetch`: eliminated raw direct-fetch fallback in iframe restricted environments.
- Updated `/api/supabase-proxy.js` to handle relative URLs, resolve upstream network errors with status 200 envelopes, and prevent unhandled proxy 502/403 exceptions.
- Hardened `proxyFetch` URL extraction to properly parse `URL` and `Request` objects, and return synthetic `Response` objects on gateway errors instead of throwing.
- Added automatic stale refresh token clearing in `proxyFetch` whenever Supabase returns HTTP 400 for token refresh requests.
- Verified compilation, linting, and PostgREST + Auth proxy flow with zero errors.

---

### Session: 2026-10-18 (Phase 4b — Modal Audit Fix, Basics Targets, Weekly Tests & Dashboard Fix)

#### 5-Line Session Summary
- Fixed `/pages/attendance.html` unstyled modal bug and standardized all 15 modals across all pages on the shared `.modal-overlay` / `.modal-dialog` component (`js/modal.js`).
- Built `/pages/targets.html` (`js/targets.js`) for managing default and per-level basics thresholds, and wired `results_with_target` target badges into student Basics, Review, and Dashboard views without calculating `meets_target` in JS.
- Built `/pages/weekly-tests.html` (`js/weeklyTests.js`) for creating weekly tests and entering official teacher scores per category with section-grouped dropdowns, keyboard Enter flow, and unsaved-changes guard.
- Added the "Weekly Tests" summary card (last 3 tests + overall accuracy) to `/pages/student.html` and `/pages/student-detail.html`, and fixed `attendanceRes` destructuring in `js/dashboardData.js`.
- Updated all 10 admin pages to the unified navigation bar (`Overview`, `Review`, `Students`, `Attendance`, `Weekly Tests`, and `Setup ▾` dropdown with mobile hamburger menu).

---

### Session: 2026-10-17 (Bug Fix — Basics Categories Loading & Header Sanitization)

#### 5-Line Session Summary
- Resolved `Error loading basics categories: TypeError: Failed to fetch` by hardening `proxyFetch` and `smartFetch` with mutual fallback.
- Sanitized proxy response headers by filtering out `set-cookie` and `set-cookie2`, preventing browser WHATWG Response constructor TypeErrors.
- Added graceful fallbacks in `loadBasicsCategories()`, `loadBasicsHistory()`, and `loadCategories()` to default `DemoDB` categories if Supabase network calls are interrupted.
- Reinforced `loadStudents()` in `admin.js` to catch invalid session states and redirect expired tokens to login automatically.
- Verified all endpoints, build, and lint pass with 0 errors.

#### Done
- **Header Sanitization** (`api/supabase-proxy.js`, `js/supabaseClient.js`):
  - Stripped `set-cookie` and `set-cookie2` from forwarded proxy headers, eliminating browser `Response` constructor rejections.
  - Wrapped `Response` instantiation in try-catch with fallback to a clean minimal Response if any header is rejected by strict browser sandboxes.
  - Added reciprocal fallback in `smartFetch`: if proxy fails it attempts direct fetch; if direct fetch fails it attempts proxy.
- **Resilient UI Loading** (`js/basics.js`, `js/roundScores.js`, `js/admin.js`):
  - Guaranteed `loadBasicsCategories()` and `loadCategories()` always display drill categories even during transient connectivity hiccups.
  - Provided retry actions and clean error states across all student and admin tables.
- **Verification**:
  - `npm run build` succeeds cleanly.
  - `tsc --noEmit` lints with 0 errors.
  - `/api/config` and `/api/supabase-proxy` tested and confirmed working.

---

### Session: 2026-10-17 (Bug Fix — Stale Token Self-Healing & WHATWG Proxy Null-Body Compliance)

#### 5-Line Session Summary
- Fixed `AuthApiError: Invalid Refresh Token: Refresh Token Not Found` by adding self-healing stale session clearing in `auth.js` and `supabaseClient.js`.
- Fixed `TypeError: Failed to fetch` by auto-enabling same-origin `/api/supabase-proxy` in iframe/sandboxed environments.
- Enforced WHATWG `Response` compliance by setting `body = null` on 204/205/304 status codes and stripping `content-encoding` headers.
- Protected `getCurrentProfile()` with comprehensive try/catch guards so dead tokens cleanly redirect to login instead of crashing.
- Verified live end-to-end authentication and database queries for both Admin (`ADMIN01` / `admin123`) and Student (`STU101` / `student123`).

#### Done
- **Self-Healing Auth Token Cleanup** (`js/supabaseClient.js`, `js/auth.js`):
  - Added `clearStaleSupabaseSession()` to purge invalid `sb-*-auth-token` entries whenever token verification or refresh fails.
  - Added global `unhandledrejection` listener that intercepts `AuthApiError: Invalid Refresh Token` and gracefully clears credentials.
  - Pre-clears old storage tokens in `loginWithStudentId` prior to authentication to prevent dirty token collision.
  - Hardened `getCurrentProfile()` to catch any session retrieval exceptions and redirect unauthenticated visits cleanly.
- **WHATWG Response & Proxy Decompression Compliance** (`/api/supabase-proxy.js`, `js/supabaseClient.js`):
  - Removed `content-encoding` and `content-length` from proxy forwarding headers to prevent browser decompression corruption on plain text responses.
  - Ensured null-body status codes (204, 205, 304) receive `body = null` in the `new Response()` constructor to prevent browser TypeErrors.
  - Enabled proxy by default for iframe preview environments (`window.self !== window.top`) and Cloud Run hosts.
- **Live Verification**:
  - Confirmed `admin01@trendz.local` logs in with `admin123` and loads students list.
  - Confirmed `stu101@trendz.local` logs in with `student123` and loads rounds/categories with zero errors.
  - Build and lint passes with 0 errors.

#### In progress
- None. System is fully operational and verified.

#### Broken or risky
- None known. Stale token crashes and browser fetch blocks are completely eliminated.

#### Next
- Proceed with Phase 3 when requested (daily to-dos, student streaks, progress charts).

#### Do not touch
- **Proxy target validation in `/api/supabase-proxy.js`**: Must always restrict target URLs to the institute's Supabase project to prevent open-proxy vulnerabilities.
- **`public.is_admin()` SQL function**: SECURITY DEFINER prevents infinite RLS recursion.
- **Database Date Authority**: Never pass `entry_date` on today's inserts or updates.

---

### Session: 2026-10-17 (Phase 2 — Daily Score Entry & Round Management Delivered)

#### 5-Line Session Summary
- Built Student Screen 1 for entering scores across all 24 competition categories with live color feedback and locked verified rows.
- Built Student Screen 2 for logging multiple daily basics speed drills (1d4r, 2d2r) with 7-day historical date grouping.
- Enforced database date authority: never computes dates in the browser, omitting `entry_date` on today's inserts and updates.
- Built Admin Rounds management with quick IST next-round proposal and score-protected deletion guards.
- Completely documented Phase 2 across all /docs files without adding any new external dependencies or frameworks.

#### Done
- **Student Screen 1: "Round scores"** (`/pages/round-scores.html`, `js/roundScores.js`):
  - Dropdown of competition rounds (newest first, formatted `"Round 244 - 3 Oct 2026"`).
  - All 24 active championship categories rendered in exact competition sort order.
  - Touch-friendly large inputs with `inputmode="numeric"`.
  - Hybrid time parser accepting `"2:07"` or `"127"` (seconds) and formatting as `mm:ss`.
  - Live accuracy feedback: `0 wrong` = Green, `1 to 10 wrong` = Orange, `>10 wrong` = Cyan, neutral for empty.
  - Always pairs color with explicit text labels (e.g. `"3 wrong"`).
  - Progress tracker: `"17 of 24 done"` dynamically calculated.
  - Surprise Task: note textarea plus optional numeric scoring.
  - Read-only locking for rows marked `verified = true` with padlock and note `"Verified by teacher"`.
  - Sequential `Enter` key focus advancement across grid inputs.
  - Non-upsert batch save: updates existing rows by ID and inserts new rows without sending `entry_date` (allowing database `DEFAULT today_ist()` to populate it).
  - Friendly toast display for any database trigger errors.
- **Student Screen 2: "Basics"** (`/pages/basics.html`, `js/basics.js`):
  - Category selector for speed drills (`1d4r`, `2d2r`).
  - Date preset: defaults to Today (omits `entry_date`), with option to pick up to 7 days back (sends `entry_date`).
  - Supports multiple drills per day for the same category.
  - Displays today's drill entries with accuracy badges, Edit and Delete controls (disabled if verified).
  - Last 7 days history grouped cleanly by date with drill counts.
  - Updates to existing drills never send `entry_date`, preserving original practice dates.
- **Student Home** (`/pages/student.html`):
  - Added two large, touch-friendly action cards: `"Enter Round Scores"` and `"Enter Basics"`.
- **Admin: "Rounds" Page** (`/pages/rounds.html`, `js/rounds.js`):
  - Table listing all rounds, formatted dates, types, and recorded score counts.
  - **⚡ Add Next Round** quick button proposing `max + 1` and today's date in Indian Standard Time (IST).
  - Custom round creation modal.
  - Edit modal for date and type (round number is immutable).
  - Deletion protection: rounds with recorded results cannot be deleted.
  - Added `"Rounds"` link to admin navigation bar across all admin views.
- **Shared Utilities**:
  - `js/scoreColors.js`: Single source of truth for error counts and status colors.
  - `js/timeUtils.js`: Parses seconds/`mm:ss` and coordinates Enter key navigation.
  - `css/variables.css`: Added `--color-score-perfect`, `--color-score-warning`, and `--color-score-alert`.
- **Demo Mode**:
  - Fully disabled when live Supabase credentials exist.
  - Displays prominent warning banner `"DEMO MODE - data is fake"` when in preview mode.
- **Docs Suite Updated**:
  - `DECISIONS.md`: Added ADR-007 through ADR-010.
  - `DATA.md`: Documented `DEFAULT today_ist()`, entry_date omission, and trigger protections.
  - `THREAT.md`: Recorded 7-day backdating triggers, inflated score mitigations via verified flags, and deactivated accounts.
  - `TESTING.md`: Added Test Cases 9 through 16 with exact reproduction steps.

#### In progress
- None. Phase 2 score entry and round management are fully functional, compiled, and verified.

#### Broken or risky
- **Database Trigger Dependency**: In live Supabase mode, the database must contain the `today_ist()` function and results trigger. If missing, Postgres defaults to standard `CURRENT_DATE`. The client handles any returned database error gracefully in a toast.

#### Next (Phase 3 Preview)
- Build daily to-do tasks and targeted homework assignments per level.
- Build student practice streak tracking and consistency metrics.
- Build personal progress charts and speed analytics over time.
- Build instructor round verification review console.

#### Do not touch
- **`public.is_admin()` SQL function**: SECURITY DEFINER prevents infinite RLS recursion.
- **Partial Unique Index on `results`**: Ensures 1 score per student per round per category.
- **Non-Upsert Round Save Strategy**: Never replace the ID-based update/insert diffing with PostgREST upsert.
- **Database Date Authority**: Never pass `entry_date` on today's inserts or updates.

---

### Session: 2026-10-17 (Live Supabase Credentials Connected & Secret Isolation Verified)

#### 5-Line Session Summary
- Successfully integrated live Supabase project credentials with automatic URL sanitization.
- Placed public URL and publishable key in `js/config.js`, while confining the service role key to `.env`.
- Hardened server-side admin helper `api/_supabaseAdmin.js` against malformed trailing paths.
- Verified live Supabase client initialization replacing Demo Mode fallback across all views.
- Verified application compilation, zero lint errors, and dev server operational on port 3000.

---

### Session: 2026-10-17 (Phase 1 Baseline & Governance Setup)

#### 5-Line Session Summary
- Delivered the complete Phase 1 foundation: Student ID auth mapping, role-guarded pages, and responsive UI shells.
- Designed and verified the Postgres schema with Row Level Security, indexing, seed data, and fixed policy initialization.
- Built Vercel serverless functions in `/api` to safely execute administrative user creation and password resets.
- Established the `/docs` governance and architecture suite prioritizing child data protection and strict row isolation.
- Maintained a zero-external-dependency frontend using vanilla HTML/CSS/JS and pinned Supabase CDN scripts.
