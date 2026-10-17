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
