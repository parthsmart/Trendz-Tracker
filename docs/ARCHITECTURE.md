# System Architecture & Trust Boundaries

One-page overview of the modules, data flows, and trust boundaries governing **Trendz Tracker**.

---

## 1. System Context Diagram

```text
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                        CLIENT BROWSER (UNTRUSTED REALM)                    │
 │                                                                            │
 │   ┌──────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐ │
 │   │  Login (/index.html) │  │ Student (/pages/...) │  │ Admin (/pages/) │ │
 │   └──────────┬───────────┘  └──────────┬───────────┘  └────────┬────────┘ │
 │              │                         │                       │           │
 │              ▼                         ▼                       ▼           │
 │      [auth.js / guard.js : Route Guards, Session Cache & Student ID Mapping]│
 └──────────────────────┬─────────────────────────────────────────┬───────────┘
                        │                                         │
     [TRUST BOUNDARY 1] │ Anon Key + JWT                          │ [TRUST BOUNDARY 2]
     Client-to-Database │ (Public API)                            │ Bearer JWT
                        ▼                                         ▼
 ┌──────────────────────────────────────┐        ┌────────────────────────────┐
 │      SUPABASE MANAGED CLOUD          │        │  VERCEL SERVERLESS /api    │
 │                                      │        │                            │
 │  - auth.users (ID: stu101@trendz...) │        │  1. verifyAdminCaller()    │
 │  - public.profiles                   │◄───────┤     Inspects JWT caller    │
 │  - public.categories                 │        │     Validates role = admin │
 │  - public.rounds                     │        │  2. /api/create-student.js │
 │  - public.results                    │        │  3. /api/reset-password.js │
 │  - public.daily_tasks                │        │                            │
 │                                      │        │  [Holds Service Role Key]  │
 │  [ENFORCEMENT: Postgres RLS Policies │        └────────────┬───────────────┘
 │   & is_admin() SECURITY DEFINER]     │                     │
 └──────────────────────────────────────┘  [TRUST BOUNDARY 3] │ Service Role Key
                                           Elevated Admin API │ (Private Channel)
                                                              ▼
                                                 [Supabase Admin Auth Engine]
```

---

## 2. Trust Boundaries Explained

### Trust Boundary 1: Browser Client $\longrightarrow$ Supabase Postgres (Public API)
- **What Enters**: Direct database queries from the user's browser using `@supabase/supabase-js`.
- **Trust Level**: **Completely Untrusted**. Anyone can open browser developer tools and issue arbitrary SQL or REST queries using the public `anon` key.
- **Defensive Gate**: **PostgreSQL Row Level Security (RLS)**.
  - The database ignores whatever the user requests in the client JavaScript and enforces row filters based on `auth.uid()`.
  - A student querying `SELECT * FROM results` will only ever receive rows where `student_id = auth.uid()`.
  - The security helper function `is_admin()` executes with `SECURITY DEFINER` to safely inspect the caller's role without recursive loop vulnerabilities.

### Trust Boundary 2: Browser Admin Client $\longrightarrow$ Vercel Serverless Function (`/api/*`)
- **What Enters**: HTTP POST requests to `/api/create-student` and `/api/reset-password`.
- **Trust Level**: **Untrusted External Network Call**. Any visitor or student could forge a POST request to these endpoints.
- **Defensive Gate**: **Server-side JWT Verification (`verifyAdminCaller`)**.
  - The serverless function extracts the `Authorization: Bearer <token>` header.
  - It validates the token with `supabase.auth.getUser(token)`.
  - It verifies in `public.profiles` that the user has `role = 'admin'` and `active = true`.
  - If any check fails, the request is immediately rejected with HTTP 401 or 403 before any action occurs.

### Trust Boundary 3: Vercel Serverless Function $\longrightarrow$ Supabase Auth Admin Engine
- **What Enters**: Administrative API calls (`createUser`, `updateUserById`, `deleteUser`) powered by `SUPABASE_SERVICE_ROLE_KEY`.
- **Trust Level**: **Fully Trusted Internal Backend Channel**.
- **Defensive Gate**:
  - The `SUPABASE_SERVICE_ROLE_KEY` is never exposed outside the secure server runtime.
  - Only vetted, validated payloads from active administrators pass through this channel.

---

## 3. Core Modules & Responsibilities

