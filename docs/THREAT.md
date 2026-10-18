# Threat Modeling & Security Posture

This document models the security boundaries of **Trendz Tracker**, analyzing realistic threat actors, potential abuse vectors, active technical controls, and an honest disclosure of known architectural gaps.

---

## 1. Threat Actor Matrix

| Actor | Worst Realistic Abuse | Technical Control Stopping It | Defense Layer |
| :--- | :--- | :--- | :--- |
| **Anonymous Visitor** | Attempts to read student rosters, scrape children's names, or inject fraudulent practice scores. | PostgreSQL Row Level Security (RLS) rejects unauthenticated reads/writes on all sensitive tables (`profiles`, `results`, `rounds`). Frontend route guards redirect immediately to `/index.html`. | Database (RLS) & Client Guard |
| **Enrolled Student** | Attempts to view a classmate's scores, manipulate leaderboard times, forge "verified" teacher approvals, or access the admin student roster (`/pages/admin.html`). | 1. RLS policy `student_id = auth.uid()` makes classmates' rows invisible at the database level.<br>2. RLS `WITH CHECK` prohibits setting `verified = true`.<br>3. `guard.js` blocks student navigation to admin views.<br>4. Serverless functions `/api/*` verify `role = 'admin'` via JWT. | Database (RLS) & Serverless Auth |
| **Compromised Student Account** | Malicious actor obtains a student's ID and password and alters that specific student's unverified practice history. | 1. Blast radius is strictly constrained to that single student's unverified rows.<br>2. Historical verified competition scores cannot be modified or deleted.<br>3. Teacher can instantly reset the password and deactivate the account via Admin console. | Database (RLS) & Admin Tools |
| **Attacker with Leaked Anon Key** | Attacker extracts `SUPABASE_ANON_KEY` from `js/config.js` and issues direct PostgREST API requests via cURL or Postman to dump the database. | The `anon` key is designed to be public; it grants zero administrative power. Every REST request through the Supabase API still evaluates RLS policies. Without a valid authenticated user JWT, the attacker receives empty datasets. | Database (RLS Engine) |
| **Attacker with Leaked Service Role Key** | Attacker obtains `SUPABASE_SERVICE_ROLE_KEY` from server environment variables. | **Complete system compromise.** The service role key bypasses Row Level Security. | Server Isolation & Secrets Management |
| **Rogue or Compromised Admin** | Instructor creates illegitimate accounts or deactivates active students. | Actions are constrained by audit logs in Supabase Auth. However, genuine admins have broad authority by design. | Platform Audit Trails |

---

## 2. Deep Dive: Key Defense Mechanisms

### A. The `is_admin()` Security Definer Invariant
A notorious flaw in Supabase RLS policies is **recursion**: querying `profiles` inside a policy on `profiles` causes an infinite loop.  
To prevent this, `is_admin()` runs with:
```sql
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' AND active = true 
     FROM public.profiles 
     WHERE id = auth.uid()),
    false
  );
$$;
```
- `SECURITY DEFINER` executes the lookup with system privileges, bypassing RLS recursion.
- `SET search_path = public` prevents schema poisoning / path hijacking attacks.
- `active = true` ensures that if an admin account is deactivated, all admin privileges immediately terminate.

### B. Two-Factor Verification on Administrative API Calls
The serverless functions in `/api/create-student.js` and `/api/reset-password.js` never trust client parameters alone:
1. They extract and cryptographically verify the caller's JWT with `supabase.auth.getUser(token)`.
2. They query `public.profiles` to confirm the caller's `role` is `'admin'`.
3. Only if both checks pass does the handler invoke `supabaseAdmin.auth.admin`.

---

## 3. Known Architectural Gaps (Honest Disclosure)

1. **Brute-Force Risk on Short Student IDs**:
   - *Risk*: Student IDs (e.g. `STU101`) follow an easily guessable pattern. If weak passwords (e.g. `123456`) are chosen, an attacker could attempt dictionary attacks against the Supabase Auth login endpoint.
   - *Mitigation in Place*: The student creation tool generates randomized passwords by default.
   - *Future Recommendation*: Enable IP-based rate limiting on Supabase Auth or add a Cloudflare Turnstile CAPTCHA to `/index.html`.

2. **No Rate-Limiting on Vercel Serverless Endpoints**:
   - *Risk*: An authenticated admin could theoretically flood `/api/create-student` with requests, exceeding Supabase API quotas.
   - *Mitigation in Place*: Endpoints require valid admin JWTs.
   - *Future Recommendation*: Add Upstash Redis rate-limiting middleware to `/api/*`.

