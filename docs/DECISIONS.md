# Architectural & Product Decision Records (ADRs)

Every meaningful technical and architectural decision made for **Trendz Tracker** is documented here.

---

### ADR-001: Plain Vanilla HTML/CSS/JS (ES Modules) over React/SPA Frameworks
- **Date**: 2026-10-17
- **Context**: The institute needs a clean, long-lasting application that is easy for a beginner who understands basic HTML/CSS/JS to inspect, maintain, and modify in future years without dealing with build tool breaking changes or node_modules churn.
- **Options Considered**:
  1. *React 19 / Next.js*: High ecosystem adoption, but requires complex build pipelines, dependency maintenance, and higher mental overhead for non-framework programmers.
  2. *Plain HTML5, CSS Variables, and Vanilla JS ES Modules*: Native browser support, zero build step requirement, runs anywhere, pinned CDN imports for external libraries.
  3. *Lightweight library (Alpine.js or Petite-Vue)*: Smaller than React, but still introduces a DSL abstraction.
- **Choice**: Plain HTML5, CSS custom properties, and vanilla JavaScript ES Modules (`type="module"`).
- **Reason**: Guarantees that code is transparent, debuggable directly in the browser DevTools, and easy for any beginner or future developer to understand and edit without framework lock-in.
- **Trade-off**: Requires writing manual DOM updates and small event wiring logic rather than declarative JSX state bindings.
- **Rejected Options**: React 19, Next.js, Alpine.js.

---

### ADR-002: Student Authentication via Synthetic Email Mapping
- **Date**: 2026-10-17
- **Context**: Young abacus students (children) do not have personal email addresses, nor should the institute collect children's personal emails. However, Supabase Auth natively requires an email address for password-based authentication.
- **Options Considered**:
  1. *Phone number / SMS Auth*: Costly, invasive, and impractical for children without mobile phones.
  2. *Custom table with plaintext/bcrypt passwords*: Bypasses Supabase Auth and loses automatic JWT issuance, Row Level Security session awareness (`auth.uid()`), and security hardening.
  3. *Synthetic Internal Email Mapping (`<student_id>@trendz.local`)*: Students type only their Student ID (e.g. `STU101`) and password. The client code appends `@trendz.local` before contacting Supabase Auth.
- **Choice**: Synthetic Internal Email Mapping.
- **Reason**: Protects children's privacy (no external emails collected or transmitted), preserves full compatibility with Supabase Auth, and allows PostgreSQL Row Level Security policies to seamlessly use `auth.uid()`.
- **Trade-off**: Password reset emails cannot be automatically delivered to students; passwords must be reset manually by teachers/admins through the admin console.
- **Rejected Options**: External emails, custom credential tables, phone SMS verification.

---

### ADR-003: Administrative User Creation via Vercel Serverless Functions
- **Date**: 2026-10-17
- **Context**: Creating new users in Supabase Auth and resetting other users' passwords requires the `service_role` key, which bypasses all Row Level Security. Putting this key in the client browser would allow any user to take full control of the database.
- **Options Considered**:
  1. *Exposing the Service Role Key in `js/config.js`*: Catastrophic security vulnerability; rejected immediately.
  2. *Database Webhook / PostgreSQL Extension*: Complex to debug and difficult to report granular error messages back to the admin UI.
  3. *Dedicated Vercel Serverless Functions (`/api/create-student.js`, `/api/reset-password.js`)*: Reads the `SUPABASE_SERVICE_ROLE_KEY` purely server-side, extracts the caller's JWT, verifies caller is an active admin in `profiles`, and executes the action.
- **Choice**: Dedicated Vercel Serverless Functions.
- **Reason**: Strict isolation of secrets. The browser only ever sees the public `anon` key. The administrative power is gated behind server-verified JWT role validation.
- **Trade-off**: Requires hosting on a platform that supports serverless Node.js endpoints (Vercel) or running the local Express server (`server.ts`).
- **Rejected Options**: Exposing keys to browser, client-side user administration.

