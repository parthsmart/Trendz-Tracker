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

---

### ADR-022: Database-Evaluated Basics Targets (`results_with_target`), Official Weekly Tests, and Unified Modal & Setup Navigation (Phase 4b)
- **Date**: 2026-10-18
- **Context**: In Phase 4b, teachers define per-category and per-level speed/accuracy targets for Basics drills and record official weekly test scores across all active students. Additionally, as the admin navigation grew to 10 pages, a flat navigation bar risked wrapping on smaller desktop viewports, and inconsistent modal classes caused unstyled inline forms on `/pages/attendance.html`.
- **Options Considered**:
  1. *Client-side target evaluation*: Computing `meets_target` in JavaScript by comparing `correct/total` and `time_seconds` against fetched `basics_thresholds`. Rejected because business logic for target evaluation must live exclusively in SQL (`results_with_target` view) so all views remain 100% consistent.
  2. *Flat 10-item admin navigation bar*: Causes horizontal overflow and visual clutter on laptop screens.
  3. *Database View (`results_with_target`), Teacher-Authored Weekly Tests, Shared Modal System (`js/modal.js`), and Grouped Setup Dropdown*:
     - Read `min_accuracy`, `max_time_seconds`, and `meets_target` directly from `results_with_target` wherever target badges are shown, while keeping writes pointed to `results`.
     - Store official weekly assessments in `weekly_tests` and `weekly_test_scores` (admin write, student read-only for own scores).
     - Standardize all 15 application modals on `.modal-overlay` + `.modal-dialog` (`max-width: 560px`) managed by `js/modal.js` with Escape key and focus return.
     - Group `Targets`, `Daily To-Do`, `Resources`, `Categories`, and `Rounds` under a `Setup ▾` dropdown while keeping `Overview`, `Review`, `Students`, `Attendance`, and `Weekly Tests` as primary top-level links.
- **Choice**: Option 3 (`results_with_target` view consumption, teacher-only weekly test scoring, unified `.modal-overlay`/`.modal-dialog`, and 5-link + `Setup ▾` admin navigation).
- **Reason**: Preserves single-source-of-truth SQL evaluation for target benchmarks, prevents students from mutating official weekly test scores, guarantees accessible modal behavior across all pages, and keeps the admin header clean on all screen sizes.
- **Trade-off**: Requires `results_with_target` view in Supabase.
- **Rejected Options**: Client-side target calculation, flat 10-link navigation bar, page-specific modal markup.

---

### ADR-023: Read-Only Multi-Block CSV Score Sheet Parser, Dynamic Layout Discovery, and Block-Scoped Round Identity (Phase 4c-1)
- **Date**: 2026-10-18
- **Context**: Historical student practice records exist in spreadsheets where multiple simulator eras ("blocks") sit side-by-side in the same sheet, each with its own `INDEX` and `Category` columns, its own list of categories (e.g. older blocks containing `Currency` and `Missing Figures`, newer blocks containing `HCF and LCM` and `Approximation`), and round counters that restart at `Round 1` in each block. Spreadsheets also contain real-world data-entry quirks: category typos (`"Calender"`, `"Time Elapse"`), stray values below category rows (`"94/231"` at `O10`), dots-only cells (`"......"`), plain-number times (`"75"`), and arithmetic mistakes in `Final Score`.
- **Decisions & Rationale**:
  1. *Separating Read-Only Preview (Phase 4c-1) from Database Saving (Phase 4c-2)*:
     - **Why**: Building and verifying the client-side parser, coordinate reporting (`A1`–`EX99`), cross-check math (`Final Score`, `Total Attempt`, `Marks TO BE CORRECTED`), and category mapping UI as a strictly read-only preview first allows teachers to spot spreadsheet typos, mixed dates, and arithmetic mismatches with zero risk of corrupting production tables.
  2. *Dynamic Header & Block Detection Instead of Fixed Row/Column Numbers*:
     - **Why**: Real student tracking sheets vary in where blocks start, how many blank columns separate blocks, whether placeholder headers like `Round0` exist, and whether summary labels (`Round Type`, `Time Taken`, `Final Score`, `Total Attempt`, `Marks TO BE CORRECTED`) sit in the `Category` column or the `INDEX` column to its left. Scanning dynamically for `"Category"` cells and `/^round\s*(\d+)$/i` column pairs (`timeCol = scoreCol + 1`) makes the parser resilient without requiring teachers to reformat sheets.
  3. *Identifying Rounds by `(block, roundNumber)` Instead of `roundNumber` Alone*:
     - **Why**: Because round numbers restart in each side-by-side block and represent only that student's own counter within that block, identifying a round by number alone would cause `Round 1` in Block 2 to collide with `Round 1` in Block 1.
- **Pure Module Isolation (`js/importParser.js`)**:
  - Written with zero DOM calls and zero `import.meta.env` references so the exact same ES module is executed in the browser (`js/import.js`) and in Node's native test runner (`node --test tests/importParser.test.js`).
- **Rejected Options**: Third-party CSV libraries (violates zero-new-dependency constraint), hard-coded row/column indices, auto-assigning top-row text hints like `"NEW SIMULATOR"` as block names, or guessing units on plain-number times like `"75"`.

---

### ADR-024: Per-Student Rounds (`student_rounds`), Simulator Series (`round_series`, `category_series`), and `start_round` RPC (Phase 4c-0)
- **Date**: 2026-10-18
- **Context**: Real student score sheets demonstrate that round numbers are each student's individual practice counter rather than an institute-wide shared counter, and that students transition across simulator generations (`"Old simulator"` with `Currency` and `Missing Figures` vs `"New simulator"` with `HCF and LCM` and `Approximation`).
- **Decisions & Rationale**:
  1. *Replacing Shared `rounds` with Per-Student `student_rounds` and `round_series`*:
     - **Why**: Identifying a round by `(student_id, series_id, round_number)` allows each student to progress at their own pace in the current simulator while preserving their complete historical rounds in older simulator series without number collisions.
  2. *Series-Specific Category Membership & Ordering (`category_series`)*:
     - **Why**: Different simulator series contain different 24-category rosters. Querying `category_series` ordered by `category_series.sort_order` ensures that viewing `"Old simulator"` displays `Currency` and `Missing Figures` in their exact sheet positions, while `"New simulator"` displays `HCF and LCM` and `Approximation`.
  3. *Student Round Creation via `start_round` RPC*:
     - **Why**: Students cannot insert directly into `student_rounds`. Calling `start_round(p_student, p_round_type)` atomically assigns the student's next round number in the current series, stamps `today_ist()`, and reuses today's empty round if one already exists, preventing accidental duplicate empty rounds.
- **Rejected Options**: Keeping shared `rounds` table, using `categories.sort_order` for round matrices, or allowing direct client `INSERT` into `student_rounds` by students.

---

### ADR-025: CSV Import Part 2A — Simulator Suggestion & Confirmation per Block, Category Resolution Priority, and Read-Only Existing Data Comparison (Phase 4c-2a)
- **Date**: 2026-10-18
- **Context**: With per-student rounds (`student_rounds`) and simulator series (`round_series`, `category_series`) established in Phase 4c-0, the admin CSV import preview must map each side-by-side spreadsheet block to a simulator series, resolve category names against database aliases and series rosters, and compare every round and cell against the selected student's existing database records before any write logic is enabled.
- **Decisions & Rationale**:
  1. *Suggestion-Only Simulator Series Selection with Explicit Admin Confirmation & Duplicate Blocking*:
     - **Why**: A block containing `"currency"` or `"missingfigures"` strongly indicates `"Old simulator"`, whereas `"approximation"` or `"hcfandlcm"` indicates `"New simulator"`. Pre-selecting this as a suggestion saves time, while requiring explicit admin confirmation on every block and blocking two blocks from sharing the same series prevents accidental cross-series overwrites.
  2. *Three-Tier Category Resolution Priority (`category_aliases` -> Built-in Aliases -> Exact Match)*:
     - **Why**: Matching on lowercase whitespace-stripped keys checks database `category_aliases` first, then built-in aliases (`"calender"` -> `Calendar`, `"timeelapse"` -> `Time Elapsed`), and finally `categories.name`, while validating membership against `category_series` and blocking duplicate target category mappings within a block.
  3. *Read-Only Existing Data Comparison & Protected Row Preservation (`js/importResolver.js`)*:
     - **Why**: Comparing CSV rounds by `(student_id, series_id, round_number)` against `student_rounds` and `results` classifies every round (`new`, `identical`, `adds_cells`, `conflict`) and every cell (`new`, `identical`, `conflict`, `protected_conflict`, `db_only`), ensuring teacher-verified (`verified`) and teacher-corrected (`corrected_at`) scores are flagged as protected and never silently overwritten.
- **Rejected Options**: Modifying `js/importParser.js` for database comparison logic (kept isolated in `js/importResolver.js` and tested via `node:test`), auto-confirming suggested series without admin review, or allowing two blocks in the same sheet to target the same simulator series.

---

### ADR-026: CSV Import Part 2B — Import Execution Plan, Non-Overwriting Merge, Batch History & Undo (Phase 4c-2b)
- **Date**: 2026-10-18
- **Context**: Once an administrator previews a multi-block score sheet, resolves categories, and confirms simulator series, the application must import rounds and cells safely into Supabase (`student_rounds`, `results`, `import_batches`) with full traceability and one-click undo capability.
- **Decisions & Rationale**:
  1. *Batch Lifecycle (`admin_start_import_batch` -> `admin_import_rounds` -> `admin_finish_import_batch`)*:
     - **Why**: Wrapping every import run in an `import_batches` record stamps all newly created `student_rounds` and `results` rows with `import_batch_id`. This allows `admin_undo_import_batch(p_batch_id, p_reason)` to cleanly delete only rows created by that specific batch without disturbing earlier or teacher-verified data.
  2. *Non-Overwriting Merge Policy (`ON CONFLICT DO NOTHING`)*:
     - **Why**: Re-running an import or importing overlapping sheets must never overwrite existing scores or teacher-verified/corrected records. Only `new` cells are included in the `admin_import_rounds` payload; existing identical, conflicting, and protected rows are left untouched.
  3. *Chunking per Call (`<= 100` rounds and `<= 3000` cells)*:
     - **Why**: Splitting large blocks into bounded chunks (`chunkRoundsForImport`) respects database RPC payload limits and keeps each transaction fast and reliable.

