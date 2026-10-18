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
| **Shared Modal & Nav**| `/js/modal.js` | Universal accessible modal manager (`openModal`, `closeModal`, Escape key, focus management) and Admin `Setup ▾` dropdown / mobile hamburger (`setupAdminNav`). |
| **Server Admin API**| `/api/*.js` | Serverless Node.js endpoints executing user creation and password resets with service key. |
| **Database DDL** | `/supabase/schema.sql`| PostgreSQL tables, views (`results_with_target`), RPCs, indexes, RLS policies, and triggers. |