---

### ADR-004: Table-First DDL Sequence in SQL Migrations
- **Date**: 2026-10-17
- **Context**: During initial SQL execution, running `DROP POLICY IF EXISTS "policy_name" ON public.profiles;` on a clean Supabase database caused PostgreSQL error `42P01: relation "public.profiles" does not exist`.
- **Options Considered**:
  1. *Wrapping drops in dynamic PL/pgSQL block checking `information_schema.tables`*: Verbose, harder for beginners to read.
  2. *Omitting DROP POLICY statements*: Makes the SQL script non-idempotent; re-running it in development would error with "policy already exists".
  3. *Reordering DDL: `CREATE TABLE IF NOT EXISTS` first, followed by policy drops and policy creates*: Simple, 100% standard SQL, fully idempotent.
- **Choice**: Table-first DDL sequence.
- **Reason**: Once all tables are established, `DROP POLICY IF EXISTS ... ON table_name` will never fail regardless of whether it is a fresh database or an existing one being updated.
- **Trade-off**: None. It is strictly superior and standard PostgreSQL practice.
- **Rejected Options**: Dynamic PL/pgSQL wrappers, non-idempotent scripts.

---

### ADR-005: Soft Deactivation Instead of Hard Deletion for Categories & Students
- **Date**: 2026-10-17
- **Context**: If a teacher removes a category or a student leaves the institute, hard-deleting records (`DELETE FROM categories` or `DELETE FROM profiles`) would orphan or cascade-delete historical competition results, ruining tournament score histories.
- **Options Considered**:
  1. *Hard SQL Deletes with `ON DELETE CASCADE`*: Permanently deletes past scores; dangerous and irreversible.
  2. *Separate Archive Tables*: Adds unnecessary schema complexity and complicates analytical reporting.
  3. *Soft Deactivation (`active = false` flag)*: Records are marked inactive; UI filters them from active selection, but historical scores remain fully preserved.
- **Choice**: Soft Deactivation (`active` boolean flag on both `profiles` and `categories`).
- **Reason**: Protects historical practice records and ensures past competition statistics remain accurate and reproducible.
- **Trade-off**: Queries that want only active items must explicitly include `WHERE active = true`.
- **Rejected Options**: Hard deletes, cascading deletes.

---

### ADR-006: Interactive Local Demo Mode Fallback Restricted to Development Hosts
- **Date**: 2026-10-17 (Updated)
- **Context**: Before a user configures their personal Supabase project, they need to preview, evaluate, and test the UI in development and preview environments without encountering broken screens or blocking crashes. However, demo data and mock accounts must never be exposed or accessible on a live production deployment.
- **Rules & Invariants**:
  1. *Host Restriction*: Demo Mode is strictly permitted only on `localhost`, `127.0.0.1`, or `run.app` (Studio preview).
  2. *Production Configuration Lock*: On any production hostname, if Supabase credentials are missing or placeholders, the application immediately blocks execution and displays a full-page "Configuration error - contact the administrator" screen. No demo data is loaded, demo logins are rejected, and admin mutations cannot fake success.
  3. *Visible Indicator*: Where demo mode is permitted, a prominent yellow banner `"DEMO MODE — data is fake"` is persistently rendered.
- **Choice**: Host-restricted Interactive Demo Mode Fallback.
- **Reason**: Allows seamless local evaluation while guaranteeing zero fake data or mock credential exposure in production.

---

