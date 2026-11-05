# Project Handover & Session Ledger

> **Notice to any developer or assistant reading this**:  
> Read this file **first** before touching any code. Update this file **last** before ending any session.  
> Newest session entries always stay on top.

---

## Current Status Overview

### Session: 2026-11-03 (Phase 17c — JMCWC Round Scores Interface, Online Simulator Runner, Admin JMCWC Panel, Private Backup & Student Deletion)

#### 5-Line Session Summary
- Extracted the pure, zero-dependency save-queue coordinator and keepalive builder into `shared/jmcwcSaveQueue.js` (re-exported by `api/_jmcwcSaveQueue.js`) with zero server imports, and created the browser controller module `js/jmcwcClient.js` (controllable clock `nowMs`, monotonic timer derived from `active_ms`, accessible inputs for all 14 answer types, `localStorage` unsent recovery scoped by `userId + attemptId`, and review/history formatters).
- Integrated **Manual entry** and **Online practice** tabs into `/pages/round-scores.html` and `js/roundScores.js`, displaying the student's non-editable assigned group label (`"Ask your teacher to assign your JMCWC group."` when unassigned), keeping online practice unavailable to students while `published = false` in production, enforcing the 3-unfinished-flat-round cap with resume cards and disabled explanation, providing unrestricted category-wise practice with neutral target comparison, displaying configured targets beside manual category entry times, and adding a combined `Manual` / `Online` round history table without merging weighted JMCWC marks into legacy accuracy, Points leaderboard, or weekly-test scores.
- Built the full JMCWC Runner & Review views on `/pages/round-scores.html` with responsive category/question navigation (no marked-for-review feature), immediate question/input hiding on explicit Pause, `pagehide`/`visibilitychange` (`keepalive: true` with `Authorization: Bearer` header and 48 KB patch fallback), lease loss (`409 LEASE_MISMATCH`), or 2-hour (`7,200,000 ms`) expiry, early/paused submission confirmation, takeover confirmation, and completed review using frozen attempt `max_marks` and `"One valid answer"` when alternatives exist.
- Added the **JMCWC Online Simulator Administration** section to `/pages/rounds.html` (`js/rounds.js`) for student group assignment (surfacing `"Complete this student's unfinished simulator attempts before changing group."` on trigger errors), student deletion JMCWC preview counts, read-only paper/source status (no publication controls exposed), per-group category targets & legacy category mapping, and attempt filters + completed review modal (with no attempt-delete shortcut to bypass the 3-flat-round cap).
- Extended private server backup/restore ordering (`api/_backupTables.js`, `api/backup.js`, `api/_mirror.js`, `docs/RESTORE.md`) for all 7 JMCWC tables while excluding `jmcwc_payloads` (answer keys) from public backups and Google Sheets mirrors, added `admin_get_student_deletion_preview` and `admin_delete_student_jmcwc_data` (`403 ATTEMPT_DELETE_SHORTCUT_FORBIDDEN` unless deleting student account), and added `tests/jmcwcPhase17c.test.js` and updated `tests/backup.test.js`.

#### Verification Status & Production Gate (CRITICAL)
1. **Local Unit & Mocked Controller Checks (Passed)**:
   - `tests/jmcwcPhase17a.test.js`, `tests/jmcwcPhase17b.test.js`, `tests/jmcwcPhase17c.test.js`, and `tests/backup.test.js` pass under `node --test`.
   - Note: Phase 17b and 17c automated tests run against an in-memory contract emulator and controllable-clock controller harness. They **do not** establish actual PostgreSQL transaction locking, advisory lock serialization (`pg_advisory_xact_lock`), trigger execution, or multi-connection concurrency correctness.
2. **Compilation & Bundle Safety Checks (Passed)**:
   - `npm run build` (`vite build`) compiles all HTML/JS entry points cleanly.
   - Verified `shared/jmcwcSaveQueue.js`, `js/jmcwcClient.js`, `js/roundScores.js`, and `js/rounds.js` contain zero imports of server credentials, generators (`_jmcwcGenerate`), or graders (`_jmcwcGrade`), and never reference nonexistent columns such as `last_heartbeat_at`.
3. **Real PostgreSQL / Live API Integration & Concurrency Testing (Pending — Feature Unavailable to Students)**:
   - Live Supabase PostgreSQL integration and concurrency checks are **pending**.
   - All three JMCWC papers (`junior1`, `junior2`, `senior`, `version = '2026.1'`) remain `published = false` in production, keeping online practice unavailable to students until the owner completes the live database integration checklist below.

