# Implementation Plan: Phase 2 — Daily Score Entry & Round Management

Build Phase 2 of **Trendz Tracker**: daily practice score entry for abacus students (Championship Rounds and Basics speed drills) and round management for instructors, maintaining the vanilla HTML/CSS/JS architecture and safety constraints.

> [!IMPORTANT]
> **Working Rules Protocol Activated**: In accordance with the system rules, no code or documentation files will be created until this plan and its alternatives have been reviewed and approved by you.

---

## 1. Overview & Core Concept
In Phase 2, students actively record their daily training scores for the Junior Mental Calculation World Championship:
1. **Student Screen 1: "Round scores"** (`/pages/round-scores.html`): Students select a competition round, review prefilled/saved attempts across the 24 championship categories, see instant wrong-count feedback with color-coded evaluation, enter time in `mm:ss` or seconds, and save batch progress. Verified rows are locked.
2. **Student Screen 2: "Basics"** (`/pages/basics.html`): Students log rapid mental speed drills (e.g. `1d4r`, `2d2r` digits and rows). Students can log multiple drills per day, pick dates up to 7 days back, and review historical drills grouped by date.
3. **Admin: "Rounds" Management** (`/pages/rounds.html`): Teachers create and manage official competition rounds, view practice counts, and use a "Next Round" quick-generator.
4. **Student Home** (`/pages/student.html`): Streamlined with two prominent action buttons directing to Round Scores and Basics drills.

---

## 2. Key Product Decisions & Alternatives Considered

### Decision 1: Database Date Authority (`today_ist()`) & Omitting `entry_date`
- **Context**: Students practice across various time zones and browser device clocks can be skewed, backdated, or tampered with. The database possesses the canonical `public.today_ist()` function.
- **Chosen Approach**: Never compute or trust "today" from the browser clock. When inserting a row for today, **do not send `entry_date` in the payload**, allowing the database default (`today_ist()`) to populate it. Only send `entry_date` when a student deliberately picks a historical date (in Basics drills, capped to 7 days). When updating an existing row, never send `entry_date` so the row's original practice date is preserved.
- **Alternatives Considered**:
  - *Sending `new Date().toISOString()` from browser*: Rejected because client clocks are easily misconfigured or manipulated, bypassing competition date integrity.
  - *Calling an RPC to fetch current server date before every save*: Rejected as excessive network latency; relying on Postgres column defaults (`DEFAULT today_ist()`) is simpler and atomic.

### Decision 2: Batch Round Save Mechanism (No Upsert on Partial Unique Index)
- **Context**: The `results` table has a partial unique index: `(student_id, round_number, category_id) WHERE round_number IS NOT NULL`. PostgreSQL `INSERT ... ON CONFLICT` with partial unique indexes requires exact matching `WHERE` clauses that can be brittle across Supabase PostgREST versions.
- **Chosen Approach**: When a student loads a round, client queries all existing results for `(student_id, round_number)`. When clicking **Save**:
  1. Identify rows that have changed.
  2. For already-existing rows: issue individual/batch `UPDATE results SET correct = ..., total = ..., time_seconds = ..., note = ... WHERE id = existing.id`.
  3. For newly-entered rows: issue `INSERT INTO results (...)` without `entry_date`.
  4. Skip unattempted/empty rows.
- **Alternatives Considered**:
  - *PostgREST Upsert (`upsert([...], { onConflict: '...' })`)*: Rejected because PostgREST handles partial unique indexes inconsistently and can trigger duplicate key constraint errors.

### Decision 3: Shared Color Feedback Function & Anti-Pill Discipline
- **Context**: Students need immediate feedback on their accuracy, but WCAG accessibility and our design constitution dictate that color must never be the sole indicator.
- **Chosen Approach**: Shared module `js/scoreColors.js`:
  - `wrong = total - correct`
  - All correct (`wrong === 0` and `total > 0`): Green (`var(--color-score-perfect)`) + text `"0 wrong"`
  - 1 to 10 wrong: Orange (`var(--color-score-warning)`) + text `"${wrong} wrong"`
  - $>10$ wrong: Cyan (`var(--color-score-alert)`) + text `"${wrong} wrong"`
  - Unattempted / no data: Neutral + text `"—"`
  - Styled with subtle hairline card borders and clean text labels (no candy pill badges).
- **Alternatives Considered**:
  - *Percentage-only badges*: Rejected because in abacus competition, raw error count (penalties) is the decisive championship metric.

### Decision 4: Time Input Parsing & Keyboard Flow
- **Context**: Students and kids on mobile devices need fast, friction-free input for times (e.g. typing `127` seconds or `2:07` minutes:seconds).
- **Chosen Approach**: Shared utility `js/timeUtils.js`:
  - Accepts `"2:07"` or raw seconds `"127"`, formats on blur as `mm:ss` (e.g. `2:07`).
  - Inputs configured with `inputmode="numeric"`.
  - Pressing `Enter` automatically advances focus to the next input in the grid for rapid keyboard entry.
- **Alternatives Considered**:
  - *Separate minutes and seconds input fields*: Rejected because two fields double the tab stops and slow down fast score entry.

---

## 3. Detailed Component & Page Blueprint