---

### ADR-027: Mirroring Database Validation Limits in the Import Preview and Pre-Flight Plan (Phase 4c-2c)
- **Date**: 2026-10-19
- **Context**: When importing a real student tracking sheet, `admin_import_rounds` rejected the entire RPC call with `"Some rounds are not valid (number, date, type or total time). Nothing was imported."` The root cause was that Block 2 Round 14 had a `Time Taken` of `"59:23:00"` (`213,780` seconds, ~59 hours) at cell `DV31` due to a spreadsheet formula/entry typo, whereas the PostgreSQL RPC `admin_import_rounds` enforces `time_taken_seconds IS NULL OR (time_taken_seconds >= 0 AND time_taken_seconds <= 28800)` (8 hours max) and aborts the entire transaction if any single round or cell violates a database constraint.
- **Options Considered**:
  1. *Relaxing the PostgreSQL constraints in `admin_import_rounds`*: Rejected because database constraints are the final integrity barrier against corrupt data (e.g. a 59-hour round duration is not a real abacus practice session duration), and database functions/SQL must not be changed.
  2. *Letting the database RPC fail and asking the admin to edit the CSV file manually*: Rejected because an atomic batch failure aborts all 70+ valid rounds in the block over a single typo in one cell, creating friction and leaving an empty `"Open"` batch in history.
  3. *Mirroring exact database limits in `js/importParser.js` and `js/importPlan.js`, sanitizing/excluding out-of-range items during preview, and running a pre-flight `validatePayload(payload)` check before any RPC call*:
     - **Round limits mirrored**:
       - `round_number`: integer `1..100000` (outside range -> round excluded).
       - `round_date`: `YYYY-MM-DD` between `2020-01-01` and `today_ist()` (outside range or unreadable -> round excluded).
       - `round_type`: max `40` characters (longer -> truncated to `40` characters with a warning).
       - `time_taken_seconds`: `null` or `0..28800` (8 hours). Above `28,800` seconds -> emits warning `"Total time <text> at <cell> is more than 8 hours: the round will be imported WITHOUT a total time"`, adds a count to the Step 3 acknowledgment list, and sets `time_taken_seconds = null` in the payload so the round's scores still import cleanly.
       - Call size: max `100` rounds and `3,000` cells per `admin_import_rounds` call (`chunkRoundsForImport`).
     - **Cell limits mirrored**:
       - Either `correct` and `total` both present with `0 <= correct <= total` and `total >= 1`, or both absent with a non-empty `note`.
       - `note`: max `500` characters (longer -> truncated to `500` characters with a warning).
       - `time_seconds`: `null` or `0..14400` (4 hours). Above `14,400` seconds -> cell marked `unreadable` (not imported) with a warning.
       - Category uniqueness: each `category_id` at most once per round.
     - **Pre-flight `validatePayload(payload)`**:
       - Executed on every chunk before any database RPC (`admin_start_import_batch` / `admin_import_rounds`) is called. If any rule is broken, returns structured problems naming `{ roundNumber, field, value, message }` and blocks the database call before any open batch is created.
- **Choice**: Option 3 — Mirror all database limits in pure functions (`js/importParser.js`, `js/importPlan.js`) with graceful degradation (nullify `>8h` total time, mark `>4h` cell time unreadable, truncate `>40` round type and `>500` note, exclude invalid rounds) plus pre-flight `validatePayload(payload)` verification and expandable technical error diagnostics.
- **Reason**:
  - **Prevents Atomic Batch Failures**: Because `admin_import_rounds` validates the entire JSON array atomically and rolls back all rounds if even one field is out of bounds, catching and sanitizing or excluding offending values in the browser preview ensures valid rounds import smoothly without requiring manual CSV editing.
  - **Transparency & Auditability**: Every automatic adjustment (such as importing Round 14 without total time when `DV31` is `59:23:00`, or excluding a round with a date before `2020-01-01`) is surfaced in the "Needs Attention" panel, the per-round table, and the Step 3 acknowledgment checklist before the teacher clicks **Import**.
  - **Defense in Depth**: Running `validatePayload(payload)` immediately prior to database submission guarantees that even if UI state is manipulated, no invalid payload is ever sent over the network, and no orphan `"Open"` batch is created when a pre-flight check fails.
- **Trade-off**: Validation constants (`28800`, `14400`, `40`, `500`, `100`, `3000`, `2020-01-01`) must be kept in sync with the PostgreSQL `admin_import_rounds` function definition.
- **Rejected Options**: Altering SQL constraints, failing the whole import on a single >8h total time cell, or silently dropping values without warning the administrator.

---

### ADR-028: Competition Points & Leaderboards Architecture — Why Points Come from Weekly Tests & Attendance, Why Boards Return Only Top 10 Plus Own Rank, and Why the Formula Lives in SQL (Phase 5a)
- **Date**: 2026-10-19
- **Context**: Phase 5a introduces student and admin leaderboards (`points`, `streak`, `practice_days`, `improved`) and configurable competition settings (`competition_settings`). We needed to establish fair, tamper-resistant scoring rules, protect young students from demotivation or privacy exposure, and ensure zero discrepancy between student and teacher views.
- **Decisions & Rationale**:
  1. *Why Points Come from Weekly Tests and Attendance (Admin-Entered Data) and NOT from Practice Volume*:
     - **Tamper Resistance**: Daily practice scores (`results`) are self-entered by students at home and can be typed inaccurately or inflated before a teacher verifies them. In contrast, `weekly_test_scores` and `attendance` are entered exclusively by teachers/administrators.
     - **Quality Over Spam**: Awarding competition points for raw practice volume would incentivize students to spam rapid, low-effort or fabricated entries just to farm points. By deriving the flagship **Points** board strictly from official teacher-graded weekly tests (`GREATEST(correct - wrong, 0) * weekly_test_multiplier` per category) and verified class/workshop attendance (`attendance_present_points` per present session; excused sessions give 0 and cost 0), the primary points leaderboard cannot be gamed by student-typed data. Practice consistency is recognized separately on dedicated boards (`Practice days`, `Streak`, `Most improved`).
  2. *Why Student Boards Return Only the Top 10 Plus the Student's Own Row (Scoped to Their Own Level)*:
     - **Pedagogical Safety & Anti-Shaming**: Publishing a full bottom-to-top ranking of every child in the institute discourages beginners and publicly exposes struggling students at the bottom of the list. Returning only the **Top 10** celebrates high achievers while appending the student's **own row** (when ranked outside the top 10) gives every student private visibility into their personal standing without exposing classmates ranked 11th and below.
     - **Fair Peer Comparison & Privacy**: Filtering student calls strictly to the caller's own `level`, stripping `student_id` (`NULL` for students), excluding `leaderboard_visible = false` and zero-value rows, and formatting names as `first_name_initial` (`"Aarav S."`) or `student_code` (`"STU101"`) ensures students only compare within their skill cohort and never see full names or raw scores of classmates.
  3. *Why the Formula Lives Exclusively in PostgreSQL (`leaderboard` and `competition_rules` RPCs) and Never in Client JavaScript*:
     - **Single Source of Truth & Zero Client Tampering**: Calculating points, streaks, accuracy deltas, or ranks in browser JavaScript would require exposing raw cross-student score tables to client browsers (violating Row Level Security) and would allow different screens or modified clients to compute conflicting numbers. Executing all aggregation, Indian Standard Time (`Asia/Kolkata`) period boundaries (`week`, `month`, `all`), `competition_settings` multipliers, and `RANK()` window functions inside `SECURITY DEFINER` SQL RPCs guarantees identical, authoritative results on the Student Dashboard card, Student Leaderboard page, and Admin Leaderboard view.
- **Rejected Options**: Awarding points per student-typed practice entry, exposing full rankings below #10 to students, returning full student names on leaderboards, or computing points/ranks in client-side JavaScript.

---

### ADR-029: Phase 5b — Weekly Report Email via Resend REST API, Idempotent Cron Logging, Monthly Student Report RPC, and Manual Milestone Sharing
- **Date**: 2026-10-19
- **Context**: Phase 5b introduces automated and manual weekly institute email reports (`/api/weekly-report`, `api/_reportEmail.js`, `report_log`), a printable monthly student progress report (`/pages/monthly-report.html`, `student_month_report`), and 7-day streak milestone alerts (`admin_milestones(7)`) on the Admin Overview page.
- **Decisions & Rationale**:
  1. *Zero-Dependency Email Delivery via Native `fetch` to Resend (`POST https://api.resend.com/emails`) and Pure Email Builder (`api/_reportEmail.js`)*:
     - **Why**: Keeps `package.json` free of third-party SDK bloat while supporting both HTML and plain-text multipart emails. Separating `buildWeeklyEmail(data)` into a pure, DOM-free, network-free module (`api/_reportEmail.js`) makes email generation 100% deterministic, testable via `node --test`, and reusable for admin previews without sending emails.
  2. *Constant-Time Cron Secret Verification & Unique-Index Idempotency on `report_log`*:
     - **Why**: Scheduled `GET /api/weekly-report` requests from Vercel Cron (`30 15 * * 0` UTC, ~9:00 PM Sunday IST; runs **only on the production deployment**) are authenticated by comparing `Authorization: Bearer <CRON_SECRET>` in constant time (`crypto.timingSafeEqual` on SHA-256 digests). Before calling Resend, the handler inserts a `report_log` row (`kind = 'cron'`, `status = 'sending'`, `week_start`). If the PostgreSQL unique index on `(week_start)` for active cron runs rejects the insert (`23505`), the endpoint immediately returns `200 { skipped: true }` without sending a duplicate email.
  3. *Authoritative SQL Aggregation (`weekly_report_data`, `student_month_report`, `admin_milestones`) & Manual WhatsApp Links*:
     - **Why**: All streaks, points, accuracy percentages, QPM, attendance percentages, and week/category rollups are computed by PostgreSQL RPCs in Indian Standard Time (`Asia/Kolkata`) and rendered as-is without any consistency percentage or client-side recalculation. WhatsApp sharing uses user-initiated `https://wa.me/?text=...` links and clipboard copy actions without storing phone numbers or sending automated messages.