#### Owner Live PostgreSQL Integration & Concurrency Testing Checklist
Before setting `published = true` on any row in `public.jmcwc_papers`, run the following checks against your staging/deployed Supabase PostgreSQL instance:
1. **Unpublished Paper Gate (`jmcwc_create_attempt`)**: With `published = false`, verify `POST /api/jmcwc` `{ action: 'create', mode: 'flat' }` as an assigned student returns `409 Conflict` (`"Paper is not published for student attempts."`).
2. **Staging Paper Publication & Group Guard (`jmcwc_assignment_guard`)**: In staging (or for a dedicated test paper), set `published = true`, assign a test student to `junior1`, create 1 unfinished flat attempt, then attempt to change the student's group to `junior2` in Admin Rounds -> verify PostgreSQL trigger `jmcwc_assignment_guard()` rejects the update with `"Complete this student's unfinished simulator attempts before changing group."`
3. **Three-Unfinished-Flat-Round Cap**: Start 3 flat attempts for the test student without submitting -> verify the 4th flat `create` call is rejected by `jmcwc_create_attempt` (`"Complete an existing flat round before starting a new one (maximum 3 unfinished flat rounds)."`), while `mode = 'category'` attempts still succeed. Submit 1 flat round -> verify a new flat round can now be created.
4. **Single Running Attempt Constraint (`jmcwc_one_running`) & Lease Rotation**: Resume Flat Round #1 (`status = 'running'`), then resume Flat Round #2 -> verify PostgreSQL `jmcwc_act` atomically pauses Flat Round #1, assigns a new `lease_id` to Flat Round #2, and returns `409 LEASE_MISMATCH` if the old lease from Flat Round #1 attempts a `save`.
5. **Advisory Lock Concurrency & Monotonic `save_seq`**: Send two concurrent `save` requests for the same running attempt (`save_seq = 0` and `save_seq = 1`, plus a duplicate `save_seq = 0`) -> verify `pg_advisory_xact_lock` serializes them without deadlocks and rejects stale `save_seq <= current`.
6. **Server Heartbeat Gap (`> 25,000 ms`) & 2-Hour Active Expiry (`jmcwc_tick`)**: Let a running attempt sit idle for `> 26s` without a heartbeat -> verify `jmcwc_list` / `jmcwc_act` transitions it to `status = 'paused'` without adding the idle gap to `active_ms`. Test `active_ms >= 7,200,000` on a flat attempt -> verify `jmcwc_tick` transitions it to `status = 'grading'` with `submitted_reason = 'time_limit'` and `/api/jmcwc` settles it to `status = 'submitted'` via `jmcwc_finalize`.

---

### Session: 2026-11-03 (Phase 17a & Phase 17b — JMCWC Dynamic Scoring Contract, Pure Generators/Graders, Save Queue & Authenticated Server APIs)

#### 5-Line Session Summary
- Saved the owner's deployed read-only Supabase database snapshot permanently at [`docs/JMCWC_DATABASE_CONTRACT.json`](./JMCWC_DATABASE_CONTRACT.json) (7 tables: `jmcwc_assignments`, `jmcwc_attempts`, `jmcwc_categories`, `jmcwc_papers`, `jmcwc_payloads`, `jmcwc_scores`, `jmcwc_targets`; 9 functions: `jmcwc_act`, `jmcwc_assignment_guard`, `jmcwc_check_student`, `jmcwc_create_attempt`, `jmcwc_finalize`, `jmcwc_list`, `jmcwc_paper_guard`, `jmcwc_tick`, `jmcwc_validate_marks`) and referenced it across project docs (`DATA.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `THREAT.md`, `TESTING.md`, `HANDOVER.md`).
- Completed Phase 17a pure JMCWC modules (`api/_jmcwcMath.js`, `api/_jmcwcBlueprints.js`, `api/_jmcwcGenerate.js`, `api/_jmcwcGrade.js`) and generated `supabase/jmcwc_2026_1_papers.sql` for `junior1`, `junior2`, and `senior` (`version = '2026.1'`, `published = false`, 23 sections each, inserted by owner into Supabase).
- Hardened `api/_jmcwcGrade.js` so non-blank inputs (including punctuation-only strings like `","` or `"x"` in prime factorization) never return `verdict: 'skipped'`, matching `jmcwc_finalize`'s exact PostgreSQL `coalesce(btrim(a.answers->>(q->>'id')), '') = ''` blank check.
- Built the pure client/shared save-queue coordinator `api/_jmcwcSaveQueue.js` (`createJmcwcSaveQueue`, `normalizeAnswerPatchValue`, `sanitizeAnswerPatchObject`) and the authenticated JMCWC server handler `api/_jmcwcServer.js` + `api/jmcwc.js` (mounted at `/api/jmcwc` in `server.ts`) implementing all student actions (`status`, `init`, `list`, `create`, `read`, `resume`, `save`, `heartbeat`, `pause`, `submit`) and admin actions (`admin_get_overview`, `admin_set_assignment`, `admin_set_target`, `admin_set_category_mapping`, `admin_get_papers`, `admin_list_attempts`, `admin_get_attempt_review`) with strict response whitelisting and automatic `status = 'grading' -> 'submitted'` settlement.
- Added comprehensive automated test suites in `tests/jmcwcPhase17a.test.js` and `tests/jmcwcPhase17b.test.js` covering all 13 required lifecycle, authorization, concurrency, lease, sequence, timeout, abandonment, grading-retry, whitelisting, and admin scenarios.

