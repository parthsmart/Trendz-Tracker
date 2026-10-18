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

### 3. Table: `rounds`
- **Purpose**: Represents practice competition rounds created by instructors (e.g. Round 1, Round 2).
- **Columns**:
  - `round_number`: `INTEGER PRIMARY KEY`
  - `round_date`: `DATE NOT NULL DEFAULT CURRENT_DATE`
  - `round_type`: `TEXT NOT NULL DEFAULT 'Category wise'`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Who Reads**: Every authenticated user (`auth.role() = 'authenticated'`).
- **Who Writes**: Administrators only (`is_admin() = true`).
- **Expected Size**: $\approx 50\text{--}300$ rounds per academic year ($\approx 25\text{ KB}$ storage).
- **Trade-off**: Simple integer primary key (`round_number`) keeps paper-to-digital correlation straightforward for children and teachers.

---

### 4. Table: `results`
- **Purpose**: The central table storing all manually recorded practice scores, accuracy metrics, and speed times.
- **Columns**:
  - `id`: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `student_id`: `UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE`
  - `category_id`: `UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT`
  - `round_number`: `INTEGER NULL REFERENCES public.rounds(round_number) ON DELETE SET NULL`
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
- **Indexes**:
  - Partial Unique Index: `(student_id, round_number, category_id) WHERE round_number IS NOT NULL`
  - Performance Indexes: `(student_id, entry_date DESC)`, `(student_id, category_id)`, `(verified_at)`, `(flagged)`
- **Database Trigger & Mutation Rules**:
  - `DEFAULT public.today_ist()`: Never computed from client browser clocks.
  - Insert for today: Client **omits** `entry_date` so the database assigns `today_ist()`.
  - Insert for past date: Client sends `entry_date`, which is validated by a database trigger (allowing only the past 7 days).
  - Update: Client **never sends** `entry_date`, preserving the date on which the student originally achieved the score.
  - Trigger validations: Raises user-friendly Postgres errors if `correct > total` or if scores are backdated beyond 7 days.
  - **Locking Trigger (Phase 4a)**: Students cannot change `flagged`, `flag_note`, `verified_by`, `verified_at`, `corrected_by`, or `corrected_at`. Furthermore, students **cannot edit or delete** any row that is verified (`verified_at IS NOT NULL` or `verified = true`) or has `corrected_at IS NOT NULL`.
  - **Flagged Rows (Phase 4a)**: Flagging (`flagged = true`, `flag_note`) does NOT lock the row; it instructs the student ("Your teacher asked you to check this entry"), keeping the row editable unless verified or corrected.
- **Who Reads**:
  - **Student**: Only rows where `student_id = auth.uid()`.
  - **Admin**: All rows.
- **Who Writes**:
  - **Student**: Can `INSERT`, `UPDATE`, and `DELETE` their own unverified, uncorrected rows.
  - **Admin**: Must perform verification, flagging, and corrections through dedicated RPCs (`admin_set_verified`, `admin_set_flag`, `admin_correct_result`) so all actions are transactionally logged to `result_audit`. Never update `results` directly for admin actions.
- **Expected Size**: High volume. 100 students entering 24 categories daily $\approx 2,400$ rows/day ($\approx 100\text{ MB}$ to $1\text{ GB}$ over multi-year cycles).
- **Trade-off**: Using a single unified table with nullable fields rather than multiple separate tables simplifies aggregation and streak tracking, but requires partial unique indexes to handle round vs non-round category constraints.

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

