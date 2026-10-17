# Project Handover & Session Ledger

> **Notice to any developer or assistant reading this**:  
> Read this file **first** before touching any code. Update this file **last** before ending any session.  
> Newest session entries always stay on top.

---

## Current Status Overview

### Session: 2026-10-17 (Phase 2 — Daily Score Entry & Round Management Delivered)

#### 5-Line Session Summary
- Built Student Screen 1 for entering scores across all 24 competition categories with live color feedback and locked verified rows.
- Built Student Screen 2 for logging multiple daily basics speed drills (1d4r, 2d2r) with 7-day historical date grouping.
- Enforced database date authority: never computes dates in the browser, omitting `entry_date` on today's inserts and updates.
- Built Admin Rounds management with quick IST next-round proposal and score-protected deletion guards.
- Completely documented Phase 2 across all /docs files without adding any new external dependencies or frameworks.

#### Done
- **Student Screen 1: "Round scores"** (`/pages/round-scores.html`, `js/roundScores.js`):
  - Dropdown of competition rounds (newest first, formatted `"Round 244 - 3 Oct 2026"`).
  - All 24 active championship categories rendered in exact competition sort order.
  - Touch-friendly large inputs with `inputmode="numeric"`.
  - Hybrid time parser accepting `"2:07"` or `"127"` (seconds) and formatting as `mm:ss`.
  - Live accuracy feedback: `0 wrong` = Green, `1 to 10 wrong` = Orange, `>10 wrong` = Cyan, neutral for empty.
  - Always pairs color with explicit text labels (e.g. `"3 wrong"`).
  - Progress tracker: `"17 of 24 done"` dynamically calculated.
  - Surprise Task: note textarea plus optional numeric scoring.
  - Read-only locking for rows marked `verified = true` with padlock and note `"Verified by teacher"`.
  - Sequential `Enter` key focus advancement across grid inputs.
  - Non-upsert batch save: updates existing rows by ID and inserts new rows without sending `entry_date` (allowing database `DEFAULT today_ist()` to populate it).
  - Friendly toast display for any database trigger errors.
- **Student Screen 2: "Basics"** (`/pages/basics.html`, `js/basics.js`):
  - Category selector for speed drills (`1d4r`, `2d2r`).
  - Date preset: defaults to Today (omits `entry_date`), with option to pick up to 7 days back (sends `entry_date`).
  - Supports multiple drills per day for the same category.
  - Displays today's drill entries with accuracy badges, Edit and Delete controls (disabled if verified).
  - Last 7 days history grouped cleanly by date with drill counts.
  - Updates to existing drills never send `entry_date`, preserving original practice dates.
- **Student Home** (`/pages/student.html`):
  - Added two large, touch-friendly action cards: `"Enter Round Scores"` and `"Enter Basics"`.
- **Admin: "Rounds" Page** (`/pages/rounds.html`, `js/rounds.js`):
  - Table listing all rounds, formatted dates, types, and recorded score counts.
  - **⚡ Add Next Round** quick button proposing `max + 1` and today's date in Indian Standard Time (IST).
  - Custom round creation modal.
  - Edit modal for date and type (round number is immutable).
  - Deletion protection: rounds with recorded results cannot be deleted.
  - Added `"Rounds"` link to admin navigation bar across all admin views.
- **Shared Utilities**:
  - `js/scoreColors.js`: Single source of truth for error counts and status colors.
  - `js/timeUtils.js`: Parses seconds/`mm:ss` and coordinates Enter key navigation.
  - `css/variables.css`: Added `--color-score-perfect`, `--color-score-warning`, and `--color-score-alert`.
- **Demo Mode**:
  - Fully disabled when live Supabase credentials exist.
  - Displays prominent warning banner `"DEMO MODE - data is fake"` when in preview mode.
- **Docs Suite Updated**:
  - `DECISIONS.md`: Added ADR-007 through ADR-010.
  - `DATA.md`: Documented `DEFAULT today_ist()`, entry_date omission, and trigger protections.
  - `THREAT.md`: Recorded 7-day backdating triggers, inflated score mitigations via verified flags, and deactivated accounts.
  - `TESTING.md`: Added Test Cases 9 through 16 with exact reproduction steps.

#### In progress
- None. Phase 2 score entry and round management are fully functional, compiled, and verified.

#### Broken or risky
- **Database Trigger Dependency**: In live Supabase mode, the database must contain the `today_ist()` function and results trigger. If missing, Postgres defaults to standard `CURRENT_DATE`. The client handles any returned database error gracefully in a toast.

#### Next (Phase 3 Preview)
- Build daily to-do tasks and targeted homework assignments per level.
- Build student practice streak tracking and consistency metrics.
- Build personal progress charts and speed analytics over time.
- Build instructor round verification review console.

#### Do not touch
- **`public.is_admin()` SQL function**: SECURITY DEFINER prevents infinite RLS recursion.
- **Partial Unique Index on `results`**: Ensures 1 score per student per round per category.
- **Non-Upsert Round Save Strategy**: Never replace the ID-based update/insert diffing with PostgREST upsert.
- **Database Date Authority**: Never pass `entry_date` on today's inserts or updates.

---

### Session: 2026-10-17 (Live Supabase Credentials Connected & Secret Isolation Verified)

#### 5-Line Session Summary
- Successfully integrated live Supabase project credentials with automatic URL sanitization.
- Placed public URL and publishable key in `js/config.js`, while confining the service role key to `.env`.
- Hardened server-side admin helper `api/_supabaseAdmin.js` against malformed trailing paths.
- Verified live Supabase client initialization replacing Demo Mode fallback across all views.
- Verified application compilation, zero lint errors, and dev server operational on port 3000.

---

### Session: 2026-10-17 (Phase 1 Baseline & Governance Setup)

#### 5-Line Session Summary
- Delivered the complete Phase 1 foundation: Student ID auth mapping, role-guarded pages, and responsive UI shells.
- Designed and verified the Postgres schema with Row Level Security, indexing, seed data, and fixed policy initialization.
- Built Vercel serverless functions in `/api` to safely execute administrative user creation and password resets.
- Established the `/docs` governance and architecture suite prioritizing child data protection and strict row isolation.
- Maintained a zero-external-dependency frontend using vanilla HTML/CSS/JS and pinned Supabase CDN scripts.