---

### Session: 2026-10-20 (Phase 9b-2 — Mental Multiplications, Mental Square Roots, Step Boxes & Exit Button Fix)

#### 5-Line Session Summary
- Extended `api/_memoriad.js` and `api/memoriad.js` with **Mental Multiplications** (10 questions of two 8-digit numbers, exact `BigInt` 15–16 digit product, 900s limit, `attempted * 5s` plausibility) and **Mental Square Roots** (10 distinct 6-digit non-square integers, exact `BigInt` half-up rounding to 5 decimals `"DDD.DDDDD"`, triangular $k(k+1)/2$ prefix-digit scoring up to 360 points, saving `correct` as fully correct roots and `settings.digits_total`).
- Created the pure, DOM-free step-box state machine `js/stepBoxes.js` supporting both the 16-state cyclic cross-multiplication pattern (`*` or sequential click checks `1..8` boxes from the right then leaves `7..1` on the left before resetting to `0`; `/` ignored) and the 6-box bounded square-root pattern (`*` checks left to right, `/` unchecks right to left).
- Updated `/pages/memoriad-play.html` and `js/memoriadPlay.js` with the Multiplications stage (5×2 overview grid, 8 step boxes highlighting both operand columns, 16 answer slots, disabled `"Side by side (coming later)"` format option) and the Square Roots stage (5×2 overview grid, 6 step boxes above the radicand, 8 answer slots with a fixed decimal point `___ . _____`, and per-question `Correct Digits` + `Points` results table).
- Fixed the competition stage **Exit** button by adding the `.open` visibility class to `#comp-stage-inline-modal` (`modal-backdrop open active`) and wiring backdrop click and `Escape` dismissal.
- Enabled all 4 modules on `/pages/memoriad.html` (`js/memoriad.js`), `js/memoriadCard.js`, `js/memoriadStats.js` (ranking Square Roots by highest `score` then shorter time, and Multiplications by highest `correct` then shorter time), and `js/demoDb.js`, and added unit tests in `tests/stepBoxes.test.js`, `tests/memoriadServer.test.js`, and `tests/memoriadStats.test.js`.

---

### Session: 2026-10-20 (Phase 9b-1 — Memoriad-Style Competition Practice: Shared Desktop Stage, Mental Calendar Dates & Mental Additions)