### ADR-007: Database Date Authority (`today_ist()`) & Omitting `entry_date`
- **Date**: 2026-10-17
- **Context**: Students access the web portal from varying devices whose clocks may be desynchronized or intentionally altered. The competition requires standardized Indian Standard Time (IST) dates, enforced via a database default `today_ist()` and a 7-day backdating trigger.
- **Options Considered**:
  1. *Generating timestamps in the browser via JavaScript `new Date()`*: Unreliable, easily spoofed, and prone to local timezone mismatches.
  2. *Fetching current server time via an extra HTTP roundtrip before every save*: Adds latency and fails offline.
  3. *Omitting `entry_date` on today's inserts and all updates*: For current-day submissions, the browser omits `entry_date` so Postgres automatically assigns `DEFAULT today_ist()`. Only when an earlier date is explicitly chosen (Basics drills) is `entry_date` sent. Updates never send `entry_date`, preserving original entry dates.
- **Choice**: Omitting `entry_date` on current inserts and updates; trusting database default.
- **Reason**: Guarantees date accuracy regardless of client machine settings and simplifies payload construction.
- **Trade-off**: The client cannot preview the exact assigned `entry_date` until re-fetching or querying after insert.
- **Rejected Options**: Client-side date generation, pre-flight timestamp RPCs.

---

### ADR-008: Non-Upsert Diffing for Round Score Batch Saves
- **Date**: 2026-10-17
- **Context**: The `results` table enforces uniqueness via a partial index `(student_id, round_number, category_id) WHERE round_number IS NOT NULL`. Supabase PostgREST's `upsert` API with `onConflict` does not natively support partial unique index constraints and frequently errors with duplicate key violations.
- **Options Considered**:
  1. *PostgREST upsert with `onConflict: 'student_id,round_number,category_id'`*: Triggers Postgres error because the unique constraint only exists conditionally where `round_number IS NOT NULL`.
  2. *Custom PostgreSQL stored procedure for bulk upsert*: Adds server-side PL/pgSQL maintenance overhead.
  3. *Client-side diffing and direct ID update*: Client loads existing results on round selection. When saving, existing rows are updated by primary key `id`, while newly attempted categories are inserted without `entry_date`. Empty categories are skipped.
- **Choice**: Client-side diffing with direct ID updates and targeted inserts.
- **Reason**: 100% reliable, works across all PostgreSQL versions, avoids partial-index upsert bugs, and skips unattempted categories.
- **Trade-off**: Requires two queries (one update loop, one insert batch) instead of a single bulk upsert call.
- **Rejected Options**: PostgREST partial upsert, custom PL/pgSQL bulk RPC.

---

### ADR-009: Shared Accuracy Feedback Function with Dual Text Signal
- **Date**: 2026-10-17
- **Context**: Abacus students need instant feedback on errors while typing scores, but accessibility (WCAG AA) requires that color is never the only signal.
- **Options Considered**:
  1. *Percentage calculation badges*: In mental calculation championships, raw penalty count (wrong answers) is the decisive metric, not percentage.
  2. *Color-only borders or status dots*: Inaccessible to color-blind children and ambiguous.
  3. *Shared function `getScoreFeedback` with explicit text and 3 color states*: Green for 0 wrong (and total > 0), Orange for 1 to 10 wrong, Cyan for >10 wrong, and explicit textual labels (e.g. `"3 wrong"`, `"0 wrong"`).
- **Choice**: Shared function `getScoreFeedback(correct, total)` in `js/scoreColors.js`.
- **Reason**: Centralizes calculation logic for both Round scores and Basics speed drills while guaranteeing accessible dual signaling (color + text).
- **Trade-off**: Slight CSS overhead for distinct color classes.
- **Rejected Options**: Percentage-only badges, color-only borders.

---

### ADR-010: Hybrid Time Parsing (`mm:ss` or seconds) & Enter Key Workflow
- **Date**: 2026-10-17
- **Context**: Young students entering 24 categories in a practice session find splitting minutes and seconds into separate input fields cumbersome. Mobile touch keypads are also prone to input friction.
- **Options Considered**:
  1. *Separate Minutes and Seconds input fields*: Doubles the number of fields to 48, slowing down data entry.
  2. *Strict regex requiring `:` separator*: Frustrates students who type `127` seconds from stopwatches.
  3. *Hybrid parser (`timeUtils.js`)*: Accepts either `"2:07"` or `"127"` (seconds), formats to `mm:ss` on blur, sets `inputmode="numeric"`, and advances focus to the next input upon pressing `Enter`.
