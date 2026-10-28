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
      - **Production Bundle Exclusion (`Phase 11a`)**: During `vite build`, `vite.config.ts` aliases `js/demoDb.js` to a tiny empty stub (`js/demoDbStub.js`), ensuring zero fake student records or mock RPC data are shipped in the compiled `dist/` bundle. Quick test credential buttons and the setup guide modal are also removed from `/index.html` and live student pages.
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

15. **Malformed or Malicious CSV Files in Score Sheet Import Preview (Phase 4c-1)**:
    - *Risk*: A user selects an oversized file (causing browser tab memory exhaustion) or a crafted CSV containing HTML/script payloads (`<script>`, `<img onerror=...>`) inside student names, category names, round headers, or Surprise Task notes to trigger Cross-Site Scripting (XSS) in the admin console.
    - *Mitigation in Place*:
      - **Strict File Type & 2 MB Size Gate**: `js/import.js` rejects non-`.csv` files and any file larger than `2,097,152` bytes (2 MB) before reading.
      - **In-Browser Read Only**: Files are read locally via `FileReader.readAsText()` and never uploaded to any server endpoint.
      - **Strict `textContent` Rendering**: Every string originating from the CSV file (names, level labels, block hints, categories, dates, scores, times, notes, and stray values) is rendered exclusively via `document.createElement()` and `.textContent`, never `innerHTML`.
      - **Zero Database Writes in Phase 4c-1**: The preview step performs no `INSERT`, `UPDATE`, `DELETE`, or write RPC calls.

16. **Leaderboard Score Inflation & Same-Level Peer Data Exposure (Phase 5a Disclosure)**:
    - *Practice, Streak, and Most Improved Boards Use Student-Typed Scores*:
      - **Risk**: The `practice_days`, `streak`, and `improved` boards aggregate daily practice entries (`public.results`) entered by students. Because students can type unverified scores for up to 7 days back, a student could inflate their practice day count, streak, or week-over-week accuracy gain prior to teacher review.
      - **Mitigation**: Teachers can inspect, flag, or correct suspicious entries on `/pages/review.html` and can immediately hide any student from all leaderboards using the **"Show on leaderboards"** toggle (`profiles.leaderboard_visible = false`) on `/pages/students.html`.
    - *Points Board Uses Admin-Entered Data Only*:
      - **Control**: The `points` board is computed exclusively from teacher-entered `weekly_test_scores` and teacher-marked `attendance` (`status = 'present'`). Students have zero write access to either table, making the Points board immune to student-typed score inflation.
    - *Same-Level Peer Visibility (Display Name + One Number)*:
      - **Disclosure**: Calling `leaderboard()` exposes the formatted `display_name` (`first_name_initial` e.g. `"Aarav S."` or `student_code` e.g. `"STU101"`) and **one aggregate number** (`value` and `rank`) for top-10 peers in the **same level** to authenticated students in that level.
      - **Protections**: Full names (`full_name`), internal `student_id` UUIDs (`NULL` for students), raw test/practice scores, students from other levels, hidden students (`leaderboard_visible = false`), and ranks below #10 (except the caller's own row) are never exposed to students.

17. **Elements Timed Worksheet Answer Scraping, Replay & Speed-Bot Submissions (Phase 8)**:
    - *Risk*: A student inspects browser DevTools network responses to view expected worksheet answers before submitting, replays a `submit` request multiple times to duplicate `activity_results` rows, scripts instant 0-second submissions, or spams `start` requests to flood `drill_sessions`.
    - *Mitigation in Place*:
      - **Server-Only Answer Retention**: `api/_drills.js` generates questions and expected answers inside `POST /api/drill` (`action: 'start'`), stores `expected` in `public.drill_sessions` using the service role (inaccessible to students under RLS), and strips all expected answers via `buildDrillStartResponse` before returning `{ session_id, drill, title, time_limit_seconds, hint, questions }` to the browser.
      - **Hourly Rate Limit (60 Sets / Hour)**: `action: 'start'` counts rows in `drill_sessions` for `(student_id, activity_type = 'element')` with `started_at >= now() - 1 hour` and rejects requests exceeding 60 sets with HTTP 429 (`"You have started too many drills this hour. Take a short break and try again."`).
      - **Atomic Single-Use Session Locking**: `action: 'submit'` performs an atomic conditional update `UPDATE drill_sessions SET status = 'submitted', submitted_at = now() WHERE id = session_id AND student_id = caller.id AND status = 'open'`. Concurrent or replayed submissions match 0 rows and are rejected (`"This drill was already submitted."`).
      - **Expiry & Minimum Human Speed Enforcement**: Submissions arriving after `expires_at` (`started_at + time_limit_seconds + 30s`) are rejected as expired, and submissions where `elapsed < attempted * 0.25` seconds are rejected (`"That was faster than possible. Please answer the questions yourself."`) without writing to `activity_results`.
      - **Zero-Attempt Filtering**: Submitting an entirely blank worksheet (`attempted === 0`) marks the session submitted and returns the review breakdown with `saved: false` without inserting a zero-question row into `activity_results`.

