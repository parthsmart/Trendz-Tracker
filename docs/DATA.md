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
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes**:
  - Partial Unique Index: `(student_id, round_number, category_id) WHERE round_number IS NOT NULL`
  - Performance Indexes: `(student_id, entry_date DESC)`, `(student_id, category_id)`
- **Database Trigger & Date Rules**:
  - `DEFAULT public.today_ist()`: Never computed from client browser clocks.
  - Insert for today: Client **omits** `entry_date` so the database assigns `today_ist()`.
  - Insert for past date: Client sends `entry_date`, which is validated by a database trigger (allowing only the past 7 days).
  - Update: Client **never sends** `entry_date`, preserving the date on which the student originally achieved the score.
  - Trigger validations: Raises user-friendly Postgres errors if `correct > total` or if scores are backdated beyond 7 days.
- **Who Reads**:
  - **Student**: Only rows where `student_id = auth.uid()`.
  - **Admin**: All rows.
- **Who Writes**:
  - **Student**: Can `INSERT`, `UPDATE`, and `DELETE` their own unverified rows (`verified = false`). Students cannot set `verified = true` or modify rows after an instructor marks them verified.
  - **Admin**: Can create, edit, verify (`verified = true`), or delete any score.
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

### 8. Stored Procedures & Database RPC Catalog

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