- **Choice**: Hybrid parser with sequential Enter key advancement.
- **Reason**: Dramatically accelerates score entry for students on both desktop keyboards and mobile number pads.
- **Trade-off**: Must handle edge cases (e.g. seconds $\ge 60$ in `m:ss` strings).
- **Rejected Options**: Dual minute/second inputs, strict time-picker popups.

---

### ADR-011: Hardened Preview-Only Supabase Reverse Proxy with Strict Destination Invariants
- **Date**: 2026-10-17 (Updated)
- **Context**: In restrictive browser preview environments (such as sandboxed iframes in AI Studio / Cloud Run), direct cross-origin fetches to external third-party domains (`*.supabase.co`) can fail with `TypeError: Failed to fetch`. However, an unrestricted backend proxy poses serious SSRF (Server-Side Request Forgery) and open-proxy risks if not strictly constrained.
- **Rules & Invariants**:
  1. *Preview Only*: The proxy is strictly for preview environments. When `VERCEL_ENV === 'production'`, `/api/supabase-proxy` immediately returns HTTP 404. Client-side code in `js/supabaseClient.js` detects production environments and never attempts to use the proxy, communicating directly with Supabase via standard `fetch()`.
  2. *Strict Origin Validation*: The target is parsed using `new URL()`. The protocol must be `https:`, and `targetUrl.origin` must strictly and exactly match the origin of the configured `SUPABASE_URL`. Subdomain tricks (e.g. `.evil.example`) and embedded credentials (`user@evil.example`) are explicitly rejected with real HTTP 403.
  3. *Path Restriction*: Only paths starting with `/rest/v1/`, `/auth/v1/`, and `/storage/v1/` are allowed. All other paths are rejected with HTTP 403.
  4. *Method Whitelist*: Only `GET`, `POST`, `PATCH`, `PUT`, and `DELETE` are permitted.
  5. *Header Filtering*: Only explicitly allowed headers are forwarded: `apikey`, `authorization`, `content-type`, `accept`, `prefer`, `x-client-info`. All other headers (including cookies, hop-by-hop headers, and host headers) are stripped.
  6. *Centralized Environment Resolution*: All server endpoints read Supabase configuration through `api/_configHelper.js`. If variables are missing or placeholders, a 500 error is returned with zero hardcoded fallbacks.
- **Choice**: Hardened preview-only reverse proxy with strict origin parsing and zero production presence.
- **Reason**: Eliminates SSRF risks, prevents open-proxy abuse, and ensures production deployments connect 100% directly to Supabase.
- **Trade-off**: Requires maintaining strict validation logic in `/api/supabase-proxy.js`.
- **Rejected Options**: Unrestricted forwarding, prefix-only string matching (`startsWith`), proxying in production.

---

### ADR-012: Self-Healing Stale Session Recovery & WHATWG Null-Body Response Compliance
- **Date**: 2026-10-17
- **Context**: When a database or Supabase Auth project has its users recreated or tokens revoked, client browsers with stale JWT tokens in `localStorage` throw unhandled `AuthApiError: Invalid Refresh Token: Refresh Token Not Found`. Without proactive recovery, this traps the browser in an unrecoverable crash loop on every page refresh. Additionally, proxied Supabase responses with HTTP 204/205/304 status codes threw browser TypeErrors if a body string was passed to the WHATWG `Response` constructor.
- **Options Considered**:
  1. *Manual cache clearing*: Instructing non-technical teachers and children to open DevTools and clear Application storage. Unacceptable user experience.
  2. *Naive page reload*: Causes an infinite reload loop if the stored token remains invalid in localStorage.
  3. *Self-Healing Storage Recovery + Spec-Compliant Null Body Handling*:
     - Catch `AuthApiError` and `Refresh Token Not Found` in both `getCurrentProfile()` and a global `unhandledrejection` listener.
     - Automatically purge stale `sb-*-auth-token` keys via `clearStaleSupabaseSession()`.
     - Gracefully redirect unauthenticated sessions to `/index.html`.
     - In the proxy `new Response()` construction, explicitly enforce `body = null` for HTTP status 204, 205, and 304, and strip `content-encoding` and `content-length` from proxy forwarding headers to prevent double-decompression failures.