3. **Backdating Practice Entries**:
   - *Risk*: A student attempts to falsify historical consistency streaks or claim they practiced weeks ago by forging past dates in API payloads.
   - *Mitigation in Place*: Strictly capped at the database level. The database trigger on `results` intercepts all inserts/updates and rejects any row with `entry_date < today_ist() - INTERVAL '7 days'` or `entry_date > today_ist()`, throwing an explicit PostgreSQL error. Browser clock manipulation is futile because `entry_date` defaults to `today_ist()`.
   - *Known Gap*: Students can still backdate up to 7 days into the past for speed basics drills.

4. **Inflated / Falsified Typed Scores**:
   - *Risk*: Students type fraudulent scores (e.g. 50/50 correct in 10 seconds for Square Roots) to appear top-ranked.
   - *Mitigation in Place*: The `verified` boolean flag. In Phase 2, student entered scores are saved with `verified = false`. Only an instructor can inspect and mark a round `verified = true`. Once verified, rows are locked read-only by RLS policies (`WITH CHECK (verified = false)` for students).
   - *Known Gap*: Until photo verification, physical worksheet scanning, or teacher sign-off is implemented in future phases, raw practice metrics are unverified self-reported entries.

5. **Deactivated Student Accounts**:
   - *Risk*: A student who has left the institute or whose account has been suspended tries to log in or enter scores.
   - *Mitigation in Place*:
     - `auth.js` verifies `profile.active === true` on login and immediately terminates the session if false.
     - `public.is_admin()` checks `active = true`, immediately revoking administrative privileges if an admin account is deactivated.
     - RLS policies on `profiles` and `results` respect user active status.
     - Deactivated students cannot submit or alter scores.

6. **Junk Entries Keeping a Streak Alive**:
   - *Risk*: A student can submit nominal junk entries (e.g. 0/1 correct in 1 second, or repeated empty clicks) simply to trigger `active_today = true` and preserve their streak without engaging in genuine championship abacus practice.
   - *Mitigation in Place*: Stored procedures record activity authoritatively; instructors can view daily attempts and identify anomalous 0-second entries.
   - *Known Gap*: The current database `streak_for` RPC checks for the presence of any result entry on that calendar date. Future phases can enforce minimum category completion counts, time thresholds, or teacher verification flags.

7. **Students Can Edit Their Unverified Scores**:
   - *Risk*: Before an instructor reviews practice rounds and sets `verified = true`, students possess RLS permissions to edit, update, or overwrite their unverified score rows (`verified = false`). A student could modify past drills or adjust scores after the fact.
   - *Mitigation in Place*: Once an instructor verifies a round (`verified = true`), RLS policies permanently revoke student write permissions on those rows.
   - *Known Gap*: Prior to instructor verification, unverified practice history relies on student honesty.

8. **Resource Links Point to Third-Party Sites**:
   - *Risk*: The Learning Resources section contains external links to competition guidelines, worksheets, and study guides. If an external domain expires, is hijacked, or alters content, students could be exposed to broken links or malicious third-party content.
   - *Mitigation in Place*:
     - The browser input and database schema enforce a strict `CHECK (url ~* '^https?://')` constraint, completely preventing protocol smuggling (e.g. `javascript:`, `data:`, `file:` URIs).
     - All external links render with `target="_blank"` and `rel="noopener noreferrer"` to prevent window opener hijacking and protect student referrer privacy.
   - *Known Gap*: Teachers must manually verify that external resource domains remain active and safe.

9. **Server-Side Request Forgery (SSRF) & Reverse Proxy Abuse**:
   - *Risk*: An attacker attempts to exploit `/api/supabase-proxy` as an open proxy or SSRF vector to scan internal institute networks, exfiltrate cloud metadata (e.g. `http://169.254.169.254`), or target phishing servers using spoofed domains (e.g., `https://<your-project-ref>.supabase.co.evil.example/` or userinfo credentials `https://<your-project-ref>.supabase.co@evil.example/`).
   - *Mitigation in Place*:
     - **Exact Origin Match**: Target URL is parsed strictly using `new URL()`. The protocol must be `https:`, and `url.origin` must strictly and identically match the origin of the configured `SUPABASE_URL`.
     - **No Credentials / Userinfo**: URLs with embedded usernames or passwords (`url.username`, `url.password`) are rejected with HTTP 403.
     - **Path Whitelist**: Only paths starting with `/rest/v1/`, `/auth/v1/`, and `/storage/v1/` are allowed.
     - **Method Whitelist**: Only `GET`, `POST`, `PATCH`, `PUT`, `DELETE` are permitted.
     - **Header Filter**: Only `apikey`, `authorization`, `content-type`, `accept`, `prefer`, and `x-client-info` are forwarded.
     - **Disabled in Production**: When `VERCEL_ENV === 'production'`, the proxy returns HTTP 404 immediately. Production clients communicate directly with Supabase via browser `fetch()`.