#### 5-Line Session Summary
- Built the pure server-side module `api/_memoriad.js` (`defaultRng` via `crypto.randomInt`, Gregorian leap-year/weekday helpers, `calendar` generator for 25–125 distinct dates in `1600..2099`, `additions` generator for 10 questions of ten 10-digit numbers summed with `BigInt`, evaluators, and plausibility speed gates) and the serverless endpoint `/api/memoriad.js` (`start` with 60/hr rate limit and 3h expiry stripping expected answers, `submit` computing `used_seconds`, atomic session claim, and `activity_results` insertion via service role).
- Extended `js/competitionKeys.js` with `'unstep'` (`'/'` and `NumpadDivide`) and created five pure, DOM-free client modules: `js/answerSlots.js` (11-slot `'rtl'`/`'ltr'` cursor, backspace, and gap compacting), `js/columnHighlight.js` (1- or 2-column step highlight in `'rtl'`/`'ltr'`), `js/calendarKeys.js` (`dayForKey` mapping `0..7`), `js/memoriadFormat.js` (date and weekday label formatting), and `js/memoriadStats.js` (best score per module, Calendar grouping by date count, last 5 tries, and weekly IST tries).
- Created `/pages/memoriad.html` (`js/memoriad.js`) displaying the 4 competition module cards (`Mental Calendar Dates`, `Mental Additions`, plus `Mental Multiplications` and `Mental Square Roots` marked `"Coming soon"`), personal bests, and last 5 tries in India time.
- Created `/pages/memoriad-play.html` (`js/memoriadPlay.js`) with a `< 1000px` desktop-keyboard guard, persistent `localStorage` settings, hidden-nav Concentration countdown, 1280×800 no-scroll competition stages for Calendar and Additions (with Fullscreen, Exit confirmation, upward timer, and full keyboard shortcuts), and a Results screen with 2-decimal used time, question-by-question review, and `"Try sending again"` network-failure recovery.
- Added the shared dashboard card `js/memoriadCard.js` to `/pages/student.html` and `/pages/student-detail.html` (read-only for admins), added `'memoriad'` to Daily To-Do setup and student checklists, registered both pages in `vite.config.ts` and student navigation bars, added 6 new unit test files (`tests/memoriadServer.test.js`, `tests/answerSlots.test.js`, `tests/columnHighlight.test.js`, `tests/calendarKeys.test.js`, `tests/memoriadFormat.test.js`, `tests/memoriadStats.test.js`), and updated `DECISIONS.md` (ADR-035), `DATA.md`, `THREAT.md`, `TESTING.md`, and `HANDOVER.md`.

---

### Session: 2026-10-20 (Phase 8c — Elements Worksheet Keyboard Shortcuts, Shared Competition Key Module & Active-Question Highlight)

#### 5-Line Session Summary
- Created the pure, DOM-free shared keyboard shortcut module `js/competitionKeys.js` (`keyAction(eventLike)`) mapping `+`/`NumpadAdd` to `'next'`, `-`/`−` (`\u2212`)/`NumpadSubtract` to `'previous'`, and `*`/`NumpadMultiply` to `'step'`, while returning `null` whenever `ctrlKey`, `altKey`, or `metaKey` is active.
- Added unit tests in `tests/competitionKeys.test.js` (`node --test`) verifying numpad keys, standard keys, Unicode minus (`−`), modifier keys (`Ctrl`, `Alt`, `Meta`), and non-matching keys returning `null`.
- Updated `js/elementDrill.js` so pressing `+` moves focus to the next question's input and `-` moves to the previous one (with `preventDefault()` so no character is inserted, and no wrap-around at the first/last question), while ignoring `'step'` (`*`) so Prime Factors drills continue to accept `*`, and keeping `Enter`, `Tab`, and arrow keys intact.
- Added an accessible active-question highlight on `/pages/element-drill.html` (coloured background + thicker border, not colour alone) that smoothly scrolls the focused question into view, controlled by a `"Highlight the active question"` toggle (default ON, persisted in `localStorage` inside `try/catch`).
- Added the one-line hint `"Numpad: + next question, - previous question"` under the timer, added touch-device `Previous` and `Next` buttons next to the timer, and documented the shared module design and test steps in `docs/DECISIONS.md` (ADR-034), `docs/TESTING.md` (Test Cases 48–49), and `docs/HANDOVER.md`.

---

### Session: 2026-10-20 (Phase 9a — Online Basics Practice One Question at a Time, Category-Name Generators & Locked Site Results)