- **Choice**: Self-Healing Storage Recovery with WHATWG Null-Body Compliance (`js/supabaseClient.js`, `js/auth.js`, `/api/supabase-proxy.js`).
- **Reason**: 100% automatic recovery from stale tokens without manual user intervention, preventing app crashes and infinite reload loops.
- **Trade-off**: Stale sessions are logged out and must re-enter credentials (which is expected after a token revocation).
- **Rejected Options**: Manual localStorage clearing, silent ignore without storage cleanup.

---

### ADR-013: Database-Authoritative Streak & To-Do Evaluation (`streak_for`, `todo_for`, `today_ist`)
- **Date**: 2026-10-17
- **Context**: Daily practice streaks, freeze shields, and daily task completion require rigorous calendar continuity. If calculated in client-side JavaScript, differences in client device system clocks, timezone shifting (e.g. students rolling back device time to save broken streaks), and client code tampering can compromise competitive integrity.
- **Options Considered**:
  1. *Client-side calculation*: Fetching all historical results and calculating streaks and daily to-dos in JavaScript. Vulnerable to device clock tampering, consumes excessive client bandwidth, and duplicates business logic.
  2. *Hybrid calculation*: Client calculating to-do status, database calculating streaks. Disjointed and prone to edge-case bugs.
  3. *Pure Database-Authoritative RPCs*: Call PostgreSQL stored procedures `streak_for(p_student uuid)` and `todo_for(p_student uuid)`, with `today_ist()` providing an authoritative Indian Standard Time (`Asia/Kolkata`) reference point once per page load.
- **Choice**: Pure Database-Authoritative RPCs.
- **Reason**: Guarantees zero clock drift, eliminates client timezone cheating, minimizes client network bandwidth, and keeps business logic authoritative in SQL.
- **Trade-off**: Requires database migration with PL/pgSQL functions.
- **Rejected Options**: Client-side streak counting, browser local date tracking.

---

### ADR-014: Handcrafted Inline SVG Charts over External Chart Libraries
- **Date**: 2026-10-17
- **Context**: The student dashboard requires visual progress trends for 30-day accuracy, 30-day speed (questions/minute), and category history drilldowns.
- **Options Considered**:
  1. *Chart.js / ApexCharts / Recharts*: Heavy third-party dependencies (150KB–300KB), canvas rasterization blur on high-DPI screens, and vulnerability to future breaking changes or npm supply-chain issues.
  2. *CSS Bar Charts*: Limited expressiveness for continuous date lines and area trends.
  3. *Handcrafted Inline SVG (`<svg viewBox="0 0 W H">`)*: Zero external dependencies, razor-sharp vector rendering on all screen sizes, perfect synchronization with CSS design tokens, and built-in accessibility (`<title>`, tabindex data dots, tap-to-inspect tooltips).
- **Choice**: Handcrafted Inline SVG.
- **Reason**: Comply with zero-dependency mandate, load instantly with zero bundle bloat, render crisply on Retina displays, and allow full UI control without library constraints.
- **Trade-off**: Requires manual math calculations for coordinate mapping, polylines, and grid ticks in `js/student.js` and `js/stats.js`.
- **Rejected Options**: Chart.js, Recharts, D3.

---