10. **Demo Mode Bleed into Production Deployments**:
    - *Risk*: If an application is deployed to production with unconfigured or placeholder credentials, mock data and demo credentials (`STU101`, `ADMIN01` / `admin123`) might be mistakenly used by end users, or give the illusion of successful account creation or password updates.
    - *Mitigation in Place*:
      - `isDemoAllowedHost()` strictly restricts Demo Mode to `localhost`, `127.0.0.1`, and `run.app`.
      - On any production hostname, `checkProductionConfigLock()` immediately replaces the entire document body with a full-page "Configuration error - Please contact the administrator" screen.
      - `loginWithStudentId()` and administrative API calls (`createStudent`, `resetStudentPassword`, `toggleStudentActive`) strictly throw configuration errors on production hostnames when unconfigured, preventing any mock success.

11. **Admin Overview Cross-Student Aggregation Exposure (`public.admin_overview()`)**:
    - *Risk*: A malicious student or unauthenticated visitor executes `supabase.rpc('admin_overview')` directly from browser console or Postman to scrape all students' codes, full names, active streaks, daily completion status, and 7-day accuracies.
    - *Mitigation in Place*:
      - **Database Enforcement**: The PostgreSQL stored procedure `admin_overview()` executes with strict security validation: `IF NOT public.is_admin() THEN RAISE EXCEPTION 'Access denied: Admins only'; END IF;`. Students and anonymous requests are rejected at the database level regardless of client code tampering.
      - **Client Route Guard**: `pages/admin.html` enforces `requireAuth(['admin'])`, redirecting unauthorized roles immediately to `/pages/student.html` or `/index.html`.
      - **Read-Only Scope**: The overview RPC returns summary monitoring metrics only; it does not expose passwords, session tokens, or sensitive administrative keys.

12. **Student Edits Are Not Logged in `result_audit` (Phase 4a Gap)**:
    - *Risk*: While students can only edit their own unverified, uncorrected rows, multiple student edits or iterative re-saves of unverified scores do not generate immutable change history snapshots in `result_audit`.
    - *Why this gap exists*: The `result_audit` table is reserved specifically for administrative actions (`verify`, `unverify`, `flag`, `unflag`, `correct`, `delete`, `admin_insert`) to ensure accountability and audit trails for instructor changes. Logging high-frequency keystroke/row mutations by students during daily practice drills would balloon storage unnecessarily.
    - *Mitigation in Place*: Once an admin verifies or corrects an entry, the row is permanently stamped and locked, preventing any subsequent student mutations.

13. **Administrators Are Trusted (Phase 4a Gap)**:
    - *Risk*: Authenticated teachers and institute admins have authority to mark sessions, verify entries, flag scores, and execute corrections. A rogue or negligent administrator could mark inaccurate attendance or incorrectly modify a student's score.
    - *Why this gap exists*: Abacus mental arithmetic coaching requires teachers to hold authoritative grading discretion over student competition papers and drill sheets.
    - *Mitigation in Place*: Every administrative mutation is logged to `result_audit` with `changed_by`, `changed_at`, `action`, `old_values`, `new_values`, and mandatory `reason` text (>= 3 chars for corrections). Audit history cannot be altered or deleted by admins from the application.

14. **Unmarked Students Are Invisible to Attendance Percentage (Phase 4a Gap)**:
    - *Risk*: If a teacher creates an attendance session and leaves some active students unmarked (neither Present, Absent, nor Excused), those students are not factored into the `attendance_summary` calculation.
    - *Why this gap exists*: The mathematical contract defined in `attendance_summary(p_student, p_from, p_to)` calculates `attendance_pct = (present_count / (present_count + absent_count)) * 100.0`. A student with no record in `attendance` for a session has neither a present nor an absent count incremented, so the unrecorded session does not lower their percentage.
    - *Mitigation in Place*:
      - The admin attendance dashboard actively calculates and displays an `Unmarked` counter on each session card.
      - When saving an attendance session with unmarked active students, a prominent confirmation warning modal alerts the teacher: *"There are N active students without an attendance mark. Unmarked students will not be recorded."*





