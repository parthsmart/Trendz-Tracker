# System Constraints & Invariant Rules

These constraints are **hard, non-negotiable rules**. They govern all current and future phases of Trendz Tracker.  
**Any developer or AI assistant MUST STOP and ask the owner before breaking or modifying any rule in this document.**

---

### 1. Protection of Children's Data & Privacy
- **Rule**: Never collect, store, or transmit unnecessary personally identifiable information (PII) from children.
- **Enforcement**: Only minimal student data is permitted in the database:
  - Student Code (e.g. `STU101`)
  - Full Name (e.g. `Aarav Sharma`)
  - Abacus Level (e.g. `Level 3`)
- **Prohibitions**: Never ask for or store phone numbers, home addresses, dates of birth, personal email addresses, photographs of minors, or parent financial information.

---

### 2. Zero Secret Keys in Browser Code
- **Rule**: The Supabase Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`) must **NEVER** enter client-side browser code, Git repositories, or front-end configuration files.
- **Enforcement**:
  - `js/config.js` may ONLY contain the public Supabase URL and the public `anonKey`.
  - The Service Role Key lives **exclusively** in server-side environment variables on Vercel or a secure backend environment.
  - Any administrative action requiring elevated privileges (such as creating users or resetting passwords) must be routed through server-side serverless functions (`/api/*`) that verify the caller's JWT role first.

---

### 3. Strict Student Row Isolation
- **Rule**: Students must **NEVER** be allowed to read, inspect, query, or mutate another student's practice records, scores, or personal profile.
- **Enforcement**:
  - Row Level Security (RLS) on `profiles`, `results`, and `activity_results` strictly restricts read and write operations to:
    ```sql
    student_id = auth.uid() OR public.is_admin()
    ```
  - Future leaderboard features must be built via a dedicated, secure PostgreSQL `SECURITY DEFINER` function that returns only aggregated ranks and display aliases, never raw profile rows or individual practice logs.

---

### 4. Row Level Security Invariant
- **Rule**: Row Level Security (RLS) must remain enabled on **EVERY** table in the `public` schema at all times.
- **Prohibitions**:
  - Never execute `ALTER TABLE ... DISABLE ROW LEVEL SECURITY;`.
  - Never add a permissive policy (e.g. `USING (true)`) to `results`, `activity_results`, or `profiles`.
  - Never bypass RLS in client-side code.

---

### 5. Verified Score Immutability
- **Rule**: Students cannot modify or delete scores that have been marked as `verified = true` by an instructor, nor can students set their own scores to `verified = true`.
- **Enforcement**:
  - The RLS `WITH CHECK` and `USING` policies on `results` enforce `verified = false` for student updates and inserts.
  - Only administrators (`is_admin() = true`) have permission to alter the `verified` boolean flag.

---

### 6. Dependency Discipline
- **Rule**: **No new dependencies** (npm packages or external CDN script tags) may be introduced without explicit written approval from the owner.
- **Enforcement**:
  - Client-side code remains plain vanilla HTML5, CSS3, and modern ECMAScript modules.
  - The only external client library permitted is the official Supabase JavaScript SDK, pinned to a specific version (`@supabase/supabase-js@2.49.1`).
  - No CSS frameworks (such as heavy third-party UI bundles), no React/Vue/Svelte runtimes, and no telemetry/tracking scripts.

---

### 7. Historical Data Preservation (No Hard Deletes)
- **Rule**: Categories and student accounts that have recorded practice or tournament scores must never be permanently deleted from the database.
- **Enforcement**:
  - Use soft deactivation (`active = false`).
  - Deactivating a category hides it from new practice pickers while keeping historical tournament spreadsheets and trend analyses intact.
