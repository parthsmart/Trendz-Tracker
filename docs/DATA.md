# Database Schema, Access Control & Data Catalog

This catalog outlines every database table in the Trendz Tracker PostgreSQL schema, specifying who writes it, who reads it, expected row growth, and the engineering trade-offs made.

---

### 1. Table: `profiles`
- **Purpose**: Stores student and instructor account profiles linked directly to Supabase Auth (`auth.users.id`).
- **Columns**:
  - `id`: `UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`
  - `student_code`: `TEXT UNIQUE NOT NULL` (e.g. `STU101`, `ADMIN01`)
  - `full_name`: `TEXT NOT NULL`
  - `role`: `TEXT NOT NULL CHECK (role IN ('student', 'admin')) DEFAULT 'student'`
  - `level`: `TEXT NULL` (e.g. `Level 1`, `Level 2`, `Level 3`, `Master`)
  - `active`: `BOOLEAN NOT NULL DEFAULT true`
  - `leaderboard_visible`: `BOOLEAN NOT NULL DEFAULT true` (admin-writable toggle controlling whether the student appears on any leaderboard)
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**:
  - **Student**: Only their own row (`id = auth.uid()`).
  - **Admin**: All rows (`is_admin() = true`).
  - **Anonymous**: Zero access.
- **Who Writes**:
  - **Admin**: Full write access (`INSERT`, `UPDATE`, `DELETE`) via RLS or Serverless Admin API.
  - **Student**: Zero write access.
- **Expected Size**: $\approx 50\text{--}500$ rows per institute branch ($\approx 50\text{ KB}$ storage).
- **Trade-off**: Storing minimal metadata only (no photos, no emails, no phone numbers) limits CRM capabilities, but eliminates privacy liabilities for minors.

---

### 2. Table: `categories`
- **Purpose**: Defines championship calculation disciplines (the 24 official round disciplines, plus speed basics drills, elements, and flash anzan).
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `name`: `TEXT NOT NULL` (e.g. `ADD`, `SUB`, `Square Root`, `1d4r`)
  - `section`: `TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash'))`
  - `sort_order`: `INTEGER NOT NULL DEFAULT 0`
  - `active`: `BOOLEAN NOT NULL DEFAULT true`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Every authenticated user (`auth.role() = 'authenticated'`).
- **Who Writes**: Administrators only (`is_admin() = true`).
- **Expected Size**: Small, $\approx 30\text{--}80$ rows total ($\approx 10\text{ KB}$ storage).
- **Trade-off**: Categories are soft-deactivated (`active = false`) rather than deleted to ensure historical student results never become orphaned or broken.

---

### 3. Tables: `round_series`, `category_series`, and `student_rounds` (Phase 4c-0)
- **Legacy Note**: The old shared `rounds` table is deprecated and no longer queried or mutated by the application.
- **Table `round_series`**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `name`: `TEXT NOT NULL` (e.g. `Old simulator`, `New simulator`)
  - `sort_order`: `INTEGER NOT NULL DEFAULT 0`
  - `is_current`: `BOOLEAN NOT NULL DEFAULT false` (exactly one series is current)
- **Table `category_series`**:
  - `category_id`: `UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE`
  - `series_id`: `UUID NOT NULL REFERENCES public.round_series(id) ON DELETE CASCADE`
  - `sort_order`: `INTEGER NOT NULL DEFAULT 0`
  - **Purpose**: Defines which round categories belong to which simulator series and their exact sequence within that series. Always use `category_series.sort_order` (not `categories.sort_order`) to order round categories.