- **Rejected Options**: Installing the `resend` or `nodemailer` npm packages, computing monthly rollups or consistency percentages in browser JavaScript, or logging student PII/API keys in server logs.

---

### ADR-030: Phase 5c — Nightly Google Sheet Backup (Snapshot vs Append Keyset Cursor) & Zero-Dependency Store ZIP Export
- **Date**: 2026-10-19
- **Context**: Phase 5c requires (1) a nightly automated backup (`30 20 * * *` UTC, ~2:00 AM IST on production) and manual on-demand backup of all 18 database tables to a private Google Spreadsheet (`BACKUP_SHEET_ID`), and (2) an in-browser "Download all data (ZIP)" export (`trendz-backup-YYYY-MM-DD.zip`) containing 18 RFC 4180 CSVs plus `README.txt` with zero new npm dependencies.
- **Decisions & Rationale**:
  1. *Single Source of Truth Table Configuration (`api/_backupTables.js`)*:
     - **Why**: Centralizes the 12 small **snapshot** tables (`profiles`, `round_series`, `categories`, `category_series`, `basics_thresholds`, `daily_tasks`, `resources`, `competition_settings`, `category_aliases`, `attendance_sessions`, `weekly_tests`, `import_batches` — rewritten completely on each run up to 20,000 rows) and the 6 high-volume **append** tables (`student_rounds`, `results`, `weekly_test_scores`, `attendance`, `activity_results` with cursor `updated_at`, and `result_audit` with cursor `changed_at`), their primary keys, and sheet value serializers in one shared module.
  2. *Zero-Dependency Google Service-Account RS256 Signing & `valueInputOption=RAW` (`api/_google.js`)*:
     - **Why**: Uses Node's built-in `node:crypto` (`createSign('RSA-SHA256')`) and native `fetch` to exchange a signed JWT assertion for an OAuth2 access token (`https://www.googleapis.com/auth/spreadsheets`), caching the token in memory across warm invocations, retrying once after 2 seconds on HTTP 429/5xx, and writing strictly with `valueInputOption=RAW` so user strings starting with `=` are never evaluated as spreadsheet formulas. Error sanitizers strip tokens, keys, and row payloads before logging or saving to `backup_state.last_error` / `backup_runs.error`.
  3. *Exact Microsecond Keyset Pagination, 1-Minute Horizon, and 8-Second Time Budget (`api/backup.js`)*:
     - **Why**: Append tables page forward using `ORDER BY <cursor_column> ASC, id ASC` with PostgREST `.or('col.gt.X,and(col.eq.X,id.gt.Y)')` and a 1-minute safe horizon (`col <= now() - 60s`) so concurrent database transactions cannot be skipped between runs. Timestamp strings are preserved verbatim from PostgreSQL without passing through `new Date()`, preventing microsecond truncation. Each serverless invocation enforces an 8-second time budget: if reached mid-run, it saves the cursor progress after the current page, records `status = 'partial'` and `error = 'more to do'`, and allows the admin UI (up to 10 automatic passes) or the next cron invocation to resume seamlessly.
  4. *Hand-Written IEEE 802.3 CRC32 & Uncompressed PKZIP Store Builder (`js/backupExport.js`)*:
     - **Why**: Avoids third-party ZIP libraries (`jszip`, `fflate`) while producing standard PKZIP archives (`method = 0`, UTF-8 bit 11 flag) containing 18 RFC 4180 CSVs (with formula-prefix sanitization for non-numeric strings starting with `=`, `+`, `-`, `@`) and `README.txt`. If any table fails to read, the export aborts immediately so an incomplete ZIP is never downloaded. Completed exports are logged via `admin_log_export(p_rows, p_tables)`.
- **Rejected Options**: Installing `googleapis` or `jszip` packages, converting cursor timestamps through JavaScript `Date` (loses microseconds), using `USER_ENTERED` mode in Google Sheets, or downloading partial ZIP archives when a table query fails.

---

