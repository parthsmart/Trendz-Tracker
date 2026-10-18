# Verification Runbook & Security Testing Guide

This document contains step-by-step test scenarios to verify security boundaries, Row Level Security isolation, and role guards for **Trendz Tracker (Phase 1)**.

---

## Pre-Requisites & Test Accounts

### In Interactive Demo Mode (Default):
- **Admin Account**: ID `ADMIN01` / Password `admin123`
- **Student Account A**: ID `STU101` (Aarav Sharma, Level 3) / Password `student123`
- **Student Account B**: ID `STU102` (Diya Patel, Level 2) / Password `student123`
- **Inactive Student Account**: ID `STU104` (Ananya Iyer) / Password `student123`

### In Live Supabase Mode:
- Admin user created via Supabase Auth (`admin01@trendz.local`) and promoted via SQL.
- Student accounts created via the Admin Dashboard.

---

## Test Suite

### Test Case 1: Student Login with Synthetic ID Mapping
- **Objective**: Verify students can sign in using only their assigned Student ID and password without an email address.
- **Steps**:
  1. Open `/index.html` in your browser.
  2. In the **Student ID or Admin ID** field, type: `STU101`.
  3. In the **Password** field, type: `student123`.
  4. Click **Sign In**.
- **Expected Result**:
  - The login button displays a brief loading spinner.
  - A green toast message appears: `"Welcome back, Aarav Sharma!"`.
  - The browser redirects to `/pages/student.html`.
  - The Student Portal displays:
    - Name: `Aarav Sharma`
    - Student Code: `STU101`
    - Level: `Level 3`
    - Status: `Active`

---

### Test Case 2: Cross-Student Data Isolation (Critical Security Test)
- **Objective**: Confirm that an authenticated student can **never** read, query, or view another student's profile or scores.
- **Steps**:
  1. Log in as Student `STU101` (Aarav Sharma).
  2. Open the browser Developer Tools Console (`F12` or `Ctrl+Shift+I` / `Cmd+Option+I`).
  3. Execute this direct database query in the console:
     ```javascript
     // Attempt to query all student profiles in the database
     const { data, error } = await supabase.from('profiles').select('*');
     console.log('Queried profiles:', data);
     ```