#### 5-Line Session Summary
- Extended `api/_drills.js` with pure category-name-driven Basics question generators (`parseBasicsCategoryName`, `generateBasicsSet`, `stripBasicsExpected`, `checkSubmission`) supporting `<N>d<R>r` ($N \in [1, 4], R \in [2, 10]$, 40% subtraction probability, non-negative running total, no equal adjacent numbers), `<A>dx<B>d` (`1d` factors in $2..9$), and `<A>d/<B>d` (exact $A$-digit dividend with `1d` divisors in $2..9$).
- Extended `POST /api/drill` (`api/drill.js`) with `{ action: 'start', kind: 'basics', category_id, questions }` (validating active Basics category, 60 sets/hr rate limit, 30m expiry, returning `{ session_id, title, questions, target }` without expected answers) and `submit` (minimum speed `questions * 0.6s`, atomic claim, `today_ist()` RPC, inserting `results` with `source = 'site'` and `verified = true`, and linking `drill_sessions.result_row_id`).
- Built the pure one-question-at-a-time player `js/drillPlayer.js` (order, skipping, revisiting skipped items at the end of pass 1, `null` for unanswered, idempotent `finish()`) and pure stats module `js/practiceStats.js` (`bestResult`, `bestByCategoryAndCount`, `setsThisWeek` in IST).
- Created `/pages/basics-practice.html` (`js/basicsPractice.js`, registered in `vite.config.ts`) with setup (5 / 10 / 20 questions, level target, personal best), vertical/horizontal question display with count-up stopwatch, and results review reading `meets_target` from `results_with_target`, plus `"Practice online"` buttons on `/pages/basics.html` and Today's To-Do, and `"Recorded by the site"` (`source = 'site'`, locked) vs `"Typed"` (`source = 'typed'`) chips across Basics, Student Home, `/pages/review.html`, and `/pages/student-detail.html`.
- Added unit tests in `tests/drills.test.js` (300 seeded sets per generator, category name recognition, and `checkSubmission` edge cases), `tests/drillPlayer.test.js`, and `tests/practiceStats.test.js` (all 113 unit tests pass via `node --test tests/*.test.js`), and updated `HANDOVER.md`, `DECISIONS.md` (ADR-033), `DATA.md`, `THREAT.md`, and `TESTING.md`.

---

### Session: 2026-10-19 (Phase 7b — Simplify Flash Anzan to One Question Per Try, Pure Timeline & Per-Settings Stats)

#### 5-Line Session Summary
- Simplified the Flash Anzan trainer (`/pages/flash.html`, `/js/flash.js`) to **one question per try** (`digits` 1–5, `count` 2–1000 with `−`, `+`, `-10`, `+10`, `-100`, `+100` and silent clamping, `speed` 0.2–5.0s, `mode` add/add_sub, beep toggle, expected duration with >5-minute confirmation), and removed `js/flashPresets.js` and the `"questions per set"` setting.
- Built `/js/flashTimeline.js` (`buildTimeline(settings, count)` with `FLASH_BLANK_MS = 80`) to drive the `performance.now()` drift-corrected flash scheduler, a distraction-free progress bar, Stop confirmation, and automatic cancellation on `visibilitychange` (`"You left the page, so this try was cancelled. Start again when you are ready."`).
- Updated the post-flash answer flow to a single digits-only input (up to 10 digits, no minus sign, `inputmode="numeric"`, `Enter` confirms) with **Submit** and **I don't know** (`null`) buttons, retry on RPC failure, and an immediate Result screen (`Correct`/`Wrong`, `Your answer`, `Correct answer`, time, `Try again`, `Change settings`, and collapsed `"Show the numbers"` when `count <= 100`).
- Created `/js/flashStats.js` (`settingsKey`, `statsByKey` ignoring `questions` and `session_id` with `sum(correct)/sum(total)` for legacy row compatibility, `recentTries` for last 20 tries, and `triesThisWeek` in Indian time) and updated the shared Flash Anzan card in `js/dashboardComponents.js` and fixed demo fixtures in `js/demoDb.js`.
- Replaced `tests/flash.test.js` with `tests/flashStats.test.js` and `tests/flashTimeline.test.js` (testing 2, 50, and 1000 numbers) — all unit tests pass via `node --test tests/*.test.js` — and updated `/docs` (`HANDOVER.md`, `DECISIONS.md` ADR-032, `DATA.md`, `THREAT.md`, `TESTING.md`, `ARCHITECTURE.md`).

---

### Session: 2026-10-19 (Phase 8 — Elements Timed Worksheet Drills, Server-Side Generator/Grader & Dashboard Summaries)