### ADR-031: Phase 8 — Elements Timed Worksheet Drills: Server-Authoritative Generation & Grading (`api/_drills.js`, `/api/drill`), Exact Integer/BigInt Arithmetic, `modulo` Disabled by Default, and `days_to_seconds` 300s Limit
- **Date**: 2026-10-19
- **Context**: Phase 8 brings the 18 timed "Elements" mental-math and calendar/time conversion worksheet drills from the legacy Python desktop program into Trendz Tracker while enforcing server-only answer generation and grading (`drill_sessions` and `activity_results`).
- **Decisions & Rationale**:
  1. *Pure Server Module (`api/_drills.js`) with Injectable RNG & Exact Integer / `BigInt` Arithmetic*:
     - **Why**: Keeping all 18 generators, parsers, canonical comparators, and display formatters in a pure, network-free Node module with an injectable `rng(min, max)` function (defaulting to `crypto.randomInt`) allows deterministic unit testing across 200 seeded runs per drill (3,600 generated sets total in `tests/drills.test.js`). Using exact integer and `BigInt` arithmetic (including exact integer square-root ceiling via binary search in `number_to_be_squared` and Euclidean GCD reduction in `ratio`) eliminates floating-point precision drift.
  2. *`modulo` Drill Disabled Until Teacher Confirmation (`MODULO_DRILL_ENABLED = false`)*:
     - **Why**: In the legacy desktop program, the 3-digit `n2` branch of `modulo` sets the lower bound using `d1*d3*2 + d2*d2 + 10` (subtracting the duplex sum `d1*d3*2 + d2*d2`), whereas its answer formula computed `n3 - d1*d3*2 + d2*d2`. Both formulas are preserved side-by-side in code comments in `api/_drills.js` (with the generator's intended `n3 - (d1*d3*2 + d2*d2)` active for unit testing), and `DRILLS.modulo.enabled` is controlled by a single constant `MODULO_DRILL_ENABLED = false` so the catalog displays `"Coming soon"` and `/api/drill` rejects `start` calls for `modulo` until a teacher confirms the rule.
  3. *`days_to_seconds` Time Limit Set to `300` Seconds (5 Minutes)*:
     - **Why**: The original desktop screen states a 5-minute time limit (`300` seconds), whereas its timer loop contained a bug that stopped at `60` seconds. We use the intended `300` seconds (`5 minutes`).
  4. *Personal Best Ranking (`bestForDrill`) & Zero-Attempt Handling*:
     - **Why**: Because Elements worksheets have fixed question counts and time limits where students may leave questions blank, `activity_results.total` records `attempted` (non-blank answers). `bestForDrill` ranks completed sets by highest `correct` first, then fewest wrong answers (`total - correct`), then shortest `time_seconds`. If `attempted === 0`, the server marks the session submitted and returns the review breakdown (`saved: false`) without cluttering `activity_results` with 0-attempt rows.
- **Rejected Options**: Client-side question generation or answer checking, using `Math.sqrt` or `Number()` coercion for answer parsing, or enabling `modulo` before teacher sign-off.

---

### ADR-032: Phase 7b — Flash Anzan Simplification: Why One Question Per Try, Why Presets Were Removed, and Why Leaving the Page Cancels the Try
- **Date**: 2026-10-19
- **Context**: Phase 7b simplifies the Flash Anzan trainer from multi-question sets (`3–30` questions of `3–30` numbers) to **one question per try** (`2–1,000` numbers per question), removes the fixed preset buttons (`js/flashPresets.js`), adds tab-visibility cancellation, and groups statistics by exact `(digits, count, speed_ms, mode)` settings (`js/flashStats.js`, `js/flashTimeline.js`).
- **Decisions & Rationale**:
  1. *Why One Question Per Try (`total = 1`, `count = 2..1000`)*:
     - **Immediate Feedback & Endurance Range**: In real abacus Flash Anzan coaching, students adjust their speed (`0.2–5.0s`) or number count (`2–1,000`) immediately after seeing whether a single sequence succeeded. Bundling 3–30 questions into a set forced students to wait through an entire batch before getting feedback and prevented long endurance runs (e.g. 100 to 1,000 numbers in a single continuous stream). Saving each try with `total = 1` and `correct = 1 | 0` while computing `statsByKey` as `sum(correct) / sum(total)` keeps every new try atomic while preserving historical multi-question rows seamlessly.
  2. *Why Fixed Presets (`Beginner`, `Intermediate`, `Advanced`, `Custom`) Were Removed*:
     - **Granular Progression Over Arbitrary Tiers**: Flash Anzan skill progression varies independently across digits (`1–5`), number count (`2–1,000`), speed (`0.2–5.0s`), and mode (`add` vs `add_sub`). Fixed presets cluttered the setup screen and encouraged students to stay on three arbitrary combinations instead of dialing in their exact teacher-assigned parameters (supported by `localStorage` persistence and the `"Your results at these settings"` / `"Most-practised settings"` tables).
  3. *Why Leaving the Page (`visibilitychange` / `document.hidden`) Cancels the Try*:
     - **Timer Integrity & Fair Practice**: Modern browsers throttle background tab timers to $\ge 1,000\text{ ms}$, which breaks the exact `speed_ms + 80 ms` cadence of a running flash sequence, and switching away during flashing could allow a student to pause or inspect numbers outside the live mental drill. Immediately cancelling the try when `document.hidden` becomes `true` during the countdown or flashing phase (saving nothing and explaining why) guarantees that every completed try was watched continuously in the foreground.
- **Rejected Options**: Keeping a `"questions per set"` selector, keeping arbitrary preset buttons, or pausing/resuming a flash sequence across tab switches.

---

### ADR-033: Phase 9a — Online Basics Practice: Why Generators Are Derived from the Category Name, and Why Site Results Are Locked and Marked `"Recorded by the site"` Instead of `"Verified by teacher"`
- **Date**: 2026-10-20
- **Context**: Phase 9a adds online one-question-at-a-time practice for mental-math Basics speed drills (`/pages/basics-practice.html`, `api/_drills.js`, `/api/drill.js`, `js/drillPlayer.js`, `js/practiceStats.js`), saving completed sets directly into `public.results` with `source = 'site'` and `verified = true`.
- **Decisions & Rationale**:
  1. *Why Question Generators Are Derived Directly from the Basics Category Name (`parseBasicsCategoryName`)*:
     - **Zero-Configuration Extensibility**: Teachers already name Basics categories using standard abacus notation (`1d4r`, `2d2r`, `2d4r`, `1dx1d`, `2dx1d`, `2d/1d`, `3d/1d`). Parsing the active category's `name` (case-insensitive, spaces ignored; accepting `x`, `X`, `×`, `*` for multiplication and `/`, `÷` for division) means any existing or newly created Basics category that follows standard notation automatically becomes available for online practice without schema migrations or extra admin setup fields.
     - **Safe Fallback for Custom Worksheet Categories**: Any category name outside the supported patterns (or where no valid exact division quotient exists, or `active = false`) cleanly returns `null` from `parseBasicsCategoryName` and retains manual typed score entry only.
  2. *Why Site Results Are Locked (`verified = true`) and Marked `"Recorded by the site"` (`source = 'site'`) Rather Than `"Verified by teacher"`*:
     - **Immutability Without Schema Duplication**: Setting `verified = true` when the server inserts a `source = 'site'` row into `results` immediately activates existing database triggers and Row Level Security rules so students cannot edit or delete server-graded scores, while seamlessly feeding existing streaks (`streak_for`), daily to-do ticks (`todo_for`), target benchmarks (`results_with_target`), leaderboards, monthly reports, and backups.
     - **Clear Provenance for Teachers and Students**: A score graded automatically by the server (`source = 'site'`, `verified_by = null`) was not manually checked by a human instructor (`source = 'typed'`, `verified = true`). Rendering **`Recorded by the site`** for `source = 'site'` and **`Typed`** (plus **`🔒 Verified`** when teacher-verified) for `source = 'typed'` across `/pages/basics.html`, Student Home, `/pages/student-detail.html`, and `/pages/review.html` gives teachers and students accurate provenance at a glance.
- **Rejected Options**: Adding a `generator_config` column to `categories`, leaving online Basics results unverified/editable by students, or labeling automated server-graded sets as `"Verified by teacher"`.

---

### ADR-034: Phase 8c — Elements Worksheet Keyboard Shortcuts & Why Shortcut Detection Lives in a Shared Module (`js/competitionKeys.js`)
- **Date**: 2026-10-20
- **Context**: Phase 8c adds numpad and keyboard navigation (`+` for next question, `-` for previous question), a non-colour-alone active-question highlight with a `localStorage` toggle, a one-line numpad hint under the timer, and touch-device `Previous`/`Next` buttons to `/pages/element-drill.html` (`js/elementDrill.js`).
- **Decisions & Rationale**:
  1. *Why Shortcut Logic Lives in a Shared Pure Module (`js/competitionKeys.js`) for the Coming Competition Mode*:
     - **Single Contract for One-Handed Numpad Entry**: In both the Elements timed worksheet and the upcoming Memoriad competition mode, students enter numbers rapidly with one hand on the numpad and use `+` (`NumpadAdd`), `-` (`NumpadSubtract`), and `*` (`NumpadMultiply`) as control keys. Extracting `keyAction(eventLike)` into a pure, DOM-free module ensures key normalisation (`+` / `NumpadAdd` $\to$ `'next'`, `-` / `−` / `NumpadSubtract` $\to$ `'previous'`, `*` / `NumpadMultiply` $\to$ `'step'`, and `null` whenever `ctrlKey`, `altKey`, or `metaKey` is held) is defined and unit-tested (`tests/competitionKeys.test.js`) in one place.
     - **Page-Specific Action Handling (`*` Preserved for Prime Factors)**: Because `keyAction` returns semantic action strings (`'next'`, `'previous'`, `'step'`, or `null`) without mutating DOM events, the Elements worksheet (`js/elementDrill.js`) can consume `'next'` and `'previous'` while ignoring `'step'` (`*`), allowing students to type `*` as a multiplication sign in the Prime Factor drill (`prime_factors`, e.g., `2^2*5*13`), whereas the upcoming competition player will consume `'step'` as well.
  2. *Why Active-Question Highlight Uses Both Background and Border Thickness with a `try/catch` `localStorage` Toggle*:
     - **Accessibility Beyond Colour Alone**: Applying both a tinted background (`--color-primary-subtle`) and a thicker border (`2px solid var(--color-primary)` with a `5px` left accent bar) makes the focused question unmistakable for colour-vision-deficient students, while `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` with `scroll-margin-top` keeps the active question clear of the sticky timer bar. Wrapping `localStorage` reads/writes in `try/catch` ensures the `"Highlight the active question"` toggle (default ON) never fails in restricted browser environments.
- **Rejected Options**: Hard-coding key checks directly inside `js/elementDrill.js`, intercepting `*` on the Elements worksheet (which would break Prime Factor answer entry), or relying on colour alone for the focused question row.

---

## ADR-035: Phase 9b-1 — Memoriad Competition Practice Architecture, Server-Side Generation/Scoring, Original Visual Design & Pure State Modules
- **Date**: 2026-10-20
- **Status**: Accepted
- **Context**: Phase 9b-1 introduces a desktop competition practice stage (`/pages/memoriad.html` and `/pages/memoriad-play.html`) plus the first two competition modules (**Mental Calendar Dates** and **Mental Additions**, with **Mental Multiplications** and **Mental Square Roots** marked `"Coming soon"`), while reusing `verifyStudentCaller`, `js/scoreColors.js`, and `js/competitionKeys.js` and introducing zero new dependencies.
- **Decisions & Rationale**:
  1. *Why Memoriad Modules Are Separate from Round Categories and Stored as `activity_type = 'memoriad'` in `activity_results`*:
     - Competition round categories in `public.results` belong to the 24-category teacher-tracked score sheets (`student_rounds`), where each round has fixed category totals and teacher review/verification workflows. Memoriad practice runs are self-paced desktop simulator sessions with configurable question counts (e.g., `25, 50, 75, 100, 125` dates) and variable attempted counts (`total = attempted`, `correct = number correct`). Storing them in `public.activity_results` (`activity_type = 'memoriad'`) keeps the round score sheet clean while still feeding `streak_for`, `todo_for` (`section = 'memoriad'`), and practice-day tracking.
  2. *Why Generation and Scoring Happen Exclusively on the Server (`api/_memoriad.js` & `api/memoriad.js`)*:
     - Questions (`[year, month, day]` triples for Calendar; ten 10-digit strings for Additions) and canonical expected answers (Gregorian weekday index `0..6` or exact `BigInt` sum string) are generated on the server using `crypto.randomInt`, persisted in `public.drill_sessions` (`expires_at = now + 3 hours`), and stripped from the `start` payload via `buildMemoriadStartResponse`. On `submit`, the server computes `used_seconds = max(0, (now - started_at) - concentration_seconds)`, enforces plausibility (`used_seconds >= attempted * 0.25s` for Calendar; `used_seconds >= attempted * 3s` for Additions), claims the session atomically (`status = 'open' -> 'submitted'`), and writes to `activity_results` with the service role only when `attempted > 0`.
  3. *Why the Original Memoriad Visual Look Is Not Copied*:
     - To respect intellectual property and maintain visual cohesion across Trendz Tracker, no Memoriad logo, artwork, button graphics, fonts, or colour schemes are used, and no affiliation is implied. Instead, the stage uses Trendz design tokens (`--color-primary`, `--bg-surface`, high-contrast borders, tabular numerals) tailored for a 1280×800 desktop viewport without page scrolling, with a friendly `< 1000px` viewport guard directing mobile/tablet users to a laptop or desktop with a keyboard.
  4. *Pure Client State Modules & Left-to-Right (`ltr`) Column Highlight Assumption*:
     - Extracting `js/answerSlots.js`, `js/columnHighlight.js`, `js/calendarKeys.js`, `js/memoriadFormat.js`, and `js/memoriadStats.js` as pure DOM-free ES modules enables deterministic `node --test` unit testing of all cursor, compacting, key-mapping, and ranking edge cases. For Mental Additions in `ltr` typing direction, `highlightedColumns` starts at the leftmost column(s) (`[0]` or `[0, 1]`) and advances rightward by `columnsPerStep` (`1` or `2`) per step, clamping at the rightmost column(s) (`[9]` or `[8, 9]`).
- **Rejected Options**: Storing Memoriad practice runs in `public.results` under round categories, generating dates/sums or computing scores in browser JavaScript, or embedding slot-cursor and column-highlight math directly inside DOM event handlers.

---

## ADR-036: Phase 9b-1b — Official Calendar Two-Mistake Scoring Rule, Authoritative Round Time Limits, and Up-to-4-Column Group Typing
- **Date**: 2026-10-20
- **Status**: Accepted
- **Context**: Phase 9b-1b updates the Memoriad competition practice engine with authoritative module round time limits (`calendar: 60s`, `additions: 600s`, `multiplications: 900s`, `square_roots: 900s`), the official Memoriad Calendar Dates scoring rule, and up-to-4-column group typing (`g = 1..4`) for Mental Additions.
- **Decisions & Rationale**:
  1. *Why Calendar Scoring Follows the Original Two-Mistake Stop Rule While Preserving Raw `# of Correct Answers`*:
     - **Official Competition Fidelity**: In the real Memoriad Mental Calendar Dates competition, answers are evaluated in question order (`1..N`), skipped questions are ignored (neither right nor wrong), the first wrong answer is forgiven (`wrongCount = 1`), and from the second wrong answer onward (`wrongCount >= 2`) the official `SCORE` stops increasing even if subsequent answers are right. Meanwhile, the raw `# of Correct Answers` counter (`correctCount`) continues incrementing for every right answer.
     - **Diagnostic Transparency in `activity_results`**: Persisting `correct = correctCount`, `total = attempted`, `settings.score = score`, and `settings.wrong = wrongCount` in `public.activity_results` — and displaying both **`SCORE`** and **`# of Correct Answers`** on the Results screen while showing `Score` as the main number on the Memoriad hub and dashboard cards — ensures students practice under authentic tournament pressure while teachers can still see how many total dates the student solved accurately after a second mistake.
  2. *Why Round Time Limits Are Shared Between `api/_memoriad.js` and `js/memoriadConfig.js` with Parity Tests and a 30-Second Server Expiry Grace*:
     - **Single Source of Truth Across Node and Browser**: Defining `MEMORIAD_TIME_LIMITS` (`calendar: 60`, `additions: 600`, `multiplications: 900`, `square_roots: 900`) and `MEMORIAD_EXPIRY_GRACE_SECONDS = 30` in `api/_memoriad.js` and mirroring them in `js/memoriadConfig.js` (verified by an automated unit test in `tests/memoriadServer.test.js`) guarantees zero drift without requiring bundler aliases in Node's native test runner. Setting `expires_at = start + concentration_seconds + limit + 30s` and clamping `used_seconds = min(limit, max(0, (now - started_at) - concentration_seconds))` allows automatic `finished_by: 'time_up'` submissions to succeed over slow connections while blocking late tampering.
  3. *Why Right-to-Left Multi-Column Additions (`g = 2..4`) Uses Left-to-Right Intra-Group Typing with History-Backed `Backspace`*:
     - **Authentic Multi-Column Mental Addition Workflow**: When a student adds `g` columns at a time (`g` in `2..4`) from right to left across 11 answer slots (`0..10`), each mental partial sum produces a `g`-digit chunk read from its tens/hundreds/thousands place to its units place. Starting the cursor at `11 - g`, moving left-to-right within the `g`-slot group, and jumping to the leftmost slot of the next group to the left after `g` digits matches the original training program, while recording each typed slot in `history` ensures `Backspace` always undoes the most recently typed digit and restores the cursor to that exact slot.
- **Rejected Options**: Treating every wrong Calendar answer as a simple `-1` or counting all correct answers toward `score` after 2 mistakes, or moving the cursor strictly right-to-left one slot at a time when `g > 1`.


---

## ADR-037: Phase 9b-2 — Mental Multiplications, Exact Integer Square-Root Half-Up Rounding, Triangular Prefix Scoring, and Pure Step Boxes

- **Date**: 2026-10-20
- **Status**: Accepted
- **Context**:
  - Phase 9b-2 completes the four-module Memoriad practice suite with **Mental Multiplications** (10 questions of $8\text{-digit} \times 8\text{-digit}$ numbers, 900s limit) and **Mental Square Roots** (10 six-digit non-square integers, 900s limit, rounded half-up to 5 decimals), plus interactive step-box column markers and a fix for the stage **Exit** button.
- **Decisions**:
  1. **Exact `BigInt` Integer Square Root (`isqrt`) with Half-Up Rounding**:
     - For a 6-digit integer $n \in [100000, 999999]$ (excluding perfect squares), the server computes $m = \text{BigInt}(n) \times 10^{10}\text{n}$ and $r = \lfloor\sqrt{m}\rfloor$ via Newton's method in `BigInt`.
     - Because $(r + 0.5)^2 = r^2 + r + 0.25$, the exact half-up condition $\sqrt{m} \ge r + 0.5$ is equivalent in integer arithmetic to $m - r^2 \ge r + 1$. When true, the 8-digit integer is $r + 1$; otherwise $r$, formatted as `"DDD.DDDDD"`.
     - *Rationale*: Avoids IEEE-754 floating-point precision loss (`n * 10^10` can reach $10^{16} > \text{Number.MAX\_SAFE\_INTEGER}$) and guarantees deterministic half-up rounding (e.g. `850772 -> 922.37303`).
  2. **Square Roots Triangular Prefix-Digit Scoring (`k * (k + 1) / 2`, Stopping at First Mistake)**:
     - Named constants `SQUARE_ROOT_STOP_AT_FIRST_MISTAKE = true` and `SQUARE_ROOT_POINTS_BY_CORRECT_DIGITS = [0, 1, 3, 6, 10, 15, 21, 28, 36]` document that the rule was inferred from published Memoriad championship results and a simulator screenshot where 2 correct leading digits awarded 3 points, 6 awarded 21 points, and all 8 awarded 36 points (up to 360 total).
     - `activity_results` stores `correct` (number of fully correct 8-digit roots), `total` (`attempted`), `settings.score` (sum of triangular points), and `settings.digits_total` (sum of $k$).
  3. **Pure Step-Box State Machine (`js/stepBoxes.js`)**:
     - Multiplications uses a 16-state cyclic state $s \in [0..15]$ (`n = 8`): for $0 \le s \le 8$, the rightmost $s$ boxes are checked; for $9 \le s \le 15$, the leftmost $16 - s$ boxes are checked; clicking a box acts as `*` only if it is the next box in the sequence (`7 - s` while growing, `15 - s` while shrinking); `/` is a no-op.
     - Square Roots uses a bounded state $c \in [0..6]$ (`n = 6`): `*` (or clicking box $c$) checks the next box from the left; `/` (or clicking box $c - 1$) unchecks the rightmost checked box, with no wrap-around.
  4. **Stage Exit Modal Visibility Fix**:
     - `openStageModal` in `js/memoriadPlay.js` applies `.modal-backdrop.open.active` so the shared CSS rule `.modal-backdrop.open` (`opacity: 1; visibility: visible; pointer-events: auto`) displays the discard confirmation dialog immediately when **Exit** is clicked during Concentration or Stage.

---

## ADR-038: Phase 10b — Admin Daily To-Do Fixes (`daily_tasks`, `showToast` Signature, Polymorphic Section Targets in `js/todoForm.js`, and Student Deep Links)
- **Date**: 2026-10-25
- **Status**: Accepted
- **Context**:
  - Testers reported three issues on the Admin Daily To-Do page (`/pages/todos.html`, `js/todos.js`):
    1. **(a)** Saving a task showed only a toast saying `"error"`.
    2. **(b)** Task rows displayed `"Unknown Category"` when a task had no specific category.
    3. **(c)** The second modal dropdown (`"Category filter (optional)"`) showed only `"Any category in this section"` for every section except Basics and Round (`elements`, `memoriad`, `flash`).
- **Root-Cause Diagnosis**:
  1. **Wrong table name (`'todos'` instead of `'daily_tasks'`) + Reversed `showToast` arguments**:
     - `js/todos.js` queried `supabase.from('todos')`, whereas the PostgreSQL table is `public.daily_tasks` (`code: "PGRST205"`, `message: "Could not find the table 'public.todos' in the schema cache"`, `hint: "Perhaps you meant the table 'public.daily_tasks'"`).
     - In addition, `js/toast.js` defines `showToast(type, message, durationMs)`, but every call in `js/todos.js` passed `showToast(message, 'error')` backwards, causing `toast.js` to render `'error'` as the message text.
  2. **Silent fallback to `DemoDB.getTodos()` on load**:
     - When `supabase.from('todos').select('*')` failed on page load, `js/todos.js` caught the error and populated `allTodos = DemoDB.getTodos()`, whose fake demo IDs (`'cat-rnd-1'`, `'cat-bas-1'`) did not match real UUIDs in `allCategories`, causing `renderTodosTable()` to display `"Unknown Category"`.
  3. **Category-only dropdown logic**:
     - `updateCategoryDropdown` only filtered `categories` (which holds `'basics'` and `'round'` rows), ignoring `DRILL_CATALOG` for `'elements'` and the four Memoriad modules for `'memoriad'`.
- **Decisions & Rationale**:
  1. *Pure Form Normalization, Section Options, and Student Link Module (`js/todoForm.js`)*:
     - `normalizeTaskInput(input, section)` trims all text values, converts `""` to `null` for `category_id`, `activity_key`, and `level` (satisfying `daily_tasks` `CHECK` constraints that reject `level = ''` or both target columns set), validates `title` (`1..80` chars) and `level` (`<= 30` chars), sets `category_id` only for `'basics'`/`'round'`, `activity_key` only for `'elements'`/`'memoriad'`, and neither for `'flash'`.
     - `optionsForSection(section, categories, drillCatalog, memoriadModules)` returns strictly active section categories for `'basics'`/`'round'`, enabled drills from `js/drillCatalog.js` for `'elements'`, the 4 modules (`calendar`, `additions`, `multiplications`, `square_roots`) for `'memoriad'`, and `[]` for `'flash'`.
     - `taskLink(task)` computes the exact student deep link (`/pages/basics.html?cat=<id>`, `/pages/basics.html`, `/pages/round-scores.html`, `/pages/element-drill.html?drill=<key>`, `/pages/elements.html`, `/pages/memoriad-play.html?module=<key>`, `/pages/memoriad.html`, `/pages/flash.html`).
     - `formatTaskTarget(task, ...)` formats section-wide tasks as `"Any activity in <Section>"` so `"Unknown Category"` never appears.
  2. *Authoritative `todo_for(p_student)` RPC Completion Status*:
     - Task completion (`done`) continues to be evaluated exclusively by the PostgreSQL RPC `todo_for(p_student)` (never computed in browser JavaScript).

---

## ADR-039: Phase 10c — Admin Profile Editing & Audit Log (`js/profileForm.js`), English Month Calendar Date Formats, and Hiding Per-Category Time for Flat Rounds (`js/roundType.js`)

- **Date**: 2026-10-25
- **Status**: Accepted
- **Context**:
  - Phase 10c introduces three targeted enhancements:
    1. Admin profile editing (`full_name`, `level`, `leaderboard_visible`, `active`) and a **Change history** drawer (`profile_audit`) on `/pages/students.html` and `/pages/student-detail.html`.
    2. Two new English month-name date formats (`"DD Mon YYYY"` and `"DD-Mon-YYYY"`) for Memoriad Mental Calendar Dates (`js/memoriadFormat.js`, `js/memoriadPlay.js`).
    3. Hiding per-category time inputs and cells for Flat Rounds (`js/roundType.js`, `/pages/round-scores.html`, `js/roundScores.js`, `js/stats.js`, `js/dashboardComponents.js`).
- **Decisions & Rationale**:
  1. **Why `student_code` (Student ID) and `role` Cannot Be Edited from the Site**:
     - `student_code` is the student's login username and maps deterministically to the internal Supabase Auth synthetic email (`<student_code>@trendz.local`) created when the account is provisioned. Mutating `profiles.student_code` in-place from the frontend would desynchronize `profiles.student_code` from `auth.users.email`, breaking login and password resets.
     - `role` (`'student'` vs `'admin'`) governs Row-Level Security (RLS) and administrative privileges across every table and serverless endpoint. Allowing role elevation from the client profile form would create a privilege-escalation risk; a PostgreSQL trigger on `profiles` therefore rejects any application-level change to `student_code` or `role`.
     - Consequently, the Edit Profile modal displays `student_code` as read-only with the tooltip *"The student ID is the login name and cannot be changed here"*, omits `role` altogether, and sends a single `.update(changedFields)` containing only modified fields among `full_name`, `level`, `leaderboard_visible`, and `active`.
  2. **Why Flat Rounds Hide Per-Category Time Without Deleting Existing Stored Times**:
     - In a **Flat Round** (`isFlatRound(roundType) === true` when the trimmed, lower-cased round type starts with `"flat"`), students complete the entire competition paper under a single continuous stopwatch rather than timing each category separately. Only the round's overall **Total Time Taken** (`student_rounds.time_taken_seconds`) is meaningful.
     - Showing per-category `Time (mm:ss)` inputs during a Flat Round adds visual clutter and slows down score entry, and showing `—` on every category cell in the dashboard and student-detail score tables wastes vertical space.
     - However, if a student or teacher temporarily switches the Round Type dropdown between `"Category wise"` and `"Flat Round"`, or if a round already has historical category times stored in `results.time_seconds`, those stored values must never be erased or overwritten with `null`. Therefore, flat mode hides `.cell-time` via CSS on the entry screen, omits `time_seconds` from `results` insert/update payloads, and hides the per-category time line in score sheet cells while preserving the round's **Time Taken** summary row.


---

## ADR-040: Phase 10d — One-Way Readable Google Sheets Score-Sheet Mirror & Static Values Instead of Formulas

- **Date**: 2026-10-27
- **Status**: Accepted
- **Context**:
  - Teachers and administrators wanted a human-readable Google Spreadsheet (`MIRROR_SHEET_ID`) with one tab per active student laid out identically to the classic Jr. MCWC score sheets, both for quick inspection and as a familiar fallback during a website outage.
- **Decisions & Rationale**:
  1. **Why the Mirror Is Strictly One-Way (Website $\rightarrow$ Sheet)**:
     - Two-way synchronization between a free-form Google Sheet and a relational PostgreSQL database with Row-Level Security, teacher verification locks (`verified`, `corrected_by`), and audit trails (`result_audit`) introduces severe conflict-resolution hazards: accidental edits in Google Sheets could overwrite verified scores, bypass database constraints, or lose audit attribution.
     - Making the mirror strictly **one-way (website to sheet)** guarantees that PostgreSQL remains the single authoritative source of truth. During an outage, teachers follow the 4-step workflow in `/docs/OUTAGE-PLAN.md`: they make a copy of the mirror sheet (`File -> Make a copy`), record new rounds in the copy, export modified tabs as CSV when the website returns, and import them through `/pages/import.html` (which validates every cell and skips existing rounds automatically).
  2. **Why the Mirror Writes Static Values (`stringValue` and `numberValue`) Instead of Spreadsheet Formulas**:
     - Writing pre-computed values (`Final Score`, `Total Attempt`, `Marks TO BE CORRECTED`, `Time Taken`) as plain numbers and strings (`userEnteredValue.numberValue` / `userEnteredValue.stringValue`, never `formulaValue`) guarantees 100% parity with the database, prevents formula-injection vulnerabilities if student notes contain `=`, avoids Google Sheets recalculation overhead across dozens of student tabs, and ensures that exporting any tab to CSV round-trips cleanly through `parseScoreSheetCsv` (`js/importParser.js`).
  3. **Shared Colour Rule (`shared/scoreColors.js` Re-exported by `js/scoreColors.js`)**:
     - Centralizing the boundary logic (`0` wrong & `total > 0` $\rightarrow$ `green` `#00E000`; `1..10` wrong $\rightarrow$ `orange` `#FF9900`; `> 10` wrong $\rightarrow$ `cyan` `#00E5FF`; `total = 0` or no data $\rightarrow$ `null`) in `shared/scoreColors.js` ensures the website UI and the Google Sheets mirror never diverge.

---

## ADR-041: Phase 10e — Elements Worksheet Question Layout (`js/questionLayout.js`) & Non-Breaking Operators

- **Date**: 2026-10-27
- **Status**: Accepted
- **Context**:
  - In Elements Division drills (`divide_by_4`, `divide_by_7`), short prompts such as `"72 / 7"` wrapped inside `.element-question-row` at narrower column widths, dropping the divisor onto a second line below the dividend and slash.
- **Decisions & Rationale**:
  1. **Single Inline Question Span with Threshold `<= 18` Characters (`js/questionLayout.js`)**:
     - `questionLayout(text)` returns `'nowrap'` when the trimmed prompt is `18` characters or fewer and `'wrap'` when it is `19` characters or longer.
     - Short prompts render with `white-space: nowrap` and `font-variant-numeric: tabular-nums` inside a 3-part CSS Grid row (`question number`, `question text`, `fixed-width answer input`), guaranteeing that prompts like `"72 / 4"` and `"888 / 1554"` never split across lines.
     - Longer prompts (`days_to_seconds`, `"Jan. 10, 1700 - March 5, 1800"`) use `formatQuestionText(text)` to bind operators (`-`, `/`, `-->`) to their preceding token with `\u00A0` so line breaks only occur at spaces and never leave an operator alone on a line.

---

## ADR-042: Phase 10f — Replacing the Four Random Square/Cube Drills with Ten Staged Non-Repeating Range Drills

- **Date**: 2026-10-27
- **Status**: Accepted
- **Context**:
  - Previously, the Elements catalog had four Square and Cube drills (`squares_11_50`, `squares_51_100`, `cubes_11_50`, `cubes_51_100`) that sampled 50 random numbers with replacement from `11..50` or `51..100`. That left `1..10` unpractised, repeated some numbers multiple times in a single worksheet while skipping others, and jumped across too wide a difficulty gap (`11..50` vs `51..100`) for students learning squares and cubes incrementally.
- **Decisions & Rationale**:
  1. **Why Staged Non-Repeating Ranges Replace the Old Four Drills**:
     - Splitting `1..100` into four 25-number stages (`Stage 1: 1–25`, `Stage 2: 26–50`, `Stage 3: 51–75`, `Stage 4: 76–100`) plus a 100-question `Combined (1–100)` worksheet for both **Squares** and **Cubes** (10 drills total) lets students master one 25-number block at a time before attempting the full `1–100` combined sheet.
     - Because each stage generates **every integer in its range `[min..max]` exactly once** in Fisher-Yates shuffled order (`generateRangePowerSet` in `api/_drills.js`), a single attempt tests 100% of that stage's numbers with zero duplicates and zero gaps.
  2. **Why Question Counts and Time Limits Are Kept as Named Placeholder Constants in One Place (`js/drillCatalog.js`)**:
     - The question counts (`25` per stage, `100` combined) and time limits (`60s, 75s, 100s, 120s, 360s` for Squares; `90s, 110s, 130s, 150s, 480s` for Cubes) are initial teacher placeholders that may be tuned after classroom timing trials. Defining them as named constants (`SQUARES_STAGE_1_TIME_SECONDS`, `SQUARE_CUBE_STAGE_SPECS`, etc.) in `js/drillCatalog.js` and importing them directly into `api/_drills.js` guarantees a single source of truth between client and server.
  3. **Non-Destructive Archiving of Historical Results & Old To-Do Tasks**:
     - Historical `activity_results` rows with `squares_11_50`, `squares_51_100`, `cubes_11_50`, or `cubes_51_100` are never deleted or modified in the database. On history lists (`formatDrillHistoryName`, `recentSets`) they are displayed as `"<name> (old drill)"`, and `bestForDrill` excludes keys not in `DRILL_CATALOG` so old 50-question sets do not mix with the new 25-question or 100-question stage personal bests.
     - Any old `daily_tasks` row pointing to a removed `activity_key` resolves to `"Activity no longer available"` (`formatTaskTarget`, `isTaskActivityAvailable`) so neither the student dashboard nor the admin To-Do page ever breaks.

---

## ADR-043: Phase 10g — Timed Online Basics Practice (`mode: 'timed' | 'unlimited'`), Pool Sizing, and Questions-Per-Minute Target Evaluation

- **Date**: 2026-10-27
- **Status**: Accepted
- **Context**:
  - Previously, online Basics practice (`/pages/basics-practice.html`) asked students to pick a fixed number of questions (`10, 20, 30, 50, 100, 200`) and raced a stopwatch to finish that fixed set. In classroom coaching, however, students have different calculation speeds: a fixed 100-question set can take a beginner 6 minutes while a senior student finishes in 90 seconds. Teachers wanted standardized **time modes** (`30 seconds`, `1 minute`, `2 minutes`, `5 minutes`, and `Unlimited (stopwatch)`) where students answer as many questions as they can before the clock hits zero.
- **Decisions & Rationale**:
  1. **Why Time Modes Replace Fixed Question Counts**:
     - Fixed-duration sprints (`30s`, `60s`, `120s`, `300s`) give every student a predictable, bounded practice window and make speed comparisons (`correct per minute` and `attempted per minute`) directly comparable across durations.
     - Retaining `"Unlimited (stopwatch)"` (`mode: 'unlimited'`) alongside `"Timed"` (`mode: 'timed'`) lets students practice open-ended endurance sessions while keeping personal bests cleanly separated between `'timed'` and `'unlimited'` (`results.practice_mode`).
  2. **How Question Pools Are Sized (`50 / 100 / 200 / 500 / 1000`) & Non-Repeating Adjacency**:
     - Generating the entire pool on the server at `start` avoids per-question network round-trips during play while keeping expected answers strictly server-side in `drill_sessions`.
     - Pool sizes are set to `BASICS_TIMED_POOLS = { 30: 50, 60: 100, 120: 200, 300: 500 }` (equivalent to 100 questions/minute ceiling, 1.67 questions/second) and `BASICS_UNLIMITED_POOL = 1000` for stopwatch mode, with consecutive duplicate prevention (`q[i].text !== q[i-1].text`) so two identical questions never appear back-to-back.
     - When the countdown reaches zero (or the student clicks `Finish` early), the client submits only the prefix of questions actually reached (`answers.length = attempted`), excluding the question still on screen when the timer expired.
  3. **Why Targets Use `min_questions_per_minute` for Timed/Stopwatch Rounds (`results_with_target`)**:
     - A fixed `max_time_seconds` rule (e.g. `"time at most 2:00"`) only makes sense when every set has the same fixed question count. In timed rounds (`30s` to `5m`) and stopwatch rounds, speed is independent of round duration when measured as **questions per minute** (`total / (time_seconds / 60)`).
     - Adding optional `basics_thresholds.min_questions_per_minute` and evaluating `meets_target` authoritatively inside the PostgreSQL view `results_with_target` (checking `min_accuracy` and `min_questions_per_minute` when `practice_mode IS NOT NULL`, and `min_accuracy` and `max_time_seconds` when `practice_mode IS NULL`) guarantees that JavaScript never computes `meets_target` and that both new timed rounds and historical/typed entries are evaluated by their appropriate benchmark.
---

## ADR-044: Phase 11a — Today-First Student Home, Explicit IST Reporting Periods (`js/periods.js`), Six Round Entry States, Flash Anzan Last-Used Summary Card, Plain-Language Copy, and Excluding `js/demoDb.js` from Production Builds

- **Date**: 2026-10-28
- **Status**: Accepted
- **Context**:
  - A design and UX review identified several usability and clarity improvements across the student experience:
    1. Live login and student pages still included demo helper UI (`index.html` quick test credentials and setup guide modal), and `js/demoDb.js` (~60 KB of fake data) was bundled into the production Vite build even though demo mode is blocked in production.
    2. On `/pages/student.html`, the student's daily to-do tasks were buried below welcome links and large streak/milestone blocks, and task rows showed ambiguous `"Start"` buttons.
    3. Statistics mixed rolling 7-day windows (`last 7 days`) with Monday-to-Sunday calendar weeks (`this week`) and all-time totals without showing exact date ranges or visually separating this-week from all-time metrics.
    4. Student-visible copy contained internal technical jargon (`"Web Audio API"`, `"RPC"`, `"session"`, `"server"`, `"Database IST"`).
    5. On `/pages/round-scores.html`, category rows used a generic `"Unsaved"` badge and gave no granular lock reason (`verified`, `corrected by your teacher`, `older than 7 days`), no field-level inline validation, and no retry banner preserving typed inputs on network failure.
    6. On `/pages/flash.html`, the setup card placed the summary and Start button at the bottom of the form and repeated the seconds unit twice.
- **Decisions & Rationale**:
  1. **Production Bundle Exclusion of `js/demoDb.js` (`vite.config.ts` + `js/demoDbStub.js`)**:
     - During `vite build` (`command === 'build'`), a Rollup/Vite resolve alias redirects imports matching `/(^|\/)demoDb\.js$/` to `js/demoDbStub.js` (a tiny no-op module), while `vite dev` and `node --test` continue to resolve the real `js/demoDb.js` on `localhost`. This guarantees zero fake student names, codes, or mock data strings exist in the compiled `dist/` bundle.
  2. **Today-First Student Home Hierarchy & Explicit Task Buttons (`/pages/student.html`, `js/dashboardComponents.js`)**:
     - Ordering the student home page as **(1) Today header with IST date**, **(2) Today's plan (to-do tasks)**, **(3) One-row compact Streak card** with the note *"A streak counts any practice today; assigned tasks may still be pending."*, **(4) Three small 7-day metric cards** (`Accuracy`, `Speed` in questions/min, `Practice days` with exact `"Last 7 days: <d Mon> to <d Mon>"` labels), and **(5) One compact "Explore practice modes" card** before the detailed practice cards, score sheet, and charts puts daily action items first above the fold.
     - Giving each task a primary **"Practice online"** button and showing a secondary **"Log result"** button exclusively for `basics` and `round` tasks eliminates the ambiguity of two buttons both labelled `"Start"`.
  3. **Pure IST Period Formatting (`js/periods.js`) & Separation of This-Week vs All-Time Metrics**:
     - `formatWeekPeriod(todayStr)` (`"Mon 26 Oct to Sun 1 Nov"`) and `formatLast7DaysPeriod(todayStr)` (`"Last 7 days: 22 to 28 Oct"`) compute exact calendar windows in India time (`Asia/Kolkata`) from the database's `today_ist()` string.
     - Cards never mix `"Last 7 days"` with `"Mon ... to Sun ..."`, visually separate `"This week"` from `"All time"`, and explicitly distinguish `"No tries this week"` (`tries === 0`) from `"0 correct"` (`tries > 0 && correct === 0`) on both `/pages/student.html` and `/pages/student-detail.html`.
  4. **Six Explicit Round Entry States & Non-Destructive Error Recovery (`/pages/round-scores.html`, `js/roundScores.js`)**:
     - Every category row displays one of six exact status chips: `"Not entered"`, `"Edited - not saved"`, `"Saved"`, `"Locked (verified)"`, `"Locked (corrected by your teacher)"`, or `"Locked (older than 7 days)"`, paired with a one-sentence explanation under the round header, read-only disabled styling + reason tooltip on locked rows, inline field validation (`correct <= total`, no negative numbers), a live `"n unsaved changes"` counter, confirmation before leaving with unsaved edits, and an alert (`role="alert"`) with a **"Try again"** button that preserves all typed values if saving fails.
  5. **Flash Anzan Top Last-Used Summary Card (`/pages/flash.html`, `js/flash.js`)**:
     - Placing `"Last used: 1 digit - 10 numbers - 1.0 s - add"` with a primary **Start** button at the top of the setup card lets returning students start immediately with one click while keeping custom controls directly visible below (preserving ADR-030: no presets).

---

## ADR-045: Phase 12a — Daily Tasks with Required Count (`required_count`), Progress Display (`js/todoProgress.js`), Cutover Start Date (`todo_streak_start`), and Nightly Day Finalization (`todo_finalize`)

- **Date**: 2026-10-28
- **Status**: Accepted
- **Context**:
  - Previously, each daily task in `daily_tasks` was satisfied by a single completed attempt (`done: boolean`), and any single practice entry on a calendar day counted toward the student's daily streak regardless of whether the student finished their assigned daily plan.
  - Teachers needed:
    1. A per-task `required_count` (`1..50`, default `1`) so a single task can require multiple rounds, sets, or tries per day (e.g. `4` rounds of `1d4r` or `3` sets of `Day Codes`), with clear progress (`"2 of 4"`, progress bar, `"n of m tasks done today"`) on the student and teacher dashboards.
    2. A stricter streak rule where a day counts for the streak only when **all** of that day's assigned tasks are done (or any practice when the student has no tasks assigned that day).
- **Decisions & Rationale**:
  1. **Why the Streak Requires All Assigned Tasks**:
     - Counting a day toward a student's streak after just one quick try allowed students to keep a streak alive while leaving most of their assigned daily curriculum unfinished. Requiring all assigned tasks for the day (`done_count >= required_count` for every assigned task) aligns the daily streak reward directly with completing the teacher's daily training plan, while still allowing any practice to count on days when a student has zero assigned tasks.
  2. **Why the Rule Has a Configurable Start Date (`competition_settings` key `'todo_streak_start'`)**:
     - Applying the new all-tasks rule retroactively to historical dates would break existing students' streaks for past days when they practised under the old rule ("any practice counts") or before current tasks were assigned.
     - Storing a cutover date in `competition_settings` (`todo_streak_start`, `YYYY-MM-DD`, configurable on `/pages/competition.html`) lets the database (`streak_for`) evaluate days before `todo_streak_start` under the historical rule and days on or after `todo_streak_start` under the all-tasks rule, ensuring zero retroactive streak penalties.
  3. **Why Finished Days Are Stored Nightly (`todo_finalize` -> `daily_todo_log`)**:
     - Teachers edit `daily_tasks` over time (changing `required_count`, adding new tasks, deactivating old ones, or promoting students to a new level). If historical streak evaluation re-queried live `daily_tasks` for past dates, editing a task today would retroactively alter whether yesterday or last week counted as completed.
     - Calling `supabase.rpc('todo_finalize')` with the service role at the start of every backup run in `/api/backup.js` (both nightly cron at ~2:00 AM IST and manual runs, wrapped so an error never aborts the backup) snapshots each finished day into `daily_todo_log`. The admin To-Do form also reminds teachers: *"Changes apply from today. Avoid editing tasks between midnight and 3 AM."*
  4. **Strict Database Authority for Counts & Streak Status (`todo_for`, `streak_for`, `js/todoProgress.js`)**:
     - JavaScript never computes `done_count`, `done`, or `active_today`. `js/todoProgress.js` formats `progressText(done_count, required_count)` (clamped to at most `required_count`, e.g. `"4 of 4"` when 5 are done), `percent(done_count, required_count)` (capped at `100`), and `summary(tasks)` (`"n of m tasks done today"` strictly from `task.done === true`).

---

## ADR-046: Phase 12b — Daily To-Do Leaderboard Counting Completed Days and Admin-Switchable Global Leaderboard Scope (`js/leaderboardView.js`)

- **Date**: 2026-10-28
- **Status**: Accepted
- **Context**:
  - Phase 12b adds a fifth leaderboard tab (**Daily To-Do**, `board = 'todo'`) alongside a two-option scope switch (`<student's level> (your level only)` vs `Global (all trainees)`) on `/pages/leaderboard.html` and an admin control (`competition_settings` key `'global_leaderboard'`, `'on'` or `'off'`) on `/pages/competition.html`.
- **Decisions & Rationale**:
  1. **Why the Daily To-Do Leaderboard Counts Completed Days Rather Than Tasks**:
     - Different levels (and institute-wide assignments) have different numbers of daily tasks and different `required_count` multipliers. If the leaderboard counted raw tasks or rounds completed, students in levels with more assigned tasks would automatically outrank students in levels with fewer assigned tasks even when both completed 100% of their daily plan.
     - Counting the **number of days** in the selected period (`week`, `month`, `all`) on which the student finished **every** assigned task of that day (for days with at least one task, including today when everything is done so far) puts every level on an equal footing: every student can earn at most 1 day per calendar day, whether comparing within their own level or on the global board.
  2. **Why the Global Leaderboard Is Switchable (`competition_settings` key `'global_leaderboard'`)**:
     - Comparing across all trainees (`p_scope = 'global'`) motivates students institute-wide, especially on consistency boards (`streak`, `practice_days`, `todo`). However, during certain training blocks or exam seasons, teachers may prefer students to compare strictly within their own level cohort (`p_scope = 'level'`).
     - Providing an admin switch (`global_leaderboard` = `'on'` | `'off'`) backed by `global_leaderboard_enabled()` and server-side enforcement in `leaderboard(..., p_scope)` lets administrators enable or disable global visibility at any time without code changes. When switched off, the client hides the Global option and, if a request fails with `"The global leaderboard is switched off."`, displays the message and falls back automatically to the student's own level.
     - *Future Option*: Currently the global switch applies across all five boards; if an institute later wants certain boards (such as `points`) to remain level-only while consistency boards (`streak`, `todo`) allow global scope, per-board scope configuration can be added as a later option.

---

### Decision 34: Online & Offline Weekly Tests, Single-Attempt Section Lock, and 30-Day Removal Snapshot (Phase 13a)
- **Date**: 2026-10-30
- **Context**:
  - Phase 13a introduces two weekly test types (`'offline'` where the trainer enters scores and `'online'` where students take timed Basics sections on the website), an admin results and section reset table for online tests, a student Weekly Test page (`/pages/weekly-test.html`) + Home prompt card, and a 30-day reversible `"Remove this test"` flow (`admin_remove_weekly_test` / `admin_restore_weekly_test`).
- **Decisions & Rationale**:
  1. **Authoritative Database Eligibility Check (`weekly_test_check`) & Single-Attempt Lock (`weekly_test_attempts`)**:
     - Before starting any online weekly test section, `/api/weekly-test.js` calls `weekly_test_check(p_test, p_student, p_category)` with the service role and never re-implements eligibility, level filtering, or India-time open/close window rules in JavaScript.
     - Immediately after `weekly_test_check` succeeds, the server inserts a row into `weekly_test_attempts` (`status = 'started'`, unique per `(test_id, student_id, category_id)`). Because the attempt row is created at `start` time rather than `submit` time, refreshing or leaving the page mid-section cannot be used to preview questions and restart for a fresh pool. If any server step after inserting the attempt row fails during `start`, the server deletes that newly created attempt row so the student is not locked out by a server error.
     - If a student has a genuine connection drop or device issue, an administrator can click **Reset** on that student's section cell in `/pages/weekly-tests.html`, which deletes both the `weekly_test_attempts` row and the matching `weekly_test_scores` row so the student can take that section again.
  2. **Reusing the Phase 10g Timed Basics Engine (`/api/_drills.js` & `js/drillPlayer.js`)**:
     - Online weekly test sections reuse the exact Basics category generator (`generateBasicsSet`, `stripBasicsExpected`, pool sizes `30 -> 50`, `60 -> 100`, `120 -> 200`, `300 -> 500`), grading logic (`checkTimedBasicsSubmission`), and one-question-at-a-time countdown player (`createDrillPlayer`, `computeRemainingSeconds`). When `attempted === 0`, the attempt is marked `'submitted'` and no score row is inserted into `weekly_test_scores`.
  3. **30-Day Reversible Test Removal (`weekly_test_removals`)**:
     - Rather than permanently destroying a weekly test on accidental deletion, `admin_remove_weekly_test(p_test, p_reason)` snapshots the test, its sections, attempts, and scores into `weekly_test_removals` for 30 days and removes the live rows (automatically updating points, leaderboards, and reports that read `weekly_test_scores`). Administrators can inspect and restore any removed test within 30 days via the **Recently removed** drawer (`admin_restore_weekly_test(p_removal)`).

---

### Decision 35: Live-Derived Student Weekly Test Reminders, Stage-Based Dismissal (`my_notifications` / `dismiss_notification`), and Why There Is No Scheduled Job or Push Notification Yet (Phase 13b)
- **Date**: 2026-10-30
- **Context**:
  - Phase 13b adds a student **Notifications** tab (`/pages/notifications.html`), a top-nav bell icon with a 60-second `sessionStorage` cached count badge (`js/notificationBadge.js`), a compact 3-item reminder strip on Student Home (`/pages/student.html`), and an admin **Announcements** & **Upcoming tests** page (`/pages/announcements.html`) with one-click WhatsApp/clipboard sharing (`js/reportMessage.js`).
- **Decisions & Rationale**:
  1. **Why Weekly Test Reminders Are Derived Live Instead of Stored and Sent by a Scheduled Job**:
     - If reminders were pre-generated into a notification queue table by a daily cron job, any teacher edit to a weekly test (changing `test_date`, `title`, `audience_level`, `remind_days_before`, or removing/restoring the test) or any student completing all sections of an online test on test day would leave stale or inaccurate reminder rows behind until the next reconciliation job.
     - By computing reminders on the fly inside `my_notifications()` whenever the student opens the site (and caching the badge count in `sessionStorage` for 60 seconds), reminders always reflect the exact current database state in Indian Standard Time (`Asia/Kolkata`) with zero cron infrastructure, zero background worker cost, and zero stale notification cleanup.
     - Dismissal is tracked by stage-qualified reference (`test:<id>:upcoming`, `test:<id>:tomorrow`, `test:<id>:today` and `ann:<id>` via `dismiss_notification(p_ref)`). If a student dismisses an early `'upcoming'` reminder (`2+` days left), the reminder automatically reappears when the stage advances to `'tomorrow'` and again on `'today'`, and disappears automatically on test day as soon as the student finishes all online sections.
  2. **Why There Is No Web Push or Automated WhatsApp Messaging Yet**:
     - Browser Web Push requires Service Worker registration, VAPID key management, per-device subscription storage, and persistent OS notification permission prompts—which are frequently blocked on shared family tablets or school browsers and add operational complexity.
     - Automated WhatsApp delivery requires a paid WhatsApp Business API template approval workflow and storing parent/student phone numbers (increasing PII surface). Instead, trainers use the **Upcoming tests (next 14 days)** panel on `/pages/announcements.html` to click **Share on WhatsApp** (`https://wa.me/?text=<encoded>`) or **Copy text** (`buildWeeklyTestShareMessage` in `js/reportMessage.js`) and paste directly into their existing class WhatsApp groups—storing zero phone numbers while giving trainers full control.

