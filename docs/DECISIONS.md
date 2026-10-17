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

### ADR-006: Interactive Local Demo Mode Fallback
- **Date**: 2026-10-17
- **Context**: Before a user configures their personal Supabase project, they need to preview, evaluate, and test the entire UI (admin roster, modal dialogs, category reordering) inside development and review environments without encountering broken screens or blocking crashes.
- **Options Considered**:
  1. *Blocking Error Screen*: Displaying a red screen saying "Configuration Missing" until keys are provided.
  2. *Silent Failure*: Leaving forms unresponsive.
  3. *Interactive Demo Mode Fallback*: If placeholder credentials are detected in `js/config.js`, an in-browser storage layer (`DemoDB`) provides realistic sample students, the 24 championship categories, and quick login helpers with an informative banner. As soon as real keys are supplied, it automatically connects to live Supabase.
- **Choice**: Interactive Demo Mode Fallback.
- **Reason**: Provides an immediate, functional preview while making it obvious how and where to configure live production credentials.
- **Trade-off**: Requires maintaining a small mock data store in `js/supabaseClient.js`.
- **Rejected Options**: Blocking error screens, silent failures.

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