- **Table `student_rounds`**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `series_id`: `UUID NOT NULL REFERENCES public.round_series(id) ON DELETE RESTRICT`
  - `round_number`: `INTEGER NOT NULL` (each student's own counter within that series)
  - `round_date`: `DATE NOT NULL DEFAULT public.today_ist()`
  - `round_type`: `TEXT NOT NULL DEFAULT 'Category wise'` (`Category wise` or `All at a time`)
  - `time_taken_seconds`: `INTEGER NULL CHECK (time_taken_seconds IS NULL OR time_taken_seconds >= 0)` (optional total round time, e.g. for "All at a time" rounds)
  - `import_batch_id`: `UUID NULL` (tracks rounds created via historical CSV import)
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
  - **Constraints**: `UNIQUE (student_id, series_id, round_number)`
  - **Who Reads**: Students read only their own rows (`student_id = auth.uid()`); Admins read all rows.
  - **Who Writes**:
    - **Student**: Cannot `INSERT` directly; must invoke RPC `start_round(p_student DEFAULT NULL, p_round_type DEFAULT 'Category wise')`, which returns the round `id`, assigns `max + 1` in the current series, uses `today_ist()`, and reuses today's empty round instead of creating duplicates. Students can `UPDATE` only `round_type` and `time_taken_seconds` on their own rounds from the last 7 days.
    - **Admin**: Full `SELECT`, `INSERT`, `UPDATE`, and `DELETE` access (deletion of rounds with recorded results is blocked).
- **Table `category_aliases` (Phase 4c-2a)**:
  - `alias`: `TEXT PRIMARY KEY` (normalised lowercase category name with all whitespace removed)
  - `category_id`: `UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE`
  - **Who Reads**: Admins can read all rows (`public.is_admin()`).
  - **Purpose**: Resolves recurring historical spreadsheet category name variations to canonical `round` categories with highest priority during CSV import.

---

### 4. Table: `results`
- **Purpose**: The central table storing all manually recorded practice scores, accuracy metrics, and speed times.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `category_id`: `UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT`
  - `student_round_id`: `UUID NULL REFERENCES public.student_rounds(id) ON DELETE RESTRICT` (required for `round` categories, forbidden for other sections; replaces the removed `round_number` column)
  - `correct`: `INTEGER NULL CHECK (correct >= 0)`
  - `total`: `INTEGER NULL CHECK (total >= 0)`
  - `time_seconds`: `INTEGER NULL CHECK (time_seconds >= 0)`
  - `note`: `TEXT NULL` (used for Surprise Task descriptions or student practice notes)
  - `entry_date`: `DATE NOT NULL DEFAULT public.today_ist()` (Indian Standard Time canonical practice day)
  - `verified`: `BOOLEAN NOT NULL DEFAULT false`
  - `flagged`: `BOOLEAN NOT NULL DEFAULT false` (Phase 4a teacher review flag)
  - `flag_note`: `TEXT NULL` (Phase 4a coaching note from teacher)
  - `verified_by`: `UUID NULL REFERENCES public.profiles(id)`
  - `verified_at`: `TIMESTAMPTZ NULL`
  - `corrected_by`: `UUID NULL REFERENCES public.profiles(id)`
  - `corrected_at`: `TIMESTAMPTZ NULL`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes & Constraints**:
  - Unique Constraint: `UNIQUE (student_round_id, category_id)`
  - Performance Indexes: `(student_id, entry_date DESC)`, `(student_id, category_id)`, `(student_round_id)`, `(verified_at)`, `(flagged)`
- **Database Trigger & Mutation Rules**:
  - `DEFAULT public.today_ist()`: Never computed from client browser clocks.
  - Insert for today: Client **omits** `entry_date` so the database assigns `today_ist()`.
  - Insert for past date: Client sends `entry_date`, which is validated by a database trigger (allowing only the past 7 days).
  - Update: Client **never sends** `entry_date`, preserving the date on which the student originally achieved the score.
  - Trigger validations: Raises user-friendly Postgres errors if `correct > total`, if scores are backdated beyond 7 days, if `student_round_id` does not belong to the student, if a student attempts to write to a non-current simulator series, or if a category is not part of the round's series.
  - **Locking Trigger (Phase 4a)**: Students cannot change `flagged`, `flag_note`, `verified_by`, `verified_at`, `corrected_by`, or `corrected_at`. Furthermore, students **cannot edit or delete** any row that is verified (`verified_at IS NOT NULL` or `verified = true`) or has `corrected_at IS NOT NULL`.
  - **Flagged Rows (Phase 4a)**: Flagging (`flagged = true`, `flag_note`) does NOT lock the row; it instructs the student ("Your teacher asked you to check this entry"), keeping the row editable unless verified or corrected.
- **Who Reads**:
  - **Student**: Only rows where `student_id = auth.uid()`.
  - **Admin**: All rows.
- **Who Writes**:
  - **Student**: Can `INSERT`, `UPDATE`, and `DELETE` their own unverified, uncorrected rows.
  - **Admin**: Must perform verification, flagging, and corrections through dedicated RPCs (`admin_set_verified`, `admin_set_flag`, `admin_correct_result`) so all actions are transactionally logged to `result_audit`. Never update `results` directly for admin actions.
- **Expected Size**: High volume. 100 students entering 24 categories daily $\approx 2,400$ rows/day ($\approx 100\text{ MB}$ to $1\text{ GB}$ over multi-year cycles).
- **Trade-off**: Using a single unified table with `student_round_id` required for round categories and `NULL` for non-round drills keeps streak and to-do aggregation unified while cleanly isolating per-student round counters.

---

### 5. Table: `activity_results`
- **Purpose**: Prepared for Phase 2 digital drills (Flash Anzan rapid visual mental math and element exercises).
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `activity_type`: `TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element'))`
  - `activity_name`: `TEXT NOT NULL`
  - `correct`: `INTEGER NOT NULL DEFAULT 0`
  - `total`: `INTEGER NOT NULL DEFAULT 0`
  - `time_seconds`: `INTEGER NULL`
  - `settings`: `JSONB NOT NULL DEFAULT '{}'::jsonb` (e.g. flash speed ms, digit counts)
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Student reads own rows; Admin reads all.
- **Who Writes**: Student writes own rows; Admin has full access.
- **Expected Size**: High volume during digital drill sessions.
- **Trade-off**: JSONB `settings` field accommodates evolving drill parameters without requiring constant schema migrations.

---

### 6. Table: `daily_tasks`
- **Purpose**: Allows teachers to publish daily homework or targeted practice goals per level.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `title`: `TEXT NOT NULL`
  - `section`: `TEXT NOT NULL`
  - `category_id`: `UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL`
  - `level`: `TEXT NULL` (when null, applies to all levels)
  - `sort_order`: `INTEGER NOT NULL DEFAULT 0`
  - `active`: `BOOLEAN NOT NULL DEFAULT true`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Every authenticated user.
- **Who Writes**: Administrators only (`is_admin() = true`).
- **Expected Size**: Small, $\approx 50\text{--}200$ active tasks ($\approx 40\text{ KB}$).
- **Trade-off**: Nullable `level` enables both institute-wide announcements and level-specific homework assignments.

---

### 7. Table: `resources`
- **Purpose**: Curated curriculum materials, championship rules PDFs, calculation guides, and study links published by teachers.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `title`: `TEXT NOT NULL`
  - `url`: `TEXT NOT NULL CHECK (url ~* '^https?://')`
  - `description`: `TEXT NULL`
  - `topic`: `TEXT NOT NULL DEFAULT 'General'`
  - `sort_order`: `INTEGER NOT NULL DEFAULT 0`
  - `active`: `BOOLEAN NOT NULL DEFAULT true`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Every authenticated student and admin (`active = true`).
- **Who Writes**: Administrators only (`is_admin() = true`).
- **Expected Size**: $\approx 20\text{--}100$ rows ($\approx 25\text{ KB}$).
- **Security Check**: Enforces strictly `http://` or `https://` URLs both at database CHECK constraint level and in client validation.

---

### 8. Table: `result_audit` (Phase 4a)
- **Purpose**: Immutable audit log of all administrative actions (verification, unverification, flagging, unflagging, corrections, and deletions) performed on student results.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `result_id`: `UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `changed_by`: `UUID NOT NULL REFERENCES public.profiles(id)`
  - `changed_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `action`: `TEXT NOT NULL CHECK (action IN ('verify', 'unverify', 'flag', 'unflag', 'correct', 'delete', 'admin_insert'))`
  - `old_values`: `JSONB NULL` (snapshot of changed fields prior to change)
  - `new_values`: `JSONB NULL` (snapshot of changed fields after change)
  - `reason`: `TEXT NOT NULL` (mandatory rationale for the administrative change)
- **Who Reads**: Administrators only (`is_admin() = true`).
- **Who Writes**: Database triggers and RPCs only. The client application NEVER writes directly to `result_audit`.
- **Expected Size**: $\approx 10\text{--}50\text{ KB}$ per 100 reviewed entries.

---

### 9. Table: `attendance_sessions` (Phase 4a)
- **Purpose**: Defines training sessions, workshops, or competition mock practices for which attendance is tracked.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `session_date`: `DATE NOT NULL DEFAULT public.today_ist()`
  - `title`: `TEXT NOT NULL` (e.g. "Saturday Competition Mock Exam")
  - `session_type`: `TEXT NOT NULL CHECK (session_type IN ('workshop', 'class', 'other')) DEFAULT 'class'`
  - `notes`: `TEXT NULL`
  - `created_by`: `UUID NOT NULL REFERENCES public.profiles(id)`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Authenticated administrators.
- **Who Writes**: Authenticated administrators. Deletions are forbidden when dependent `attendance` rows exist.

---

### 10. Table: `attendance` (Phase 4a)
- **Purpose**: Records individual student attendance status for each scheduled session.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `session_id`: `UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE RESTRICT`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `status`: `TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused'))`
  - `note`: `TEXT NULL` (optional explanation or reason, e.g. "School exam")
  - `marked_by`: `UUID NOT NULL REFERENCES public.profiles(id)`
  - `marked_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Constraints & Indexes**:
  - `UNIQUE (session_id, student_id)`: Enforces exactly one mark per student per session, enabling clean upserts.
- **Who Reads**:
  - **Student**: Reads own rows (`student_id = auth.uid()`).
  - **Admin**: Reads all rows.
- **Who Writes**: Administrators only via upsert on `(session_id, student_id)`.

---

### 11. Stored Procedures & Database RPC Catalog

#### `public.today_ist() -> DATE`
- Returns today's calendar date under Indian Standard Time (`Asia/Kolkata`).
- Ensures client devices with skewed or modified system clocks cannot forge dates or manipulate streaks.

#### `public.streak_for(p_student UUID) -> TABLE(current_streak INT, best_streak INT, shields INT, active_today BOOLEAN)`
- Authoritatively calculates:
  - `current_streak`: Number of consecutive IST calendar days up to today (or yesterday if shield used).
  - `best_streak`: All-time maximum consecutive days logged by the student.
  - `shields`: Number of streak freeze shields available/used.
  - `active_today`: Boolean indicating whether at least one result has been recorded today.

#### `public.todo_for(p_student UUID) -> TABLE(task_id UUID, task_title TEXT, task_section TEXT, task_category_id UUID, done BOOLEAN)`
- Evaluates completion status of active daily practice goals for a student today:
  - If `task_category_id` is set: returns `done = true` if student has logged a result for that category today.
  - If `task_category_id` is null: returns `done = true` if student has logged any result in that section today.

#### `public.admin_set_verified(p_ids UUID[], p_verified BOOLEAN, p_reason TEXT) -> VOID`
- Authoritative RPC for marking or unmarking verified status on an array of result IDs.
- Stamps `verified_at = now()` and `verified_by = auth.uid()` when `p_verified = true`, or sets them to `NULL` when `p_verified = false`.
- Atomically logs an action (`verify` or `unverify`) in `result_audit` for each updated entry with `p_reason`.

#### `public.admin_set_flag(p_id UUID, p_flagged BOOLEAN, p_note TEXT) -> VOID`
- Authoritative RPC for toggling teacher review flags.
- Updates `flagged = p_flagged` and `flag_note = p_note`.
- Atomically logs an action (`flag` or `unflag`) in `result_audit` with the note as reason.

#### `public.admin_correct_result(p_id UUID, p_correct INT, p_total INT, p_time_seconds INT, p_note TEXT, p_reason TEXT) -> VOID`
- Authoritative RPC for correcting a student score.
- Validates `p_correct <= p_total` and `length(trim(p_reason)) >= 3`.
- Stamps `corrected_at = now()` and `corrected_by = auth.uid()`.
- Atomically logs an action `correct` in `result_audit` with previous and new score snapshots and `p_reason`.

#### `public.attendance_summary(p_student UUID, p_from DATE, p_to DATE) -> TABLE(present_count INT, absent_count INT, excused_count INT, attendance_pct NUMERIC)`
- Authoritative calculation of attendance metrics for a student between `p_from` and `p_to`.
- Formula: `attendance_pct = (present_count::numeric / (present_count + absent_count)) * 100.0`.
- **CRITICAL**: Excused sessions are strictly ignored/excluded from the denominator. Never calculate attendance percentage in client JavaScript.

---

### 12. Table: `competition_settings` & Leaderboard RPCs (Phase 5a)

#### Table: `public.competition_settings`
- **Purpose**: Stores institute-wide competition rules and leaderboard display settings.
- **Columns**:
  - `key`: `TEXT PRIMARY KEY`
  - `value`: `TEXT NOT NULL` (validated by database constraints/triggers)
- **Supported Keys**:
  - `weekly_test_multiplier`: Multiplier applied to `GREATEST(correct - wrong, 0)` for each weekly test category on the Points board.
  - `attendance_present_points`: Points added for each session where the student is marked `'present'` (excused sessions give 0 and cost 0).
  - `improved_min_entries`: Minimum number of practice entries required in both last week and this week (IST) to qualify for the Most Improved board.
  - `leaderboard_names`: `'first_name_initial'` (e.g. `"Aarav S."`) or `'student_code'` (e.g. `"STU101"`).
- **Who Reads**: Admins read/edit directly via `competition_settings`; students and admins read parsed values via `public.competition_rules()`.
- **Who Writes**: Administrators only (`public.is_admin() = true`), saving each setting via `UPDATE public.competition_settings SET value = ... WHERE key = ...`.

#### RPC: `public.competition_rules() -> TABLE(weekly_test_multiplier INT, attendance_present_points INT, improved_min_entries INT, leaderboard_names TEXT)`
- Callable by both authenticated students and administrators.
- Returns the active competition rule parameters so the UI can build accurate `"How it works"` explanations without hardcoding multipliers or granting students direct read access to admin configuration tables.

#### RPC: `public.leaderboard(p_board TEXT, p_period TEXT, p_level TEXT, p_limit INT) -> TABLE(rank INT, student_id UUID, display_name TEXT, value NUMERIC, is_me BOOLEAN)`
- **Boards (`p_board`)**: `'points'`, `'streak'`, `'practice_days'`, `'improved'`.
- **Periods (`p_period`)**: `'week'` (Monday–Sunday in Indian time `Asia/Kolkata`), `'month'`, `'all'` (period is ignored for `'streak'` and `'improved'`).
- **Role Scoping & Privacy**:
  - **For Students**: Always filters to the caller's own `level` only, returns the top `p_limit` (up to 10; 3 on the dashboard card) plus the student's own row when ranked outside the top `p_limit`, sets `student_id = NULL` on all rows, and sets `is_me = true` on the caller's row.
  - **For Admins**: Supports `p_level = NULL` or `'all'` (all levels) or a specific level, returns up to `200` rows, populates `student_id` for deep-linking to `/pages/student-detail.html?id=<student_id>`, and sets `is_me = false`.
  - **Exclusions**: Students with `profiles.leaderboard_visible = false`, inactive students, and rows with zero/non-positive values are never returned.
  - **Display Names**: Already formatted by SQL as first name + initial or `student_code`; full names and raw scores are never exposed by this function.

---

#### 13. Tables: `drill_sessions` & `activity_results` (Phase 7b Flash Anzan, Phase 8 Elements Drills & Phase 9a Online Basics)

#### Table: `public.drill_sessions`
- **Purpose**: Server-only ephemeral session store holding generated numbers/questions, expected canonical answers, timing boundaries, and submission status for Flash Anzan (`activity_type = 'flash_anzan'`), Elements timed worksheet drills (`activity_type = 'element'`), and Online Basics practice (`activity_type = 'basics'`).
- **Columns**:
  - `id`: `UUID PRIMARY KEY`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id)`
  - `activity_type`: `'flash_anzan' | 'element' | 'basics'`
  - `activity_name`: `TEXT NOT NULL` (e.g. `'Flash Anzan'`, the Elements drill's `title` such as `'Day Codes'`, or the Basics category name such as `'1d4r'`)
  - `settings`: `JSONB NOT NULL` (for Flash Anzan Phase 7b: `{ digits, count, speed_ms, mode }`; for Elements: `{ drill, questions, time_limit_seconds }`; for Basics Phase 9a: `{ kind: 'basics', category_id, questions }`; for Memoriad Phase 9b-1: `{ module: 'calendar' | 'additions', dates?, concentration_seconds }`)
  - `questions`: `JSONB NOT NULL` (array of signed integers `numbers` for a single Flash Anzan try; array of prompt strings for Elements; array of display objects `{ type, rows?, a?, b?, dividend?, divisor?, text }` without `expected` for Basics; array of `[year, month, day]` triples for Memoriad Calendar or array of 10 ten-digit number string arrays for Memoriad Additions)
  - `expected`: `JSONB NOT NULL` (expected sum for Flash Anzan or array of canonical expected answers for Elements, Basics, and Memoriad; **never sent to the browser before submission**)
  - `min_seconds`: `NUMERIC NOT NULL` (`count * speed_ms / 1000` for Flash Anzan; enforced as `attempted * 0.25` seconds on submit for Elements and Memoriad Calendar; enforced as `questions * 0.6` seconds on submit for Basics; enforced as `attempted * 3` seconds on submit for Memoriad Additions)
  - `started_at`: `TIMESTAMPTZ NOT NULL`
  - `expires_at`: `TIMESTAMPTZ NOT NULL` (`started_at + 30 minutes` for Basics; `started_at + 3 hours` for Memoriad)
  - `status`: `'open' | 'submitted' | 'expired'`
  - `submitted_at`: `TIMESTAMPTZ NULL`
  - `result_id`: `UUID NULL REFERENCES public.activity_results(id)` (used by Flash Anzan, Elements, and Memoriad)
  - `result_row_id`: `UUID NULL REFERENCES public.results(id)` (Phase 9a: points to the `public.results` row inserted when an online Basics session is submitted)
- **Who Reads / Writes**: Readable only by administrators; written exclusively via `SECURITY DEFINER` RPCs (`flash_start`, `flash_submit`) or the service-role serverless endpoints (`POST /api/drill`, `POST /api/memoriad`). Students have **zero** read or write access to `drill_sessions`.

#### Phase 9a Additions to `public.results` & `public.results_with_target`
- **`results.source`**: `'typed' | 'site'`. A database trigger forces `source = 'typed'` on any row inserted directly by a student, so only the server (`POST /api/drill` using the service role) can write `source = 'site'`. Server-graded Basics rows are inserted with `source = 'site'`, `verified = true`, `verified_by = null`, `student_round_id = null`, `entry_date = public.today_ist()`, `correct`, `total = questions`, and `time_seconds = LEAST(ROUND(elapsed), 14400)`.
- **`results_with_target` View**: Includes `source`, `updated_at`, and `meets_target` alongside all score, review, and threshold columns.

#### Table: `public.activity_results`
- **Purpose**: Permanent log of completed Flash Anzan tries (`activity_type = 'flash_anzan'`), Elements worksheet sets (`activity_type = 'element'`), and Memoriad competition practice runs (`activity_type = 'memoriad'`). Read by `streak_for`, `todo_for` (including `section = 'memoriad'`), and the `practice_days` leaderboard.
- **Columns**:
  - `id`: `UUID PRIMARY KEY`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id)`
  - `activity_type`: `'flash_anzan' | 'element' | 'memoriad'`
  - `activity_name`: `TEXT NOT NULL` (e.g., `'Mental Calendar Dates'`, `'Mental Additions'`)
  - `correct`: `INT NOT NULL` (for a Phase 7b Flash Anzan try: `1` or `0`; for Elements and Memoriad: number of correct answers)
  - `total`: `INT NOT NULL` (for a Phase 7b Flash Anzan try: `1`; older Phase 7 rows with multiple questions per set have `total > 1` and `settings.questions` and remain supported in history and `statsByKey` via `sum(correct) / sum(total)`. For Elements and Memoriad: `attempted`, the number of non-blank answers submitted; if `attempted === 0`, no row is inserted)
  - `time_seconds`: `INT NOT NULL` (for Memoriad: `ROUND(used_seconds)`, where `used_seconds = max(0, (now - started_at) - concentration_seconds)`)
  - `settings`: `JSONB NOT NULL` (for Flash Anzan: `{ digits, count, speed_ms, mode }`; for Elements: `{ drill, questions, time_limit_seconds, attempted, session_id }`; for Memoriad: `{ module, questions, attempted, correct, score, used_seconds, concentration_seconds, dates? }`)
  - `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL`
- **Who Reads**: Students can `SELECT` only their own rows (`student_id = auth.uid()`); admins can `SELECT` all rows.
- **Who Writes**: Students can **never** `INSERT`, `UPDATE`, or `DELETE` rows in `activity_results`. Only `flash_submit`, `POST /api/drill`, and `POST /api/memoriad` (using the service role) insert rows after verifying session ownership, expiry, atomic `status = 'open' -> 'submitted'` transition, and minimum human plausibility time.