### ADR-015: Complete Demo DB Isolation in `js/demoDb.js`
- **Date**: 2026-10-17
- **Context**: During prototyping and unconfigured state, the application must provide high-fidelity demo data (fixed streak of 8, 1 shield used, 4 of 7 to-dos done, sample resources, 5 sample rounds) without polluting production logic or allowing demo mutations to be mistaken for real database state.
- **Options Considered**:
  1. *Inline mock branches throughout student.js, admin.js, and supabaseClient.js*: Hard to audit and risks leaving demo remnants in production code.
  2. *Separate Demo build / branch*: Disconnected and difficult to maintain.
  3. *Single Isolated File (`js/demoDb.js`)*: All static fake data, mock RPCs, and local demo storage are gathered strictly in `js/demoDb.js`. Enabled ONLY when Supabase credentials are placeholder strings AND on permitted preview hosts (`localhost`, `run.app`); completely unreachable once live credentials are entered or when deployed on production hostnames.
- **Choice**: Single Isolated File (`js/demoDb.js`).
- **Reason**: Safe, clean, and easily deletable prior to production launch. Accompanied by a bold banner `"DEMO MODE — data is fake"` on allowed development pages.
- **Trade-off**: Must maintain matching mock data structures during development.
- **Rejected Options**: Scattering mock branches across production modules.

---

### ADR-016: Build-Time `VITE_` Configuration over Runtime Config Fetching
- **Date**: 2026-10-17
- **Context**: In production on Vercel, Trendz Tracker serves static pages from `dist` alongside administrative serverless functions. Fetching public Supabase credentials via a runtime network request to `/api/config` introduced top-level await latency, triggered unnecessary serverless function executions on every client visit, and created potential race conditions before `getSupabase()` or route guards executed.
- **Options Considered**:
  1. *Runtime `/api/config` fetch with top-level await*: Slows client module evaluation, causes serverless cold starts on static page visits, and introduces unnecessary network round-trips.
  2. *Hardcoded public project credentials in `js/config.js`*: Violates clean environment separation and risks committing credentials to source control.
  3. *Build-Time `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` Injection*: Standard Vite environment variables (`import.meta.env.VITE_*`) replaced at compile time during `npm run build`. The browser makes zero network requests to `/api/config` in production. Studio preview (`localhost`, `127.0.0.1`, `*.run.app`) retains a single cached fallback via `sessionStorage` if build variables are unset.
- **Choice**: Build-Time `VITE_` Configuration Injection with Vercel Build-Failure Guard.
- **Reason**: Eliminates top-level await from client bundles, enables instantaneous client initialization without network latency, ensures zero runtime calls to `/api/config` in production, and provides fail-fast build validation in `vite.config.ts` when deploying on Vercel. `SUPABASE_SERVICE_ROLE_KEY` strictly retains its non-VITE name and remains purely server-side.
- **Trade-off**: Vercel production deployments require `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` defined in Vercel Environment Variables.
- **Rejected Options**: Runtime `/api/config` fetch in production, hardcoded secrets in source files.

---

### ADR-017: Admin Navigation Architecture & Dedicated Student Roster
- **Date**: 2026-10-17
- **Context**: As the admin console expanded to encompass institute monitoring, practice to-dos, and learning resources, keeping the student CRUD roster on `/pages/admin.html` prevented teachers from seeing high-level practice health upon login.
- **Options Considered**:
  1. *Leave student roster on `admin.html` and add `overview.html`*: Requires updating all admin login redirects and confuses users expecting `admin.html` to be the primary command center.
  2. *Tabbed single-page admin container*: Increases client script complexity and complicates deep-linking.
  3. *Overview on `pages/admin.html` and Roster on `pages/students.html`*: Preserves the existing `/pages/admin.html` login redirect, establishes a clear 6-item navigation hierarchy (`Overview`, `Students`, `Daily To-Do`, `Resources`, `Categories`, `Rounds`), and maintains clean multi-page isolation.
