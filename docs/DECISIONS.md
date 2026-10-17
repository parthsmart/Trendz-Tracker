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
