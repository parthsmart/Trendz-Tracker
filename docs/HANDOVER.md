# Project Handover & Session Ledger

> **Notice to any developer or assistant reading this**:  
> Read this file **first** before touching any code. Update this file **last** before ending any session.  
> Newest session entries always stay on top.

---

## Current Status Overview

### Session: 2026-10-17 (Live Supabase Credentials Connected & Secret Isolation Verified)

#### 5-Line Session Summary
- Successfully integrated live Supabase project credentials with automatic URL sanitization.
- Placed public URL and publishable key in `js/config.js`, while confining the service role key to `.env`.
- Hardened server-side admin helper `api/_supabaseAdmin.js` against malformed trailing paths.
- Verified live Supabase client initialization replacing Demo Mode fallback across all views.
- Verified application compilation, zero lint errors, and dev server operational on port 3000.

#### Done
- **Live Credentials Wired**: Configured `https://ctwjujnqxkhononxykdc.supabase.co` in `js/config.js` and `.env`.
- **URL Sanitization**: Stripped trailing `/rest/v1` and slashes to prevent 404 endpoint routing errors in Supabase Auth SDK.
- **Strict Key Isolation**: Confined `SUPABASE_SERVICE_ROLE_KEY` to server-only runtime environment (`.env`).
- **Backend Admin API**: Updated `api/_supabaseAdmin.js` to normalize project URLs dynamically.
- **Verified Build & Server**: All client assets compile in 190ms with zero lint warnings.

#### In progress
- Ready for instructor to run `supabase/schema.sql` (if not already run) and create the initial admin user.

#### Broken or risky
- **Initial Admin Provisioning**: On a fresh Supabase database, at least one admin user must be created in Supabase Auth (e.g. `admin01@trendz.local`) and promoted in SQL via `UPDATE public.profiles SET role = 'admin' WHERE student_code = 'ADMIN01'` before the Admin Dashboard can be used.

#### Next (Phase 2 Preview)
- Build daily score entry interface for the 24 championship categories.
- Build basics speed drill logging (1d4r, 2d2r digits and rows).
- Implement teacher verification workflow for completed practice rounds.
- Build practice streak tracking and personal performance charts.

#### Do not touch
- **`public.is_admin()` SQL function**: It is defined with `SECURITY DEFINER` and `SET search_path = public` specifically to prevent recursive RLS loops when checking user roles. Modifying this function could lock all users out of their profiles or cause stack overflow crashes in Postgres.
- **Partial Unique Index on `results`**: `(student_id, round_number, category_id) WHERE round_number IS NOT NULL` guarantees data integrity. Removing it will allow duplicate entries for the same round category.
- **Category Deletion Prohibition**: Categories with existing results must never be hard-deleted; only toggle `active = false`.

---

### Session: 2026-10-17 (Phase 1 Baseline & Governance Setup)

#### 5-Line Session Summary
- Delivered the complete Phase 1 foundation: Student ID auth mapping, role-guarded pages, and responsive UI shells.
- Designed and verified the Postgres schema with Row Level Security, indexing, seed data, and fixed policy initialization.
- Built Vercel serverless functions in `/api` to safely execute administrative user creation and password resets.
- Established the `/docs` governance and architecture suite prioritizing child data protection and strict row isolation.
- Maintained a zero-external-dependency frontend using vanilla HTML/CSS/JS and pinned Supabase CDN scripts.