#### 5-Line Session Summary
- Built the pure server-side drill engine `/api/_drills.js` defining all 18 timed "Elements" drills (`day_codes`, `month_codes`, `century_codes`, `time_conversion`, `squares_11_50`, `squares_51_100`, `cubes_11_50`, `cubes_51_100`, `divide_by_4`, `divide_by_7`, `prime_factors`, `modulo` disabled with `Coming soon`, `ratio`, `days_to_seconds` with 300s limit, `hours_to_seconds`, `minutes_to_seconds`, `number_to_be_squared`, `squares_3d_4d`) using injectable RNG and exact integer/`BigInt` arithmetic.
- Built the serverless endpoint `/api/drill.js` (and `verifyStudentCaller` in `api/_supabaseAdmin.js`, mounted in `server.ts`) enforcing active-student JWT auth, 60-sets/hour rate limiting on `drill_sessions`, stripping expected answers on `start`, atomic `open -> submitted` locking on `submit`, expiry (`time_limit + 30s`), minimum human speed (`attempted * 0.25s`), and zero-attempt filtering before inserting into `activity_results`.
- Created the browser catalog and pure stats modules (`js/drillCatalog.js`, `js/drillStats.js`) plus the student catalog page `/pages/elements.html` (`js/elements.js`) and responsive timed worksheet page `/pages/element-drill.html` (`js/elementDrill.js`) featuring a 250 ms `performance.now()` countdown bar, `Enter`/`Tab`/`ArrowDown` navigation, network-error retry preservation, and colour + text review breakdown.
- Integrated the shared Elements dashboard card (`js/elementsCard.js`), Personal Bests by Drill table, Recent Elements Sets (last 10) table, daily to-do `'elements'` action links (`Start →` to `/pages/elements.html`), and `"Elements"` top-navigation links across student and admin views (`/pages/student.html`, `/pages/student-detail.html`, `js/dashboardData.js`, `js/dashboardComponents.js`, `vite.config.ts`, `js/demoDb.js`).
- Added 31 new automated test suites in `tests/drills.test.js` (including 200 seeded runs per drill = 3,600 sets, known examples, parser edge cases, and start-payload leak checks) and `tests/drillStats.test.js` (all 93 unit tests across the repo pass via `node --test tests/*.test.js`), and updated `/docs` (`ARCHITECTURE.md`, `DATA.md`, `DECISIONS.md` ADR-031, `THREAT.md`, `CONSTRAINTS.md`, `TESTING.md`, `HANDOVER.md`).

---

### Session: 2026-10-19 (Phase 5c — Nightly Google Sheet Backup, Manual Store ZIP Export & Restoration Guide)

#### 5-Line Session Summary
- Built `/api/_backupTables.js` (single source of truth for all 18 tables: 12 snapshot + 6 append, primary keys, cursor columns, and sheet cell serializers), `/api/_google.js` (zero-dependency Node `crypto` RS256 service-account JWT signer, in-memory token cache, 2s retry on 429/5xx, `valueInputOption=RAW` Sheets REST v4 client, and secret redaction), and `/api/backup.js` (`GET` cron + `POST` admin `status`/`run` with 8s time budget, 3m stale lock recovery, 1m safe horizon, and keyset cursor paging).
- Added the nightly Vercel Cron job `{"path": "/api/backup", "schedule": "30 20 * * *"}` (~2:00 AM IST; runs only on Vercel production) to `vercel.json` and added `GOOGLE_SERVICE_ACCOUNT_JSON` and `BACKUP_SHEET_ID` to `.env.example` and `api/_configHelper.js`.
- Built the pure zero-dependency RFC 4180 CSV & uncompressed PKZIP Store builder in `js/backupExport.js` (IEEE 802.3 CRC32, formula-injection sanitization, 18 CSVs + `README.txt`) and the Admin Backup page `/pages/backup.html` (`js/backup.js`) with multi-pass Google Sheet backup runner, cell capacity bar (warning at 70% of 10M limit), 2-day staleness warning banner (on both `/pages/backup.html` and `/pages/admin.html`), and `Backup` link in the `Setup ▾` menu across all admin pages and `vite.config.ts`.
- Created the beginner-friendly disaster recovery guide `docs/RESTORE.md` covering step-by-step restoration from both the manual ZIP archive and the Google Sheet backup (including deduplicating append tables by `id` keeping latest `updated_at`/`changed_at`).
- Added 16 unit and integration tests in `tests/backup.test.js` (all 54 tests across the repository pass via `node --test tests/*.test.js`), updated `supabase/migrations/12_phase5c_backup_and_health.sql`, and updated `DECISIONS.md` (ADR-030), `TESTING.md`, and `HANDOVER.md`.

---

### Session: 2026-10-19 (Phase 5b — Weekly Report Email, Monthly Student Report & Milestone Alerts)