18. **Flash Anzan Number Visibility in Browser & Scripted Sum Calculation (Phase 7b Disclosure)**:
    - *Risk*: Because the browser must display each number (`numbers: [signed integers]`) in real time from `flash_start(p_settings)` with zero network jitter, the sequence of numbers is visible to the client browser. A determined student could inspect the `flash_start` payload or run a browser script to sum the numbers automatically.
    - *Mitigation in Place*:
      - **Server-Side Minimum Duration & Expiry Gate**: `flash_submit(p_session, p_answer)` is a server-side RPC that rejects any answer submitted faster than the numbers could be shown (`count * speed_ms`), rejects sessions already submitted, rejects expired sessions, and caps `flash_start` at 300 tries per hour.
      - **Foreground Tab Requirement**: If the browser tab becomes hidden (`document.hidden`) during the countdown or while numbers are flashing, the client immediately cancels the try without calling `flash_submit`.
      - **Practice-Data Scope (Immune to Points Leaderboard)**: Flash Anzan records in `activity_results` are self-paced practice data (used for daily streaks, practice days, and personal settings progress). The flagship **Points** competition leaderboard is computed exclusively from teacher-entered `weekly_test_scores` and teacher-marked `attendance`, so Flash Anzan tries cannot inflate official competition points.

19. **Online Basics Practice Answer Scraping, Speed-Bot Submissions & `source = 'site'` Spoofing (Phase 9a)**:
    - *Risk*: A student attempts to read expected answers from the `POST /api/drill` (`kind: 'basics'`) start payload, submits a set in 0 seconds via script, replays a submission to create duplicate `results` rows, or attempts to insert a fake row directly into `public.results` with `source = 'site'` and `verified = true`.
    - *Mitigation in Place*:
      - **Database-Enforced `source = 'typed'` for Direct Student Writes**: A PostgreSQL trigger forces `source = 'typed'` and `verified = false` on any `results` row inserted by a student role; only the server-side service role (`POST /api/drill`) can write `source = 'site'` and `verified = true`.
      - **Server-Only Expected Answers (`stripBasicsExpected`)**: `generateBasicsSet` runs exclusively on the server; `expected` is stored only in `drill_sessions.expected` and stripped before returning `{ session_id, title, questions, target }`.
      - **Rate Limit, 30-Minute Expiry & Minimum Human Time (`questions * 0.6s`)**: `POST /api/drill` enforces 60 sets/hour per student on `drill_sessions` (`activity_type = 'basics'`), rejects expired sessions (`now > expires_at`), and rejects submissions where `elapsed < questions * 0.6` seconds (`"finished faster than possible, not saved"`).
      - **Atomic Session Claim & Locked Result Row**: The session is claimed atomically (`status = 'open' -> 'submitted'`) and the resulting `results` row is saved with `verified = true` (`source = 'site'`), preventing student edits or deletions.

