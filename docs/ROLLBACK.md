# Rollback Runbook (Phase 1)

This runbook describes how to cleanly and safely roll back the **Trendz Tracker Phase 1** deployment.

---

## 1. Database Rollback (Supabase SQL)

To completely tear down the Phase 1 tables, functions, triggers, and Row Level Security policies from your Supabase PostgreSQL database, run the following SQL script in the **Supabase SQL Editor**:

```sql
-- ==============================================================================
-- TRENDZ TRACKER - PHASE 1 DATABASE ROLLBACK SCRIPT
-- WARNING: This will permanently delete all Phase 1 tables, records, and policies!
-- ==============================================================================

-- 1. Drop trigger on auth.users (if created)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();

-- 2. Drop RLS policies
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_write_policy" ON public.profiles;
DROP POLICY IF EXISTS "categories_read_policy" ON public.categories;
DROP POLICY IF EXISTS "categories_admin_write_policy" ON public.categories;
DROP POLICY IF EXISTS "rounds_read_policy" ON public.rounds;
DROP POLICY IF EXISTS "rounds_admin_write_policy" ON public.rounds;
DROP POLICY IF EXISTS "daily_tasks_read_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_admin_write_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "results_select_policy" ON public.results;
DROP POLICY IF EXISTS "results_insert_policy" ON public.results;
DROP POLICY IF EXISTS "results_update_policy" ON public.results;
DROP POLICY IF EXISTS "results_delete_policy" ON public.results;
DROP POLICY IF EXISTS "activity_results_select_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_insert_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_update_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_delete_policy" ON public.activity_results;

-- 3. Drop tables in reverse foreign-key dependency order
DROP TABLE IF EXISTS public.activity_results CASCADE;
DROP TABLE IF EXISTS public.results CASCADE;
DROP TABLE IF EXISTS public.daily_tasks CASCADE;
DROP TABLE IF EXISTS public.rounds CASCADE;
DROP TABLE IF EXISTS public.categories CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- 4. Drop helper security functions
DROP FUNCTION IF EXISTS public.is_admin();

-- Note: auth.users accounts created in Supabase Auth can be removed from
-- the Authentication -> Users dashboard in Supabase if needed.
```

---

## 2. Application Code Rollback

### If Deployed on Vercel:
1. Go to your **Vercel Dashboard** $\rightarrow$ **Deployments**.
2. Find the previous stable deployment (or initial commit).
3. Click the three dots (`...`) on that deployment and select **Instant Rollback**.
4. To remove environment variables:
   - Go to **Settings $\rightarrow$ Environment Variables**.
   - Delete `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

### If Using Git:
To revert Phase 1 commits locally:
```bash
# Check commit history
git log --oneline -n 5

# Option A: Revert the Phase 1 commit cleanly
git revert <phase_1_commit_hash>
git push origin main

# Option B: Reset to the clean initial commit (destructive)
git reset --hard HEAD~1
git push origin main --force
```

---

## 3. Local Development Reset
To reset your local testing environment:
1. Open your browser Developer Tools Console (`F12`).
2. Run `localStorage.clear()` to clear the demo students, categories, and test auth state.
3. Refresh the page. The local state will return to its initial pristine demonstration state.