#### 5-Line Session Summary
- Built `/api/weekly-report.js` and pure email builder `/api/_reportEmail.js` (`buildWeeklyEmail(data)`) sending multipart HTML + plain-text weekly reports via `fetch` to Resend (`POST https://api.resend.com/emails`) with constant-time `CRON_SECRET` auth on `GET`, `verifyAdminCaller` on `POST` (`{ preview: true }` / `{ send: true }`), and idempotent `report_log` tracking.
- Added Vercel Cron configuration (`{"path": "/api/weekly-report", "schedule": "30 15 * * 0"}`, Sunday ~9:00 PM IST; **runs only on the Vercel production deployment**) to `vercel.json` while preserving `buildCommand`, `installCommand`, and `outputDirectory`, and added `RESEND_API_KEY`, `REPORT_TO_EMAIL`, `REPORT_FROM_EMAIL`, and `CRON_SECRET` to `.env.example` and `api/_configHelper.js`.
- Built the Monthly Student Report page (`/pages/monthly-report.html` and `/pages/report.html`, `js/monthlyReport.js`, `js/monthlyReportData.js`) powered by `student_month_report(p_student, p_month)` for both students (own report only) and admins (student selector + month selector), with print-friendly `@media print` layout, Copy Summary, and manual WhatsApp share link.
- Added the Streak Milestones alert card (`admin_milestones(7)` for 25/50/100/200-day streaks with student detail link, Copy Message, and manual WhatsApp link) and the Weekly Report Email panel (Preview modal, Send Report Now, and recent `report_log` history table) to `/pages/admin.html` (`js/adminOverview.js`).
- Added static Phase 5b sample data in `js/demoDb.js`, added unit tests in `tests/reportEmail.test.js`, and updated `HANDOVER.md`, `ARCHITECTURE.md`, `DECISIONS.md` (ADR-029), and `ROLLBACK.md`.

---

### Session: 2026-10-19 (Phase 5a — Points, Student & Admin Leaderboards, Competition Settings & Visibility Controls)

#### 5-Line Session Summary
- Built `/pages/leaderboard.html` (`js/leaderboard.js`, `js/leaderboardData.js`) for both Students (own level only, top 10 + own row below top 10 when outside, `"You"` highlight) and Admins (level filter, up to 200 rows, student detail links, no `"You"` highlight) across 4 boards (`Points`, `Streak`, `Practice days`, `Most improved`) and 3 periods (`This week`, `This month`, `All time`).
- Built the reusable Student Dashboard Leaderboard card module (`js/leaderboardCard.js`) on `/pages/student.html` reusing `leaderboard('points', 'week', null, 3)` to display the student's weekly rank/points (or `"Not on the board yet"`), top 3 names, and link to `/pages/leaderboard.html`.
- Built the Admin Competition Settings page `/pages/competition.html` (`js/competition.html`) under the `Setup ▾` menu to edit `weekly_test_multiplier`, `attendance_present_points`, `improved_min_entries`, and `leaderboard_names` via `UPDATE competition_settings` with numeric validation, friendly DB error messages, and a live sample student name preview (`"Aarav S."` vs `"STU101"`).
- Added the `"Show on leaderboards"` column with toggle and tooltip (`profiles.leaderboard_visible`) to `/pages/students.html` (`js/admin.js`, `js/api.js`) and wired `"Leaderboard"` and `"Competition"` across student/admin navigation bars and `vite.config.ts`.
- Added fixed static sample data for `leaderboard()`, `competition_rules()`, and `competition_settings` in `js/demoDb.js` without re-implementing any scoring/ranking formulas in JavaScript, and updated `HANDOVER.md`, `DECISIONS.md` (ADR-028), `DATA.md`, `THREAT.md`, and `TESTING.md`.

#### Done
- **Data Access & RPC Module** (`js/leaderboardData.js`):
  - Calls `supabase.rpc('leaderboard', { p_board, p_period, p_level, p_limit })` and `supabase.rpc('competition_rules')` exclusively — zero client-side calculation of points, ranks, streaks, or accuracy deltas.
  - Formats board units (`points`, `days`, `days`, `+<x>% accuracy`), builds dynamic `"How it works"` explanations from `competition_rules()` (including `"Only your level is shown."` for students), and supplies encouraging empty-state copy per board/period.