20. **Memoriad Competition Practice External Script / Calculator Assistance & Speed-Bot Submissions (Phases 9b-1, 9b-1b & 9b-2)**:
    - *Risk*: During unsupervised home practice on `/pages/memoriad-play.html`, a student could use an external calculator or browser script to compute calendar weekdays, 10×10-digit sums, 8d×8d products, or 6-digit square roots, inspect the `start` network payload for expected answers, or submit answers instantaneously via script.
    - *Mitigation in Place*:
      - **Server-Only Expected Answers & Scoring**: `api/_memoriad.js` generates questions and expected answers on the server (`crypto.randomInt` and exact `BigInt` products / `isqrt` half-up rounding), stores `expected` only in `public.drill_sessions` (inaccessible to students), and strips `expected` from the `POST /api/memoriad` (`action: 'start'`) response. All grading (including the Calendar two-mistake rule and Square Roots triangular $k(k+1)/2$ prefix-digit rule) and timing calculations happen exclusively on the server on `submit`.
      - **Server-Side Plausibility Speed Gate**: `POST /api/memoriad` (`action: 'submit'`) computes `used_seconds = min(limit, max(0, (now - started_at) - concentration_seconds))` and rejects implausibly fast submissions where `used_seconds < attempted * 0.25` seconds for Mental Calendar Dates, `used_seconds < attempted * 3` seconds for Mental Additions, or `used_seconds < attempted * 5` seconds for Mental Multiplications and Mental Square Roots.
      - **Rate Limiting, Round-Specific Expiry (`limit + 30s`) & Atomic Single-Use Claim**: Starts are rate-limited to at most 60 sessions per hour per student, sessions expire at `started_at + concentration_seconds + limit + 30s` (`60s` for Calendar, `600s` for Additions, `900s` for Multiplications and Square Roots), and `submit` atomically updates `drill_sessions` only where `status = 'open'`.
      - **Practice-Data Scope**: Memoriad rows in `public.activity_results` (`activity_type = 'memoriad'`) are self-paced practice data (used for personal bests, streaks, and daily to-do ticks); official competition points on the Points leaderboard remain driven exclusively by teacher-verified weekly tests and attendance.




---

## Phase 10d: Score-Sheet Mirror Threat Model & Security Controls

1. **Formula Injection Prevention (`stringValue` / `numberValue` Only)**:
   - `toGoogleCellData` in `api/_google.js` writes cell values exclusively via `userEnteredValue: { stringValue }` or `userEnteredValue: { numberValue }` inside `updateCells` (never `formulaValue` and never `USER_ENTERED` value parsing). Even if a student's `Surprise Task` note starts with `=`, `+`, `-`, or `@`, Google Sheets stores it strictly as a literal string and never executes it as a formula.
2. **Service-Role & Secret Isolation**:
   - `mirror_fingerprints()`, `mirror_student_data(p_student)`, and writes to `public.mirror_state` are restricted to the Supabase `service_role` on the server (`/api/backup.js`).
   - `POST /api/backup` with `{ action: 'rebuild_mirror' }` requires a verified active admin caller (`verifyAdminCaller(req)`).
   - Per-student build errors stored in `mirror_state.last_error` pass through `sanitizeBackupError` / `sanitizeGoogleErrorMessage`, which scrub OAuth tokens, private keys, and student row data and truncate messages to 200 characters.
3. **Non-Destructive Tab Lifecycle**:
   - `api/backup.js` never sends `deleteSheet` requests. Making a student inactive or renaming a student preserves all existing tabs (`storedSheetId` renames the tab in place via `updateSheetProperties`).

---

## Phase 10g: Timed & Unlimited Online Basics Practice Threat Model & Controls

1. **Server-Side Clock Authority & `used_seconds` Capping**:
   - The server records `started_at` and `expires_at` (`started_at + seconds + 60s` for timed rounds; `started_at + 2 hours` for unlimited stopwatch rounds) in `public.drill_sessions`.
   - On `submit`, the server computes `elapsed = (now - started_at) / 1000` and sets `used_seconds = min(elapsed, seconds)` for `'timed'` mode and `elapsed` for `'unlimited'` mode. Even if a client modifies its local countdown timer, `expires_at` and server-measured `elapsed` are enforced on the server.
2. **Minimum Human Speed Gate (`0.25s` per Attempted Question) & Zero-Attempt Rejection**:
   - `checkTimedBasicsSubmission` rejects any submission with `attempted === 0`, any submission where `elapsed < attempted * 0.25` seconds (`"That was faster than possible. Please answer the questions yourself."`), and any submission arriving after `expires_at`.
   - Each answer entry is bounded to at most `20` characters and total entries are bounded to `pool` (`50 / 100 / 200 / 500 / 1000`).
3. **Server-Only `practice_mode` & Authoritative `meets_target`**:
   - Students cannot set `results.practice_mode` from client-side writes (`NULL` is enforced for student-typed rows). Only `POST /api/drill` using the Supabase `service_role` writes `practice_mode = 'timed' | 'unlimited'`, `source = 'site'`, and `verified = true`.
   - `meets_target` is read exclusively from the database view `results_with_target` and is never computed in client-side JavaScript.