| Module | Location | Primary Responsibility |
| :--- | :--- | :--- |
| **Login Shell** | `/index.html` | Captures Student ID & password; presents instant testing credentials in Demo Mode. |
| **Auth Service** | `/js/auth.js` | Normalizes `STU101` $\rightarrow$ `stu101@trendz.local`; restores session; handles logout. |
| **Route Guard** | `/js/guard.js` | Enforces client-side access control; redirects students attempting to open admin routes. |
| **Supabase Client**| `/js/supabaseClient.js` | Loads `@supabase/supabase-js@2.49.1` via CDN; falls back to `DemoDB` if keys are unset. |
| **Admin Student UI**| `/js/admin.js` | Renders student table (`/pages/students.html`); coordinates modal creation, password resets, and active toggles. |
| **Admin Overview** | `/js/adminOverview.js` | Renders institute-wide metrics, "Needs Attention" alerts, and 25-row sortable roster via `admin_overview()` RPC. |
| **Admin Review** | `/js/review.js` | Teacher verification queue, bulk verify, score correction modal, flagging, and audit history drawer. |
| **Admin Attendance**| `/js/attendance.js` | Session attendance tracking (`present`, `absent`, `excused`) with bulk status actions and create/edit modal. |
| **Admin Targets** | `/js/targets.js` | Basics speed & accuracy target rules (`basics_thresholds`) with default and level-specific overrides. |
| **Admin Weekly Tests**| `/js/weeklyTests.js` | Weekly test creation, editing, and multi-student multi-category batch score grid (`weekly_tests`, `weekly_test_scores`). |
| **Admin Import Preview**| `/js/import.js` | Read-only CSV score sheet preview UI (`/pages/import.html`): student picker, 2 MB `.csv` validator, triage summary, category mapping, and round cross-check inspector. |
| **CSV Sheet Parser**| `/js/importParser.js`| Pure RFC-4180 CSV & multi-block competition sheet parser with zero DOM/`import.meta.env` dependencies (`node --test` compatible). |
| **Admin Categories**| `/js/categories.js` | Displays 24 championship categories grouped strictly by section; handles reordering and deactivation. |
| **Dashboard Modules**| `/js/dashboardData.js`, `/js/dashboardComponents.js` | Shared data loaders (`results_with_target`, `streak_for`, `todo_for`, `attendance_summary`, `weekly_tests`) and cards for `/pages/student.html` and `/pages/student-detail.html`. |
| **Leaderboards** | `/pages/leaderboard.html`, `/js/leaderboard.js`, `/js/leaderboardData.js` | Student and Admin leaderboards (`points`, `streak`, `practice_days`, `improved`) powered strictly by SQL RPCs `leaderboard()` and `competition_rules()`. |
| **Leaderboard Card** | `/js/leaderboardCard.js` | Reusable student dashboard summary card showing weekly rank, points, and top 3 names via `leaderboard(limit=3)`. |
| **Competition Settings** | `/pages/competition.html`, `/js/competition.js` | Admin management of `competition_settings` (`weekly_test_multiplier`, `attendance_present_points`, `improved_min_entries`, `leaderboard_names`) with live name preview. |
| **Monthly Student Report** | `/pages/monthly-report.html`, `/pages/report.html`, `/js/monthlyReport.js`, `/js/monthlyReportData.js` | Printable monthly student progress report for students (own report) and admins (any student + month picker) via `student_month_report(p_student, p_month)`. |
| **Weekly Report Email Builder** | `/api/_reportEmail.js` | Pure function `buildWeeklyEmail(data)` returning `{ subject, html, text }` with inline CSS, HTML escaping, and zero DOM/network dependencies. |
| **Weekly Report API & Cron** | `/api/weekly-report.js`, `vercel.json` | Scheduled Sunday cron (`30 15 * * 0` UTC, ~9:00 PM IST — **runs only on the Vercel production deployment**) and admin preview/manual send endpoint via Resend REST API (`POST https://api.resend.com/emails`) with `report_log` tracking. |
| **Flash Anzan Trainer** | `/pages/flash.html`, `/js/flash.js`, `/js/flashStats.js`, `/js/flashTimeline.js` | Single-question-per-try Flash Anzan trainer (`2..1000` numbers) powered by SQL RPCs (`flash_start`, `flash_submit`), pure `buildTimeline` drift-corrected scheduler, `visibilitychange` cancellation, Web Audio API beep, and per-settings stats. |
| **Elements Drills Engine** | `/api/_drills.js`, `/api/drill.js`, `/js/drillCatalog.js`, `/js/drillStats.js` | Server-authoritative generator, parser, and grader for the 18 Elements timed worksheet drills (`drill_sessions` $\rightarrow$ `activity_results` with `activity_type = 'element'`). |
| **Elements Student UI** | `/pages/elements.html`, `/pages/element-drill.html`, `/js/elements.js`, `/js/elementDrill.js`, `/js/elementsCard.js` | Grouped 18-drill catalog with personal bests, responsive timed worksheet grid (`performance.now()` 250 ms timer, keyboard navigation, retry on network error), and shared dashboard card. |
| **Shared Modal & Nav**| `/js/modal.js` | Universal accessible modal manager (`openModal`, `closeModal`, Escape key, focus management) and Admin `Setup ▾` dropdown / mobile hamburger (`setupAdminNav`). |
| **Server Admin API**| `/api/*.js` | Serverless Node.js endpoints executing user creation, password resets, weekly report delivery, nightly backups, and Elements drill grading with service role key. |
| **Database DDL** | `/supabase/schema.sql`| PostgreSQL tables, views (`results_with_target`), RPCs, indexes, RLS policies, and triggers. |