- **Expected Result**:
  - In Live Supabase mode: `data` contains **only 1 row** (Aarav Sharma's own profile). All other student profiles (Diya Patel, Kabir Verma, etc.) are filtered out by PostgreSQL Row Level Security.
  - In Demo Mode: The student dashboard only accesses `DemoDB.getDemoAuth()`.
  - **Pass Criteria**: `STU101` cannot retrieve `STU102`'s profile or scores under any circumstances.

---

### Test Case 3: Student Attempting to Access Admin Pages
- **Objective**: Verify that students cannot open admin pages (`/pages/admin.html` or `/pages/categories.html`) by typing URLs directly.
- **Steps**:
  1. While logged in as `STU101`, manually type `http://localhost:3000/pages/admin.html` in the browser address bar and press Enter.
  2. Attempt the same for `http://localhost:3000/pages/categories.html`.
- **Expected Result**:
  - `guard.js` immediately detects that the active user has `role: 'student'`.
  - The page halts execution and immediately bounces the user back to `/pages/student.html`.
  - The admin student table is never rendered in the DOM.

---

### Test Case 4: Unauthenticated Direct Navigation Protection
- **Objective**: Verify that logged-out visitors are blocked from all internal pages.
- **Steps**:
  1. Sign out or open an Incognito/Private browsing window.
  2. Attempt to navigate directly to:
     - `http://localhost:3000/pages/student.html`
     - `http://localhost:3000/pages/admin.html`
     - `http://localhost:3000/pages/categories.html`
- **Expected Result**:
  - In all cases, `guard.js` detects `profile == null`.
  - The browser is immediately redirected to `/index.html`.

---

### Test Case 5: Inactive Student Login Blocking
- **Objective**: Verify that deactivated students cannot log in.
- **Steps**:
  1. On `/index.html`, enter ID `STU104` (deactivated student) and password `student123`.
  2. Click **Sign In**.
- **Expected Result**:
  - Login fails.
  - An error banner appears: `"Your account is deactivated. Please contact your Trendz Abacus teacher."`.
  - The session is terminated and no redirect occurs.

---

### Test Case 6: Admin Student Creation & Random Password Generation
- **Objective**: Verify that an administrator can create a new student account.
- **Steps**:
  1. Log in as `ADMIN01` / `admin123`.
  2. You will be redirected to `/pages/admin.html`.
  3. Click **+ Add Student**.
  4. In the modal:
     - Student ID: `STU106`
     - Full Name: `Ishaan Gupta`
     - Level: `Level 1`
     - Click **Generate Random** (populates a randomized 8-character password).
  5. Click **Create Student**.
- **Expected Result**:
  - In Demo Mode: The student is added to `DemoDB` immediately.
  - In Live Mode: Calls `/api/create-student`, which checks the admin JWT, provisions `stu106@trendz.local` in Supabase Auth, and inserts into `profiles`.
  - Modal closes, a success toast displays `"Student account STU106 created successfully"`, and the student roster updates automatically.

---

### Test Case 7: Admin Password Reset Functionality
- **Objective**: Verify that an instructor can reset a student's temporary password.
- **Steps**:
  1. On the Admin Dashboard, find student `STU101`.
  2. Click the **Reset Pwd** button in that row.
  3. In the modal, click **Generate Random** to create a new password.
  4. Click **Update Password**.
- **Expected Result**:
  - Modal closes, success toast displays: `"Student password updated successfully"`.
  - In Live Mode, the password is encrypted and updated via `supabaseAdmin.auth.admin.updateUserById`.

---

### Test Case 8: Category Reordering & Safe Deactivation
- **Objective**: Verify that categories can be reordered and deactivated without hard-deleting historical data.
- **Steps**:
  1. From the top navigation bar, click **Categories** (`/pages/categories.html`).
  2. Notice the 24 seeded round categories and 2 basics categories (`1d4r`, `2d2r`).
  3. Click the **↓** button next to `ADD`. Notice `ADD` swaps positions with `SUB`.
  4. Click **Deactivate** next to `Calendar`.
- **Expected Result**:
  - The `Calendar` row changes to a subdued background with an `Inactive` indicator.
  - The button label changes to `Activate`.
  - The database record retains its row with `active = false` (no rows are dropped, protecting historical scores).

---

### Test Case 9: Student Round Scores Entry & Category Listing
- **Objective**: Verify that students can select an active round, view the 24 categories in order, enter numbers, and view the progress indicator.
- **Steps**:
  1. Log in as a student (`STU101` / `student123`).
  2. On the student home page, click **Enter Round Scores** (or navigate to `/pages/round-scores.html`).
  3. Verify the round dropdown displays rounds (e.g. `"Round 244 - 3 Oct 2026"`), defaulting to the newest.
  4. Verify all 24 active categories are listed in competition sort order (`ADD`, `SUB`, `MIX`, ..., `Surprise Task`).
  5. In row 1 (`ADD`), enter `Correct: 10`, `Total: 10`, `Time: 1:30`.
- **Expected Result**:
  - The progress tracker updates dynamically (e.g. `"1 of 24 completed"`).
  - Row 1 accuracy badge updates immediately to green: `"0 wrong"`.

---

### Test Case 10: Score Color Feedback & Dual Text Evaluation
- **Objective**: Verify that score colors match the exact specifications and always pair with descriptive text.
- **Steps**:
  1. On `/pages/round-scores.html`, navigate to row 1 (`ADD`):
     - Enter `Correct: 20`, `Total: 20`.
     - Observe badge color and text.
  2. Change `Correct` to `15`, `Total: 20` (5 wrong).
     - Observe badge color and text.
  3. Change `Correct` to `5`, `Total: 20` (15 wrong).
     - Observe badge color and text.
  4. Clear both inputs.
     - Observe badge.
- **Expected Result**:
  - `20 / 20`: Badge is Green (`--color-score-perfect`) and reads `"0 wrong"`.
  - `15 / 20`: Badge is Orange (`--color-score-warning`) and reads `"5 wrong"`.
  - `5 / 20`: Badge is Cyan (`--color-score-alert`) and reads `"15 wrong"`.
  - Cleared: Badge is neutral gray and reads `"—"`.

---

### Test Case 11: Hybrid Time Parsing ("2:07" vs "127") & Keyboard Enter Flow
- **Objective**: Verify time formatting flexibility and rapid keyboard navigation.
- **Steps**:
  1. In the `Time` input of category `ADD`, type `127` and press Tab or click outside.
  2. In category `SUB`, type `2:07`.
  3. Focus on `ADD Correct`, type `15`, and press `Enter`.
- **Expected Result**:
  - `127` automatically formats to `"2:07"`.
  - `2:07` remains `"2:07"`.
  - Pressing `Enter` automatically advances focus to `ADD Total`, then `ADD Time`, then to the next category row.

---

### Test Case 12: Verified Row Immutability (Teacher Lock)
- **Objective**: Confirm that rows marked `verified = true` by an instructor are read-only and locked for students.
- **Steps**:
  1. Open a round where an instructor has verified a score (or in database set `verified = true` on one row).
  2. Check the category row inputs on `/pages/round-scores.html`.
- **Expected Result**:
  - The inputs for that category are grayed out, disabled, and readonly.
  - A padlock icon and `"🔒 Verified"` indicator are displayed.
  - The student cannot alter the values or submit an update for that category.

---

### Test Case 13: Non-Upsert Round Batch Saving & Database Date Default
- **Objective**: Verify that saving scores updates existing rows by ID, inserts new rows without sending `entry_date`, and avoids partial unique index upsert errors.
- **Steps**:
  1. Enter scores for 3 categories in Round 244.
  2. Click **Save Changes**.
  3. Inspect the network request payload in browser DevTools.
  4. Refresh the page and reload Round 244.
- **Expected Result**:
  - The network payload for newly inserted rows does NOT include `entry_date`.
  - A green success toast appears: `"Round scores saved successfully!"`.
  - On page refresh, the 3 rows are marked `"Saved"` and prefilled with the saved numbers.
  - Existing rows receive `UPDATE` calls by primary key `id` without `entry_date`.

---

### Test Case 14: Basics Speed Drills & 7-Day History Grouping
- **Objective**: Verify that students can log multiple basics speed drills per day and review past sessions grouped by date.
- **Steps**:
  1. Navigate to `/pages/basics.html`.
  2. Select category `1d4r`.
  3. Enter `Correct: 19`, `Total: 20`, `Time: 0:45`.
  4. Leave Date preset as `"Today (Database IST)"`.
  5. Click **Save Drill Entry**.
  6. Repeat with `2d2r` for another drill entry.
- **Expected Result**:
  - Both drill sessions appear in the **"Today's Sessions"** list with accuracy colors and wrong counts.
  - The network payload does NOT contain `entry_date`.
  - The **"Past 7 Days History"** section displays earlier drills neatly grouped by date with drill counts.

---

### Test Case 15: 7-Day Backdating Trigger Enforcement & Database Error Toasts
- **Objective**: Verify that backdating beyond 7 days is rejected by the database and produces a friendly error toast.
- **Steps**:
  1. On `/pages/basics.html`, change the date preset to `"Pick earlier date"`.
  2. Pick a date 10 days in the past (or issue an API insert with `entry_date` 10 days ago).
  3. Click **Save Drill Entry**.
- **Expected Result**:
  - If the database trigger fires: `"You can only enter scores for the last 7 days."`.
  - A red error toast appears showing the exact database trigger message to the student.
  - No corrupted record is saved.

---

### Test Case 16: Admin Rounds Management & IST Next-Round Proposer
- **Objective**: Verify admin round creation, editing, and deletion guards.
- **Steps**:
  1. Log in as Admin (`ADMIN01` / `admin123`).
  2. Click **Rounds** in the top navigation bar (`/pages/rounds.html`).
  3. Notice all published rounds listed newest first with total score counts.
  4. Click **⚡ Add Next Round**.
  5. Notice the modal pre-fills `Round Number` with `max + 1` and `Round Date` with today's date in Indian Standard Time (IST).
---

### Test Case 17: Phase 3 Student Dashboard Top Cards (Greeting, Streak & Milestones, Today's To-Do)
- **Objective**: Verify that the student portal displays authoritative IST date, current/best streak, shields, milestones, and today's to-do checklist.
- **Steps**:
  1. Log in as Student `STU101` / `student123`.
  2. Navigate to `/pages/student.html`.
  3. Verify the Indian Standard Time date in the header matches today's IST date (`today_ist()`).
  4. Inspect the **Practice Streak** card:
     - Check that Current Streak and Best Streak display numbers from `streak_for`.
     - Check the shield counter and status (`Shield Ready` or `Next shield at day X`).
     - Check the milestone track: nodes $\le$ current streak are highlighted as `.reached`.
  5. Inspect the **Today's To-Do** card:
     - Check the progress indicator (e.g. `"4 of 7 done today"`).
     - Check that completed tasks have a green checkmark circle and strikethrough text.
     - Check that pending tasks have an empty circle.
- **Expected Result**:
  - All cards load cleanly without layout shifts.
  - No client-side clock calculations are performed.
  - If demo mode is active, the red banner `"DEMO MODE — data is fake"` appears at the top.

---

### Test Case 18: Today's To-Do Deep Links & Basics Preselection
- **Objective**: Verify clicking to-do tasks routes to the correct entry view and pre-fills categories.
- **Steps**:
  1. On `/pages/student.html`, click a Round task (e.g. `Round Drill: Addition`).
  2. Verify it routes directly to `/pages/round-scores.html`.
  3. Go back to `/pages/student.html` and click a Basics task (e.g. `Mental Basics: 2-digit 2-rows (2d2r)`).
  4. Verify it routes to `/pages/basics.html?cat=cat-bas-2`.
  5. Observe the **Drill Category** dropdown on `/pages/basics.html`.
- **Expected Result**:
  - The dropdown automatically preselects `2d2r` without manual student selection.
  - The student can immediately begin typing correct/total/time values.

---

### Test Case 19: Competition Score Sheet Table (5-Round Pagination, Sticky Column & Summary Rows)
- **Objective**: Verify the 5-round score sheet table renders competition categories as rows, rounds as columns, color-codes cells, computes summary rows, and scrolls with sticky first column.
- **Steps**:
  1. On `/pages/student.html`, scroll to the **Competition Round Score Sheet** section.
  2. Verify the 5 round columns displayed (newest first).
  3. Verify each cell shows `correct/total` and `mm:ss` time, color-coded by `js/scoreColors.js` (Green for 0 wrong, Orange for 1-10 wrong, Cyan for >10 wrong).
  4. Verify the 4 summary rows at the bottom:
     - `Time Taken`: Sum of all category times formatted as `mm:ss`.
     - `Final Score`: Sum of correct answers.
     - `Total Attempt`: Sum of total questions.
     - `Marks to Correct`: `Total Attempt - Final Score`.
  5. Verify that rounds with unattempted categories display a `PARTIAL` badge.
  6. Click `Older Rounds ←` button:
     - Verify table shifts to the previous batch of 5 older rounds.
     - Verify range header updates (e.g. `Rounds 235–239`).
     - Verify `Newer Rounds →` button becomes enabled.
  7. On mobile or narrow screen, scroll horizontally:
     - Verify the **Category** column stays pinned (sticky) to the left while rounds scroll smoothly underneath.
- **Expected Result**:
  - Pagination shifts by 5 rounds cleanly without reloading the page.
  - Calculation summaries update instantly per column.
  - Sticky column maintains visual alignment without text overlap.

---

### Test Case 20: Inline SVG Progress Charts (Accuracy, Speed & Category Drilldown)
- **Objective**: Verify that 30-day accuracy and speed charts render via inline SVG and provide interactive inspection.
- **Steps**:
  1. Scroll to the **Progress Analytics** section on `/pages/student.html`.
  2. Inspect the **Daily Accuracy Trend** chart:
     - Verify Y-axis scaled 0% to 100% with horizontal grid lines.
     - Verify polyline and green shaded area.
  3. Hover or tap on any circular data dot:
     - Verify tooltip popup displays the exact date, accuracy percentage, and `correct/total`.
  4. Inspect the **Daily Speed** chart:
     - Verify questions/minute trend line and blue shaded area.
     - Hover/tap on a data dot -> verify tooltip shows speed in `q/min` and total time taken.
  5. In the **Category History Drilldown** dropdown, select a category (e.g. `ADD` or `1d4r`):
     - Verify the last 10 entries appear in sequential progression bars.
     - Verify each entry displays accuracy %, score, time, and speed.
- **Expected Result**:
  - Charts are rendered entirely via `<svg>` with zero third-party chart libraries.
  - Tooltips reposition accurately on both desktop mouse hover and mobile tap.
  - Screen-reader accessible summary descriptions are present.

---

### Test Case 21: Admin Daily To-Do Management & Section Category Filtering
- **Objective**: Verify teachers can create, edit, reorder, and toggle daily tasks, and that category options dynamically match the chosen section.
- **Steps**:
  1. Log in as Admin (`ADMIN01` / `admin123`).
  2. Click **Daily To-Do** in the top navigation bar (`/pages/todos.html`).
  3. Click **+ Add Task**.
  4. In the modal, change **Section Track** to `basics`:
     - Observe the **Category Filter** dropdown: verify it lists only basics categories (`1d4r`, `2d2r`).
  5. Change **Section Track** to `round`:
     - Verify the category dropdown switches to list only round categories (`ADD`, `SUB`, etc.).
  6. Fill title `Daily Sprint`, section `round`, category `ADD`, and click **Save Task**.
  7. Test reordering: click the `▲` or `▼` buttons on any task row.
  8. Test toggle active: click **Deactivate** / **Activate**.
- **Expected Result**:
  - The new task appears in the table ordered by `sort_order`.
  - Reordering swaps positions smoothly and persists.
  - Toggling active status reflects immediately on student dashboards.

---

### Test Case 22: Admin Learning Resources Management & Protocol Validation
- **Objective**: Verify resources management and strict URL validation.
- **Steps**:
  1. As Admin, click **Resources** in the top navigation bar (`/pages/resources.html`).
  2. Click **+ Add Resource**.
  3. Enter an invalid URL: `javascript:alert(1)` or `ftp://files.com/doc`.
  4. Click **Save Resource**.
  5. Verify an error toast appears: `"URL must start with http:// or https://"`.
  6. Enter a valid URL: `https://trendzabacus.com/rules-2026.pdf`, title `World Championship Guide`, topic `Rules & Scoring`.
  7. Click **Save Resource**.
  8. Log in as Student `STU101` and view `/pages/student.html`.
- **Expected Result**:
  - Malformed and non-HTTP protocols are blocked client-side and database-side.
  - The newly created resource appears under the `Rules & Scoring` topic on the student portal.
  - Clicking the link opens in a new tab with `rel="noopener noreferrer"`.

---

### Test Case 23: Supabase Proxy Destination Verification & SSRF Refusal Tests
- **Objective**: Verify that `/api/supabase-proxy` strictly enforces exact-origin validation, rejects spoofed domains or embedded credentials with HTTP 403, and returns HTTP 404 on production.
- **Test 23.1: Subdomain spoofing attempt**:
  - Request:
    ```bash
    curl -X POST http://localhost:3000/api/supabase-proxy \
      -H "Content-Type: application/json" \
      -d '{"url":"https://<your-project-ref>.supabase.co.evil.example/rest/v1/x","method":"GET"}'
    ```
  - Expected Status: `403 Forbidden`
  - Expected Body: `{"error":"Forbidden: Target origin does not match configured Supabase project"}`
- **Test 23.2: Userinfo credential smuggling attempt**:
  - Request:
    ```bash
    curl -X POST http://localhost:3000/api/supabase-proxy \
      -H "Content-Type: application/json" \
      -d '{"url":"https://<your-project-ref>.supabase.co@evil.example/rest/v1/x","method":"GET"}'
    ```
  - Expected Status: `403 Forbidden`
  - Expected Body: `{"error":"Forbidden: Credentials in target URL are prohibited"}`
- **Test 23.3: Disallowed path attempt**:
  - Request: Target path starting with `/internal/` or `/pg/`
  - Expected Status: `403 Forbidden`
- **Test 23.4: Production environment lock**:
  - When `VERCEL_ENV === "production"`, any request to `/api/supabase-proxy` returns HTTP `404 Not Found`.

---

### Test Case 24: Production Configuration Lock & Demo Mode Host Restriction
- **Objective**: Verify that Demo Mode is restricted strictly to development hosts (`localhost`, `127.0.0.1`, `run.app`), and that unconfigured production environments display a full-page configuration error without leaking demo data or allowing fake mutations.
- **Test 24.1: Production Host with Missing / Placeholder Credentials**:
  - Emulate production hostname (e.g. `trendz.example.com` or `trendz.vercel.app`) with placeholder/empty Supabase credentials.
  - Expected Result:
    - Entire document body is replaced with: `Configuration error - Please contact the administrator.`
    - Zero demo data rendered.
    - `loginWithStudentId()` throws: `Configuration error - contact the administrator.`
    - Admin actions (`createStudent`, `resetStudentPassword`) throw configuration error.
- **Test 24.2: Development Host with Missing / Placeholder Credentials**:
  - On `localhost` or `*.run.app` with placeholder Supabase credentials.
  - Expected Result:
    - `isDemoMode()` evaluates to `true`.
    - Prominent `"DEMO MODE — data is fake"` banner is rendered.
    - Quick test credentials (`STU101`, `ADMIN01`) are available for local evaluation.

---

### Test Case 25: Build-Time `VITE_` Configuration & Static HTML Route Verification
- **Objective**: Verify that production builds fail on Vercel without valid environment variables, that production clients make zero requests to `/api/config`, and that every page opens directly at its `.html` address.
- **Test 25.1: Vercel Build Failure Without Variables**:
  - Run build simulating Vercel environment without variables:
    ```bash
    VERCEL=1 npm run build
    ```
  - Expected Result: Build aborts with non-zero exit code and error message:
    `[Vercel Build Error] Missing or invalid Supabase build environment variables. Both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be provided in Vercel project settings.`
- **Test 25.2: Zero `/api/config` Network Requests in Production**:
  - In a production build (`isDemoAllowedHost()` is false), inspect browser DevTools Network tab upon initial page load.
  - Expected Result:
    - No HTTP requests are made to `/api/config`.
    - Public Supabase client is immediately and synchronously initialized from build-time embedded literals (`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`).
- **Test 25.3: Pure Static `.html` Route Verification**:
  - Run `npm run build` and serve `dist` as static assets.
  - Request every page listed in `vite.config.ts`:
    - `GET /index.html` -> Status 200
    - `GET /pages/student.html` -> Status 200
    - `GET /pages/round-scores.html` -> Status 200
    - `GET /pages/basics.html` -> Status 200
    - `GET /pages/admin.html` -> Status 200
    - `GET /pages/categories.html` -> Status 200
    - `GET /pages/rounds.html` -> Status 200
    - `GET /pages/todos.html` -> Status 200
    - `GET /pages/resources.html` -> Status 200
    - `GET /pages/students.html` -> Status 200
  - Verify every internal anchor link, navigation redirect, and route guard targets the exact `.html` filename.

---

### Test Case 26: Admin Overview, Student Roster Move & Section Separation (Phase 3b-1)
- **Objective**: Verify that `/pages/admin.html` functions as the Overview dashboard, `/pages/students.html` contains the student roster, all 6 navigation links are synchronized, tasks/categories strictly respect section separation, and empty states span all columns.
- **Test 26.1: Admin 6-Item Navigation Order & Active Tab**:
  - Open `/pages/admin.html`: Nav shows `Overview` (active), `Students`, `Daily To-Do`, `Resources`, `Categories`, `Rounds`.
  - Click `Students`: Navigates to `/pages/students.html`, displaying Student Management roster with `Students` active.
  - Click `Daily To-Do`: Navigates to `/pages/todos.html` with `Daily To-Do` active.
- **Test 26.2: Admin Overview Summary Cards & Needs Attention**:
  - On `/pages/admin.html`, verify 5 top metric cards calculate correctly from `admin_overview()`:
    - Active Students count.
    - Entered Today (`n of N` active students).
    - Not Entered Today (`N - n`).
    - Average 7-Day Accuracy percentage.
    - Longest Current Streak with student name.
  - Verify `#needs-attention-box` appears when active students have `last_entry_date` >= 3 days ago in IST.
- **Test 26.3: In-Browser Table Search, Filter, Sort, and 25-Row Pagination**:
  - Type a student name or ID into `#search-overview`: table instantly filters in-memory.
  - Select a Level filter (e.g. `Level 3`): only Level 3 students display.
  - Select Status filter (`Done Today`, `Not Yet Today`, `Inactive`): table matches expected subset.
  - Click column headers (`Student Name`, `ID`, `Streak`, `Last Entry (IST)`): toggles ascending/descending sorting.
  - Test pagination with >25 students: 25 rows per page, Previous/Next buttons enable/disable properly.
- **Test 26.4: Pending Student Detail Link**:
  - In both Overview table and Students roster table, hover student name:
    - Tooltip displays `"Coming next"`.
    - Cursor displays `not-allowed`.
    - Link targets `/pages/student-detail.html?id=<student_id>`.
- **Test 26.5: Strict Section Separation**:
  - In `pages/todos.html`, verify tasks are visually partitioned under section divider headers (`🏆 Competition Rounds`, `⚡ Basics Speed Drills`, `🧩 Elements`, `⚡ Flash Anzan`).
  - In `pages/categories.html`, verify categories are grouped by section and sorted only within their respective section.
- **Test 26.6: Table Empty State Full-Width Colspan**:
  - In Resources table and Daily To-Do table with 0 items or no search matches:
    - Verify empty state spans all columns (`colspan="6"` or `colspan="7"`) centered in the table without squeezing into the first column.

---

### Test Case 27: Admin Review, Verification, Flagging, Correction & Audit History (Phase 4a)
- **Objective**: Verify that `/pages/review.html` correctly displays paginated student practice entries, enforces default unverified filtering, executes atomic verification/flagging/corrections through PostgreSQL RPCs, renders change history in the audit drawer, supports bulk verification up to 200 rows, and allows deep linking from the student detail page.
- **Test 27.1: Navigation & Admin Route Guard**:
  - Log in as Student `STU101`. Navigate to `/pages/review.html`.
  - Expected Result: Guard intercepts the attempt and immediately redirects to `/pages/student.html`.
  - Log in as Admin `ADMIN01`. Click **Review** in the top navigation bar.
  - Expected Result: Nav bar shows exact required order (`Overview`, `Review` [active], `Students`, `Attendance`, `Daily To-Do`, `Resources`, `Categories`, `Rounds`). Page loads with default filter `Unverified`.
- **Test 27.2: Server-Side Paginated Entry List & Filtering**:
  - Verify table displays 50 entries per page, newest first.
  - Check that each row displays: Student name & code, Category name & section, Round number / drill label, Score (correct/total) with wrong count badge colored by `js/scoreColors.js`, Time (mm:ss), Entry date in IST, Saved timestamp in IST, and Status chips (`🔒 Verified`, `✏️ Corrected`, `⚠️ Flagged`, or `Unverified`).
  - Search by student name (e.g. "Aarav") or ID ("STU101"): table updates immediately.
  - Filter by Section (e.g. "Basics Speed Drills"): category dropdown repopulates with matching categories only.
  - Filter by Status: switch between `Unverified`, `Verified`, `Flagged`, and `Corrected`.
- **Test 27.3: Single Verification and Unverification**:
  - On an unverified row, click **✓ Verify**.
  - Modal opens: "Verify Practice Entry" with default reason "Verified by teacher".
  - Click **Confirm**: invokes `admin_set_verified(p_ids, true, reason)`. Green toast appears: "1 entry verified."
  - Switch filter to `Verified`: row now displays `🔒 Verified` status chip and action button toggles to **Unverify**.
  - Click **Unverify**: confirms reason "Verification revoked by teacher". Invokes `admin_set_verified(p_ids, false, reason)`.
- **Test 27.4: Flagging with Teacher Note and Unflagging**:
  - Click **⚑ Flag** on a row.
  - Modal opens with textarea for note. Type: `"Please re-check your subtraction carrying on problem 7"`.
  - Submit: invokes `admin_set_flag(p_id, true, note)`. Toast confirms: "Entry flagged for student review."
  - Row displays `⚠️ Flagged` badge with note tooltip.
  - Click **Unflag**: confirms removal of flag. Invokes `admin_set_flag(p_id, false, null)`.
- **Test 27.5: Score Correction with Reason Validation**:
  - Click **✏️ Correct** on a row.
  - Modal opens pre-populated with correct answers, total, time, and student/category info.
  - Test validation 1: Enter correct = 25, total = 20. Submit.
    - Expected Result: Error toast: `"Correct answers cannot exceed total attempted."` Submission blocked.
  - Test validation 2: Enter correct = 18, total = 20, time = `01:45`, note = `"Teacher re-graded worksheet"`, leave reason empty. Submit.
    - Expected Result: Error toast: `"Audit reason must be at least 3 characters."` Submission blocked.
  - Enter reason: `"Verified with physical competition paper"`. Submit.
  - Expected Result: Invokes `admin_correct_result(p_id, 18, 20, 105, note, reason)`. Toast confirms correction. Row displays `✏️ Corrected` chip.
- **Test 27.6: Audit Trail Drawer (`result_audit`)**:
  - Click **📜** (History icon) on the corrected entry.
  - Audit drawer slides in from the right.
  - Verify it renders the list of changes in reverse chronological order:
    - Action badge (`Correct`, `Verify`, `Flag`).
    - Admin name who made the change.
    - Date and time in IST.
    - Rationale callout: `"Reason: Verified with physical competition paper"`.
    - Diff table displaying previous vs new values for `correct`, `total`, `time_seconds`, `note`, `corrected_at`.
- **Test 27.7: Bulk Verify (Up to 200 Entries)**:
  - Check the header checkbox or click **Select All Page**: all 50 checkboxes on the page check.
  - Bottom floating bulk bar appears: `"50 entries selected"`.
  - Click **✓ Bulk Verify (50)**.
  - Confirmation modal opens: `"Bulk Verify 50 Entries - Are you sure you want to verify all 50 selected practice entries?"`.
  - Click Confirm: invokes `admin_set_verified(p_ids, true, reason)` in one call. Toast confirms 50 entries verified.
  - Selection clears and bulk action bar hides.
- **Test 27.8: Deep Link from Student Detail Page**:
  - Navigate to `/pages/student-detail.html?id=usr-101`.
  - In the teacher banner at the top, click **🔍 Review entries**.
  - Expected Result: Opens `/pages/review.html?studentId=usr-101` with student search pre-filled to `usr-101`.

---

### Test Case 28: Student-Side Locks & Notices, Dashboard Markers & Attendance Card (Phase 4a)
- **Objective**: Verify that students see lock icons on verified entries, "Corrected by teacher" on corrected entries, active coach notes on flagged entries, cell markers on the dashboard matrix, and the attendance summary card.
- **Test 28.1: Round Scores Screen (`/pages/round-scores.html`)**:
  - Log in as Student `STU101`. Navigate to `/pages/round-scores.html`. Select Round 244.
  - For a verified category:
    - Input fields for correct, total, time, and note are `disabled` / `readonly`.
    - Status badge shows `🔒 Verified`.
    - Background has subtle locked tint. Row cannot be edited or submitted.
  - For a corrected category:
    - Input fields are `disabled` / `readonly`.
    - Status badge shows `✏️ Corrected by teacher`. Row cannot be overwritten by student.
  - For a flagged category:
    - Input fields remain fully enabled and editable.
    - Status column prominently displays: `⚠️ Your teacher asked you to check this entry` along with the teacher's note.
    - Student edits numbers, clicks **Save Round Scores**: save succeeds, allowing student to fix their typo.
- **Test 28.2: Basics Screen (`/pages/basics.html`)**:
  - Navigate to `/pages/basics.html`.
  - In the drills list:
    - Verified drill shows `🔒 Verified` lock indicator; Edit and Delete buttons are absent.
    - Corrected drill shows `✏️ Corrected by teacher`; Edit and Delete buttons are absent.
    - Flagged drill shows `⚠️ Your teacher asked you to check this entry: <note>`; Edit and Delete buttons remain available.
- **Test 28.3: Dashboard Score Table Cell Markers**:
  - Navigate to Student Home (`/pages/student.html`). Scroll to **Competition Round Score Sheet**.
  - Inspect matrix cells:
    - Verified cells show score with small lock marker `🔒`.
    - Corrected cells show score with small pencil marker `✏️`.
- **Test 28.4: Attendance Summary Card**:
  - On Student Home (`/pages/student.html`), locate the **Attendance** card.
  - Verify card displays:
    - Overall attendance percentage (e.g. `88%`).
    - Present count, Absent count, Excused count.
    - Footnote: *"Excused sessions are not counted."*
  - Navigate to Admin Student Detail (`/pages/student-detail.html?id=usr-101`).
  - Verify the exact same Attendance card renders with student `usr-101`'s authoritative data from `attendance_summary`.

---

### Test Case 29: Admin Attendance Management (`/pages/attendance.html`)
- **Objective**: Verify session creation, editing, active student roster grid, attendance status toggles, "Mark all present", unmarked warnings, and search/filtering.
- **Test 29.1: Admin Navigation & Route Guard**:
  - Access `/pages/attendance.html` as Student: blocked and redirected.
  - Access as Admin: Nav bar highlights `Attendance` in 4th position.
- **Test 29.2: Sessions List & Metrics**:
  - Left panel lists sessions in reverse chronological order.
  - Each item displays: Date (IST), Title, Session Type chip, and badge counts: `Present`, `Absent`, `Excused`, and `Unmarked`.
- **Test 29.3: Create and Edit Session Modal**:
  - Click **+ New Session**.
  - Modal opens: Date (pre-filled with today in IST), Title, Session Type (`Class`, `Workshop`, `Other`), Notes.
  - Enter: Title = `"Championship Mock Exam #4"`, Type = `"Workshop"`, Notes = `"Paper 1 and Paper 2"`.
  - Submit: Session created. Selected in left panel and details load in right panel.
  - Click **✏️ Edit**: change title to `"Championship Mock Exam #4 (Revised)"`. Save: session details update.
  - Verify no Delete button exists in Phase 4a.
- **Test 29.4: Active Students Roster Grid & Toggles**:
  - Right panel displays a row for every active student in the institute.
  - Each student row displays Name, Code, Level, Present/Absent/Excused toggle buttons, and an optional note input.
  - If no status is selected, row shows `Not marked`.
  - Click **✓ Present**: button highlights green, `Not marked` disappears, top Present counter increments.
  - Click **✗ Absent**: button highlights red, Absent counter increments.
  - Click **Ex Excused**: button highlights gray, Excused counter increments.
  - Type note: `"Arrived 15 minutes late due to traffic"`.
- **Test 29.5: "Mark All Present" Bulk Action**:
  - Click **✓ Mark All Present**.
  - Expected Result: Every active student in the roster is toggled to `Present`. Top Present count equals active students count. Unmarked count drops to 0. Toast confirms action.
- **Test 29.6: Unmarked Students Warning Before Save**:
  - Deselect marks for 2 students so they show `Not marked`.
  - Click **Save Attendance**.
  - Modal opens: `"Unmarked Students Warning - There are 2 active students without an attendance mark."`
  - Click **Go Back & Review**: modal closes without saving.
  - Click **Save Attendance** again, then click **Proceed & Save**:
    - Invokes upsert on `attendance` with `(session_id, student_id)`.
    - `marked_by` is stamped with the authenticated admin ID.
    - Toast confirms: `"Attendance saved successfully for N students."`
- **Test 29.7: Roster Search & Filter**:
  - Type `"Level 3"` in search box: grid instantly filters to students in Level 3.
  - Type a student ID (e.g. `"STU102"`): grid shows only Diya Patel.
  - Clear search: full active student roster restored.