- **Choice**: Overview on `pages/admin.html`, Student Roster on `pages/students.html`.
- **Reason**: Allows administrators to immediately inspect student activity, streaks, and attention warnings upon login, while preserving existing route security and keeping student CRUD isolated in `pages/students.html`.
- **Trade-off**: Added `pages/students.html` to Vite's multi-page input bundle.
- **Rejected Options**: Splitting admin into tabs, redirecting login away from `admin.html`.

---

### ADR-018: Strict Section Isolation Across Competition Categories and Daily Tasks
- **Date**: 2026-10-17
- **Context**: Junior Mental Calculation World Championship preparation involves multiple distinct disciplines: 24 Competition Rounds, Speed Basics (1d4r, 2d2r), Elements, and Flash Anzan. Combining these into a single sorted list caused confusion and misassigned tasks.
- **Options Considered**:
  1. *Flat list sorted alphabetically with section badges*: Overwhelms teachers and mixes distinct tracks.
  2. *Separate pages for each section*: Fragmented experience requiring 4 extra pages.
  3. *Grouped Section Partitioning with Localized Sorting*: Categories and daily tasks are strictly grouped under explicit section dividers (`Competition Rounds`, `Basics Speed Drills`, `Elements`, `Flash Anzan`), sorting items strictly within each section.
- **Choice**: Grouped Section Partitioning with Localized Sorting.
- **Reason**: Preserves clear domain boundaries between official championship rounds and supplementary mental drills while maintaining efficient single-table management.
- **Trade-off**: Requires grouping logic in table rendering.
- **Rejected Options**: Single flat combined sorting.

---

### ADR-019: Deterministic CI Builds via `npm ci` and Committed `package-lock.json`
- **Date**: 2026-10-17
- **Context**: Vercel production deployments use `installCommand: "npm ci"` to install dependencies from `package-lock.json` in a clean, non-mutating manner. When `package.json` and `package-lock.json` drift out of sync, or when optional native binaries needed by Vite's Linux build runner (such as `@esbuild/linux-x64`, `@rolldown/binding-linux-x64-gnu/musl`, or `lightningcss-linux-x64-gnu/musl`) are absent, `npm ci` fails fast to prevent deploying non-reproducible or broken bundles.
- **Options Considered**:
  1. *Loose `npm install` on CI*: Overwrites the lockfile at deploy time, allows version drift, installs unexpected transitive minor/patch updates, and risks silent breakage.
  2. *Excluding `package-lock.json` from git*: Prevents reproducible builds across developer workstations, Studio preview, and Vercel.
  3. *Committed `package-lock.json` with `npm ci` and Explicit Node Engine*: Keeps `package-lock.json` strictly tracked in version control, ensures bit-for-bit identical dependency trees across environments, verifies the lockfile contains required Linux native toolchain bindings, and enforces Node.js version parity via `"engines": { "node": "22.x" }`.
- **Choice**: Committed `package-lock.json` with `npm ci` and `"engines": { "node": "22.x" }`.
- **Reason**: Guarantees zero dependency drift between local/Studio preview and Vercel production, fails immediately if any dependency in `package.json` is modified without synchronizing the lockfile, guarantees presence of Linux-x64 native binaries for Vite and Esbuild, and locks the execution runtime to Node 22 LTS.
- **Trade-off**: Any dependency update in `package.json` must be regenerated via `npm install` and committed alongside `package-lock.json` in the same commit.
- **Rejected Options**: Using `npm install` on Vercel, ignoring `package-lock.json`.

---

