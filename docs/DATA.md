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
  - `entry_date`: `DATE NOT NULL DEFAULT CURRENT_DATE`
  - `verified`: `BOOLEAN NOT NULL DEFAULT false`
  - `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes**:
  - Partial Unique Index: `(student_id, round_number, category_id) WHERE round_number IS NOT NULL`
  - Performance Indexes: `(student_id, entry_date DESC)`, `(student_id, category_id)`
- **Who Reads**:
  - **Student**: Only rows where `student_id = auth.uid()`.
  - **Admin**: All rows.
- **Who Writes**:
  - **Student**: Can `INSERT`, `UPDATE`, and `DELETE` their own unverified rows (`verified = false`). Students cannot set `verified = true`.
  - **Admin**: Can create, edit, verify, or delete any score.
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