- **Student & Admin Leaderboard Page** (`/pages/leaderboard.html`, `js/leaderboard.js`):
  - Protected by `requireAuth(['student', 'admin'])`.
  - Automatically switches header navigation between student nav and admin nav based on `profile.role`.
  - Tabs: `Points`, `Streak`, `Practice days`, `Most improved`. Period selector (`This week`, `This month`, `All time`) shown for `Points` and `Practice days` and hidden for `Streak` and `Most improved`.
  - Student view: displays top 10 rows for the student's level, highlights `is_me` row with `"You"`, and renders the student's own row separated below the top 10 when `rank > 10`.
  - Admin view: adds a level dropdown (`All levels` or distinct levels from `profiles`), renders up to 200 rows, links each `display_name` to `/pages/student-detail.html?id=<student_id>`, and suppresses the `"You"` highlight.
- **Student Dashboard Leaderboard Card** (`js/leaderboardCard.js`, `/pages/student.html`, `js/student.js`):
  - Modular card calling `fetchLeaderboard({ board: 'points', period: 'week', level: null, limit: 3 })`.
  - Shows caller's weekly rank and points (or `"Not on the board yet"` when absent from returned rows), top 3 names with values, and `"Full leaderboard →"` link.
- **Admin Competition Settings Page** (`/pages/competition.html`, `js/competition.js`):
  - Protected by `requireAuth(['admin'])` and accessible under `Setup ▾ → Competition`.
  - Edits `weekly_test_multiplier`, `attendance_present_points`, `improved_min_entries`, and `leaderboard_names` (`first_name_initial` or `student_code`) with individual **Save** buttons updating `public.competition_settings`.
  - Includes a live sample student preview (`"Aarav Sharma"` / `"STU101"` → `"Aarav S."` vs `"STU101"`).
- **Admin Students Visibility Toggle** (`/pages/students.html`, `js/admin.js`, `js/api.js`):
  - Added `"Show on leaderboards"` column with tooltip explaining that hidden students do not appear on any board, and a toggle button updating `profiles.leaderboard_visible`.
- **Demo Mode Static Fixtures** (`js/demoDb.js`):
  - Added static pre-baked leaderboard rows per board/period, static `competition_rules()` / `competition_settings` storage, and `toggleStudentLeaderboardVisible` filtering without re-implementing SQL scoring rules.

---

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


---

## Phase 10d: Readable Score-Sheet Mirror (`MIRROR_SHEET_ID`) Setup & Handover

### 1. Creating & Sharing the Mirror Spreadsheet
1. In Google Drive / Google Sheets, create a **new blank Google Spreadsheet** (separate from `BACKUP_SHEET_ID`), e.g. named `Trendz Tracker — Score Sheet Mirror (Read-Only)`.
2. Copy the Spreadsheet ID from its URL:
   `https://docs.google.com/spreadsheets/d/<MIRROR_SHEET_ID>/edit`
3. Click **Share** in the top-right corner of Google Sheets and share the spreadsheet with the **exact same service account email** (`client_email` inside `GOOGLE_SERVICE_ACCOUNT_JSON`) with **Editor** permission.
4. Set the optional environment variable `MIRROR_SHEET_ID` in Vercel (and in `.env` for local server runs):
   ```env
   MIRROR_SHEET_ID=your_google_mirror_spreadsheet_id_here
   ```
   - If `MIRROR_SHEET_ID` is not set, the mirror feature is simply off and table backups continue normally with no error.

### 2. How the Score-Sheet Mirror Works
- **Incremental Fingerprint Sync**: After Phase A (12 snapshot tables) and Phase B (6 append tables) in `/api/backup.js`, if time remains in the 8-second budget and `MIRROR_SHEET_ID` is set, the server calls `mirror_fingerprints()` and compares against `public.mirror_state` using `staleStudents(fingerprints, stateRows)` (never-built students first, then oldest `last_built_at` first).
- **Single `batchUpdate` Per Student**: For each stale student, the server calls `mirror_student_data(student_id)`, builds the pure cell grid via `buildStudentTabModel(data)` (`api/_mirror.js`), and sends one `batchUpdate` (`writeMirrorTab` in `api/_google.js`) to create/rename/resize the tab, set frozen rows (`4`) and columns (`3`), clear old values/formats, write all cells (`stringValue` and `numberValue` only, never formulas) with background colours (`#00E000` green, `#FF9900` orange, `#00E5FF` cyan), and set column widths.
- **No Automatic Tab Deletion**: Tabs are never deleted automatically, even when a student is marked inactive.
- **Emergency Outage Plan**: See [`/docs/OUTAGE-PLAN.md`](./OUTAGE-PLAN.md) and the collapsed *"If the website is down"* guide on `/pages/backup.html`.