### ADR-020: Shared Student Dashboard Architecture & Read-Only Teacher Inspection (Phase 3b-2)
- **Date**: 2026-10-17
- **Context**: Teachers require deep visibility into student practice records (streaks, today's tasks, 5-round score sheets, and multi-week progress charts) without granting editing permissions or duplicating complex frontend rendering logic across student and teacher views.
- **Options Considered**:
  1. *Allow `student.html?id=...` parameter for admins*: Violates least-privilege boundary and risks leaking data if URL parameters are manipulated by students.
  2. *Duplicate dashboard markup and rendering in an admin detail page*: Violates DRY, creates maintenance bottlenecks, and leads to divergence between student and teacher visual representations.
  3. *Shared Dashboard Modules with Strict Role Partitioning*: Extract authoritative data loaders (`js/dashboardData.js`) and visual renderers (`js/dashboardComponents.js`). Keep `/pages/student.html` strictly bound to the authenticated student's session (never reading URL params). Create `/pages/student-detail.html?id=...` with an admin-only guard, read-only banners, zero editing controls, and friendly missing-student fallbacks.
- **Choice**: Shared Dashboard Modules with Strict Role Partitioning.
- **Reason**: Guarantees bit-for-bit consistency between student self-monitoring and teacher oversight, prevents student account inspection tampering, encapsulates inline SVG charts (7-day dual line and 4-week bar charts with week-over-week comparisons), and guarantees sticky table 5-round pagination without duplicate code.
- **Trade-off**: Added `pages/student-detail.html` to Vite's multi-page input bundle.
- **Rejected Options**: Parameterized `student.html`, duplicated dashboard codebases.

---

### ADR-021: Admin Result Changes via PostgreSQL RPCs and Student Lock on Corrected Rows (Phase 4a)
- **Date**: 2026-10-18
- **Context**: In Phase 4a, instructors review, verify, flag, and correct student practice results. We needed to ensure every admin action is reliably audited with mandatory reasons, and determine the mutation boundary for students when a score has been corrected or verified by a teacher.
- **Options Considered**:
  1. *Direct Client `supabase.from('results').update(...)` with Client Audit Inserts*: The client browser writes the update to `results` and makes a second insert into `result_audit`. This is fragile: any network error, browser crash, or modified client could execute the update without creating an audit entry or bypass required reasons.
  2. *Database Triggers on Direct Updates*: Admins update `results` directly and a PostgreSQL trigger creates `result_audit` rows. However, PostgreSQL triggers cannot require a dynamic custom reason text from a standard REST `UPDATE` statement without awkward session variables or dummy column hacks.
  3. *Dedicated PostgreSQL RPCs (`admin_set_verified`, `admin_set_flag`, `admin_correct_result`) with Strict Lock on Corrected/Verified Rows*:
     - Admins MUST invoke these dedicated RPCs. The RPC transactionally stamps the target row (`verified_at`/`verified_by` or `corrected_at`/`corrected_by`) and writes the audit event to `result_audit` with `(action, old_values, new_values, reason, changed_by, changed_at)`.
     - Direct admin `UPDATE` statements on `results` are disallowed by design.
     - A database trigger and client-side guards strictly prevent students from modifying or deleting any row where `verified_at IS NOT NULL` OR `corrected_at IS NOT NULL`.
- **Choice**: Dedicated PostgreSQL RPCs with Student Lock on Corrected and Verified Rows.
- **Reason**:
  - **Audit Integrity**: Guaranteeing that every status change or score alteration is backed by an unforgeable, transactionally committed audit record with an explicit rationale (at least 3 characters for corrections).
  - **No Tampering with Teacher Corrections**: When a teacher reviews a paper sheet or competition drill and inputs an authoritative score correction, permitting a student to subsequently overwrite or re-submit that row would destroy the instructor's assessment. Once corrected, the row belongs to the academic record and cannot be mutated by the student.
  - **Editable Flagged Entries**: Flagging (`flagged = true`, `flag_note`) is intentionally non-locking; it serves as a coaching prompt ("Your teacher asked you to check this entry"), keeping the row editable so the student can re-check their worksheet, correct any typo, and re-save.
- **Trade-off**: Requires dedicated RPC definitions in SQL rather than relying purely on generic PostgREST table endpoints.
- **Rejected Options**: Direct client updates, optional audit logging, allowing students to overwrite teacher corrections.