```
trendz-tracker/
├── pages/
│   ├── round-scores.html      # NEW: Student Round Score Entry (24 categories)
│   ├── basics.html            # NEW: Student Basics Speed Drills (digits & rows)
│   ├── rounds.html            # NEW: Admin Rounds Management & quick creator
│   ├── student.html           # UPDATED: Prominent buttons to Round Scores & Basics
│   └── admin.html             # UPDATED: Added nav link to Rounds page
├── js/
│   ├── scoreColors.js         # NEW: Shared color & wrong-count feedback logic
│   ├── timeUtils.js           # NEW: Parser for "2:07" / "127" -> mm:ss & keyboard navigation
│   ├── roundScores.js         # NEW: Logic for loading round, prefilling, saving, verified locks
│   ├── basics.js              # NEW: Logic for logging speed drills & 7-day grouped history
│   ├── rounds.js              # NEW: Admin round listing, creation, and IST next-round proposal
│   └── config.js              # UPDATED: Demo Mode banner and strict disable when live
├── css/
│   ├── variables.css          # UPDATED: Added --color-score-perfect, warning, alert tokens
│   └── style.css              # UPDATED: Grid row layouts for score entry, verified badges
└── docs/                      # UPDATED: All 5 documentation files updated for Phase 2
```

### Detailed Functional Specifications:

#### 1. Student Screen 1: Round Scores (`/pages/round-scores.html`)
- **Round Selector**: Dropdown showing rounds whose `round_date` is today or earlier, ordered newest first (e.g. `"Round 244 - 3 Oct 2026"`). Default selects the latest round.
- **Category Roster**: Renders all 24 active `round` categories in competition sort order.
- **Row Inputs**:
  - Correct (`inputmode="numeric"`, `min="0"`)
  - Total Attempted (`inputmode="numeric"`, `min="0"`)
  - Time (`inputmode="numeric"`, accepts `2:07` or `127`)
  - Real-time feedback column showing wrong count (e.g. `"2 wrong"`) and dynamic status color.
- **Progress Counter**: Header banner showing `"17 of 24 done"` dynamically recalculating as rows are completed.
- **Surprise Task Row**: Includes textarea/input for task description note + optional Correct/Total/Time. Only evaluated with score colors if numbers are present.
- **Verified Protection**: If row has `verified = true`, inputs are disabled with a padlock symbol and label `"Verified by teacher"`.
- **Keyboard Navigation**: Pressing `Enter` automatically jumps to the next input in the row or the next category row.
- **Save Action**: Saves dirty/modified rows only. Pre-existing rows updated via `id`; new rows inserted without `entry_date`. Shows friendly toast for any database trigger errors.

#### 2. Student Screen 2: Basics Speed Drills (`/pages/basics.html`)
- **Category Selector**: Dropdown of active `basics` categories (`1d4r`, `2d2r`, etc.).
- **Date Selector**: Radio/segmented toggle or date picker defaulting to "Today". Allows picking past dates up to 7 days back.
  - When "Today": omits `entry_date` on insert.
  - When past date: sends `entry_date`.
- **Drill Inputs**: Correct, Total, Time (formatted as `mm:ss`).
- **Today's Session List**: Below the form, lists all drills completed today with accuracy color, wrong count, and Edit/Delete buttons (disabled if verified).
- **7-Day Historical Breakdown**: Clean collapsible/accordion cards grouped by date showing past drills, totals, and speed times.

#### 3. Admin: Rounds Management (`/pages/rounds.html`)
- **Rounds Table**: Lists round number, date, round type (default `"Category wise"`), and recorded result count.
- **Add Round Form**:
  - Number, Date, Type.
  - **"Add Next Round" Quick Button**: Queries highest round number in table, proposes `max + 1`, and sets today's date in IST.
- **Edit Modal**: Allows editing round date and type. Prohibits modifying round number.
- **Delete Protection**: Checks if rows exist in `results` for that round. If count $> 0$, deletion is blocked with a clear warning.

#### 4. Demo Mode Hardening
- If live Supabase credentials exist in `js/config.js` and `.env`: Demo Mode is strictly locked out.
- If placeholders remain: A persistent banner displays `"DEMO MODE - data is fake"` across all screens.

---

## 4. Technical Architecture & Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT BROWSER (UNTRUSTED)                       │
│                                                                             │
│   ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────┐   │
│   │ Round Scores Page   │   │     Basics Page     │   │   Rounds Admin  │   │
│   │ (/round-scores)     │   │     (/basics)       │   │   (/rounds)     │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └────────┬────────┘   │
│              │                         │                       │            │
│              ▼                         ▼                       ▼            │
│       [scoreColors.js (Wrong count calculation) & timeUtils.js (mm:ss)]     │
└───────────────────────┬────────────────────────────────────────┬────────────┘
                        │                                        │
                        │ Direct PostgREST via JWT               │
                        ▼                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SUPABASE POSTGRESQL DATABASE                          │
│                                                                             │
│   - results (RLS: student_id = auth.uid() AND verified = false)             │
│   - DEFAULT entry_date = public.today_ist()  <-- Never trusts browser clock │
│   - Trigger: Enforces 7-day backdating cap & correct <= total               │
│   - rounds (RLS: authenticated read, admin write)                           │
│   - categories (RLS: authenticated read, admin write)                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Review & Approval Gate
Before writing the code and documentation updates, please confirm:
1. Does this plan and architectural structure align with your requirements for Phase 2?
2. Are you ready for me to proceed with creating the files and updating the `/docs` suite?
