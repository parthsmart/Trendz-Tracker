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

---

### Test Case 30: Unified Modal Component Audit & Attendance Modal Fix (Phase 4b)
- **Objective**: Verify that all modals on `/pages/attendance.html` and across all admin and student pages render centered with a backdrop overlay, max-width 560px, close button, Escape key handling, and focus management.
- **Steps**:
  1. Log in as Admin and open `/pages/attendance.html`.
  2. Inspect the page before clicking any button: verify the "Create Attendance Session" form is completely hidden (`display: none`).
  3. Click **+ New Session**:
     - Verify the modal opens centered in the viewport with a dimmed backdrop overlay (`max-width: 560px`), styled inputs, large `✕` close button, and right-aligned `Cancel` / `Save Session` buttons.
  4. Press `Escape`: verify the modal closes and returns focus to the **+ New Session** trigger button.
  5. Repeat modal open/close checks on `/pages/targets.html`, `/pages/weekly-tests.html`, `/pages/review.html`, `/pages/students.html`, `/pages/todos.html`, `/pages/resources.html`, `/pages/categories.html`, `/pages/rounds.html`, and `/index.html`.

---

### Test Case 31: Admin Basics Targets (`/pages/targets.html`) & `results_with_target` Badges (Phase 4b)
- **Objective**: Verify creating, editing, and deactivating default and per-level basics target rules, and displaying `meets_target` chips from `results_with_target`.
- **Steps**:
  1. Log in as Admin and navigate to **Setup ▾ → Targets** (`/pages/targets.html`).
  2. Verify only `basics` section categories (`1d4r`, `2d2r`) are listed in `sort_order`.
  3. Click **+ Add Target Rule**:
     - Select category `1d4r`, leave Level empty (default rule), enter Min Accuracy `90`, Max Time `2:00`, and save.
     - Verify rule displays as `"Accuracy at least 90% and time at most 2:00"`.
  4. Add a level-specific rule for `1d4r` with Level `Level 2`, Min Accuracy `95`, Max Time `1:30`.
  5. Log in as Student and open `/pages/basics.html`:
     - Select `1d4r`: verify the student's applicable target benchmark is displayed above the form (`"Target: 90% accuracy in 2:00 or less"` or their level-specific rule).
     - Inspect saved drill rows: verify each row with an active target shows `🎯 Target met` or `⚠️ Below target` directly from `results_with_target.meets_target`.
  6. Open `/pages/student.html` and `/pages/review.html`:
     - Verify **Basics This Week** shows `🎯 X of Y met target` and Review rows display target badges.

---

### Test Case 32: Admin Weekly Tests (`/pages/weekly-tests.html`) & Student Weekly Tests Card (Phase 4b)
- **Objective**: Verify creating weekly tests, recording official teacher test scores by section-grouped category, keyboard navigation, and rendering the last 3 weekly tests on student dashboards.
- **Steps**:
  1. Log in as Admin and click **Weekly Tests** in the top navigation bar (`/pages/weekly-tests.html`).
  2. Click **+ New Weekly Test**:
     - Verify Date defaults to `today_ist()`. Enter Title `"Weekly Speed & Accuracy Sprint #43"`, Notes `"Basics & mental check"`, and click **Save Test**.
  3. In the right panel, inspect the **Category** dropdown:
     - Verify categories are grouped by `<optgroup>` with `⚡ Basics Track` first, never mixing sections in a flat list.
  4. Enter scores for active students:
     - Type `Correct: 19`, press `Enter` -> focus moves to `Total`. Type `20`, press `Enter` -> focus moves to `Time`. Type `1:35`, press `Enter` -> focus moves to the next student's `Correct` input.
     - Verify live wrong badge (`1 wrong`) and summary counter (`"N of M students entered"`).
     - Test validation: enter `Correct: 22`, `Total: 20` and click **Save Scores** -> verify error toast blocks saving.
  5. Save valid scores: verify rows show `"Entered by teacher"` and empty rows remain `"Not entered"`.
  6. Open `/pages/student.html` (as student) and `/pages/student-detail.html?id=usr-102` (as admin):
     - Verify the **Weekly Tests** card displays the student's last 3 tests with date, title, category scores, accuracy %, time, and overall accuracy across those 3 tests.

---

### Test Case 33: Admin CSV Score Sheet Import Preview & Parser Unit Tests (Phase 4c-1)
- **Objective**: Verify the pure hand-written CSV parser via `node:test` and test the read-only Admin Import Preview page (`/pages/import.html`).
- **Part A — Automated Node Test Suite**:
  1. Run `node --test tests/importParser.test.js` in the terminal.
  2. **Expected Result**: All 8 unit test suites pass (`0 fail`), verifying:
     - `colLabel(0) = 'A'`, `colLabel(25) = 'Z'`, `colLabel(26) = 'AA'`, `colLabel(153) = 'EX'`, and `cellRef(9, 14) = 'O10'`.
     - RFC-4180 CSV parsing with UTF-8 BOM, quoted fields, escaped quotes (`""`), newlines inside quotes, CRLF, and ragged rows.
     - Synthetic 2-block fixture: Block 1 (2 rounds + ignored `Round0` info at `C2`), Block 2 (3 rounds), `"NEW SIMULATOR"` hint at `H1` (not auto-assigned), built-in aliases (`"Calender"` -> `"Calendar"`, `"Time Elapse"` -> `"Time Elapsed"`), unmatched `"Currency"`, dots-only `D9` skipped as empty, plain number time `"75"` at `E5` flagged unreadable, Surprise Task ratio `379/384` included in round sum, Surprise Task text note stored as `note`, stray `"94/231"` at `O10` flagged and excluded from totals, `Time Taken` `"1:08:37"` = `4117s` and `"Without Time"` = `null`, and Block 2 Round 1 `Final Score` mismatch (`Sheet: 250, Computed: 255, Diff: +5`).
     - Edge cases: `"95/90"` unreadable score -> `INCOMPLETE` cross-checks, missing round headers error, out-of-order round dates warning, duplicate dates info, and mixed date formats (`21/8/26` + `8/21/26`) error under Auto.
- **Part B — Browser Preview UI (`/pages/import.html`)**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and click **Setup ▾ → Import** (`/pages/import.html`).
  2. Verify the privacy notice reads: `"The file is read in your browser and is not uploaded."`
  3. Search for a student by name or ID (`STU101`) in Step 1 and select them.
  4. Select a `.csv` file (or click **Load Sample 2-Block CSV** in Demo Mode).
  5. Verify Step 2 displays:
     - **Needs Attention** panel at the top listing the Block 2 Round 1 `Final Score` mismatch (`Sheet: 250, Sum of correct: 255, Diff: +5`), the stray value `"94/231"` at `O10`, the unreadable time `"75"` at `E5`, the unmatched category `"Currency"` at `B7`, and the ignored `Round0` at `C2`.
     - **Summary Cards**: `2 Blocks · 5 Rounds`, date ranges per block, cell status counts (`22 OK · 2 Empty · 1 Unreadable · 1 Stray · 1 Note`), and student name comparison.
     - **Per-Block Inspector**: editable Series Name (`Block 1 (left)`, `Block 2`), clickable `"NEW SIMULATOR" (H1)` hint, Category Mapping dropdown for `"Currency"`, Absent DB Categories info box, Round-by-Round table with interactive Cross-Check chips, and expandable **Cells (5) ▾** drawer showing cell coordinates (`D5`, `E5`, `D9`, `O10`).
     - **Bottom Bar**: active **Start over** button and disabled **Import** button (`"Import is added in the next step"`).

---

### Test Case 34: Admin CSV Import Part 2A — Simulator per Block, Category Resolution & Existing Data Comparison (Phase 4c-2a)
- **Objective**: Verify simulator series suggestions and confirmation per block, duplicate series blocking, 3-tier category resolution (`category_aliases` -> built-in aliases -> exact match), series membership checks (`category_series`), and read-only comparison against `student_rounds` and `results`.
- **Part A — Automated Node Test Suite**:
  1. Run `node --test tests/importParser.test.js tests/importResolver.test.js` in the terminal.
  2. **Expected Result**: All unit tests in both files pass (`0 fail`).
- **Part B — Browser Preview UI (`/pages/import.html`)**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and navigate to **Setup ▾ → Import** (`/pages/import.html`).
  2. Select student **Aarav Sharma (`STU101`)** in Step 1 and click **Load Sample 2-Block CSV** (or select a 2-block `.csv` file).
  3. **Simulator per Block**:
     - Verify Block 1 pre-selects **Old simulator (Suggested)** (because it contains `Currency`), shows `Round Range: Rounds 1–2 (2 rounds)` and `Date Range: 17 Aug 2026 – 21 Aug 2026`, and displays `Suggestion (Unconfirmed): Old simulator`.
     - Verify Block 2 pre-selects **New simulator (Suggested)** (because it contains `HCF and LCM` and `Approximation`), shows `File Label Hint: "NEW SIMULATOR" (H1)`, `Round Range: Rounds 1–3 (3 rounds)`, and `Date Range: 18 Aug 2026 – 20 Aug 2026`.
     - Click **Confirm Series** on Block 1 and Block 2 -> verify the unconfirmed series blocking errors clear and badges turn green (`✓ Confirmed`).
     - Change Block 2's dropdown to **Old simulator** -> verify a blocking error appears (`"Blocking error: Block 1 and Block 2 cannot use the same simulator series"`). Change Block 2 back to **New simulator** and confirm.
  4. **Category Resolution per Block**:
     - Verify `ADD`, `SUB`, `Currency`, `HCF and LCM`, `Approximation`, and `Surprise Task` show `3. Exact Match` and `✓ In Old simulator (#...)` / `✓ In New simulator (#...)`.
     - Verify `Calender` (Block 1) and `Time Elapse` (Block 2) show `2. Built-in Alias` (`→ Calendar`, `→ Time Elapsed`).
     - Verify the informational box below each block lists the categories from that block's selected simulator series that are absent from the block (ordered by `category_series.sort_order`).
  5. **Comparison with Existing Data**:
     - Inspect the **Comparison with Existing Database Records** summary panel and the **DB Comparison** column in each block's round table.
     - Expand **Cells (5) ▾** on rounds in Block 1 and Block 2: verify side-by-side `In CSV Sheet` vs `Existing in Database` values, including `Identical in DB`, `New Score`, `Conflict (score, time)`, `Protected (🔒 Verified — Keep DB)`, `Protected (✏️ Corrected — Keep DB)`, and `In DB Only (Kept)`.
     - Switch student in Step 1 to **Ananya Iyer (`STU104`)** -> verify all 5 rounds across both blocks update immediately to `NEW ROUND`.

---

### Test Case 35: Admin CSV Import Part 2B & 2C — Database Limit Mirroring, `validatePayload`, UI Polish, and Import / Undo Flow
- **Objective**: Verify that the import preview and execution plan mirror all PostgreSQL `admin_import_rounds` limits (`round_number 1..100000`, `round_date 2020-01-01..today_ist()`, `round_type <= 40 chars`, `time_taken_seconds 0..28800`, `cell time_seconds 0..14400`, `note <= 500 chars`, `<= 100 rounds` and `<= 3000 cells` per call), verify the Phase 4c-2c UI polish, and test importing and undoing a batch.
- **Part A — Automated Node Test Suite**:
  1. Run `node --test tests/*.test.js` in the terminal.
  2. **Expected Result**: All 24 unit tests across `tests/importParser.test.js`, `tests/importPlan.test.js`, and `tests/importResolver.test.js` pass (`0 fail`), verifying:
     - `Time Taken` of `59:23:00` (`213,780s`) emits a warning (`"Total time 59:23:00 at <cell> is more than 8 hours: the round will be imported WITHOUT a total time"`), sets `time_taken_seconds = null` in the payload, increments `overMaxTimeTakenRoundsCount` in acknowledgments, does not exclude the round, and passes `validatePayload(payload)`.
     - Exactly `8:00:00` (`28,800s`) is accepted; `8:00:01` (`28,801s`) is flagged and nullified.
     - Cell time `4:00:00` (`14,400s`) is accepted; `4:00:01` (`14,401s`) is marked `unreadable` (not imported).
     - Round dates after `today_ist()` or before `2020-01-01` exclude that round (`excluded = true`, `exclusionReason`) without failing the rest of the sheet.
     - `round_type` of 41 characters is truncated to 40 characters with a warning; `note` > 500 characters is truncated to 500 characters with a warning.
     - `Marks TO BE CORRECTED` check uses strict `Total Attempt - Final Score` (`calculatedMarksToBeCorrected = sumTotal - sumCorrect`), flagging Round 26 in Block 2 where sheet is `177` and calculated is `178`.
     - Duplicate dates within a block (`25 Jul 2026` and `16 Aug 2026`) emit two info lines (`25 Jul 2026` and `16 Aug 2026`) in chronological order.
     - `validatePayload(payload)` returns structured problems naming `{ roundNumber, field, value, message }` for each broken rule.
     - `chunkRoundsForImport` splits `101` rounds into 2 valid calls (`100` + `1`) and splits `> 3,000` cells into valid calls.
- **Part B — Browser UI Polish & Import Verification (`/pages/import.html`)**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and navigate to **Setup ▾ → Import** (`/pages/import.html`).
  2. **Spacing & Unified Student Picker**:
     - Verify there is normal vertical spacing (`24px`) between the top navigation bar and the first card so the card is not cut off.
     - Click the unified **Student** control (`#import-student-picker-trigger`): verify a single searchable dropdown opens with a search input and student rows, and selecting **Aarav Sharma (`STU101`)** clearly displays their name, code badge (`STU101`), and level in the trigger button.
  3. **Load Sample CSV & Inspect Needs Attention**:
     - Click **Load Sample 2-Block CSV** (or select your `.csv` sheet).
     - In the **Needs Attention** card:
       - Verify the heading badge shows exact severity counts matching the rows (e.g. `"5 warnings, 1 info"`).
       - Verify rows are grouped by severity (`Blocking Errors`, `Warnings`, `Info`).
       - Verify info rows are hidden by default behind a **"Show N info lines"** toggle button; click the toggle to reveal/hide info rows.
       - Verify each row places the severity badge (`ERROR`, `WARN`, `INFO`), the `Block X · Round Y` chip, and the cell coordinate chip (e.g. `E5`, `O10`, `DV31`) on the left, with the message text left-aligned immediately after them (and wrapping cleanly underneath on narrow screens) without repeating the cell coordinate in the sentence.
  4. **Inspect Summary Cards**:
     - Verify metric columns stack a small uppercase label above the large number and a short unit beneath (so `"2 Blocks"` and `"72 Rounds"` never wrap awkwardly mid-phrase).
     - Verify all numbers use thousands separators (e.g. `1,677`) and all short month names use 3-letter format (`Sep`, never `Sept`).
  5. **Confirm Series, Map Unmatched Category & Execute Import**:
     - Click **Confirm Series** on Block 1 (`Old simulator`) and Block 2 (`New simulator`).
     - In Block 1 Category Resolution, resolve `"Currency"` (e.g. map to `Currency` or `Create "Currency" as an inactive round category & link to series`).
     - Scroll to Step 3: inspect the **Acknowledgments & Excluded Rounds** summary box, confirm `validatePayload` reports 0 problems, and click **Import**.
     - In the Confirmation Modal (`#import-confirm-modal`), review the exact numbers and click **Confirm & Import Now**.
     - Verify the green **Import Completed Successfully** banner displays rounds created, existing rounds merged, scores inserted, and existing scores kept.
  6. **Verify Import History & Undo**:
     - Scroll to **Recent Imports (`import_batches`)** at the bottom of `/pages/import.html`.
     - Verify the completed batch row shows `✓ Completed`, student name, blocks, rounds/scores created, and an **Undo Import** button (and if any batch failed mid-flight, it shows `Open` with `0` rows).
     - Click **Undo Import**, enter a reason of at least 3 characters (e.g. `"Testing Phase 4c-2c undo flow"`), and click **Confirm Undo**.
     - Verify the batch status updates to `↩ Undone` with the undo timestamp and reason.

---

## Phase 5a Test Cases (Points, Leaderboards, Competition Settings & Leaderboard Visibility)

### Test Case 36: Student Dashboard Leaderboard Card (`/pages/student.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `student123`).
  2. On `/pages/student.html`, locate the **Leaderboard** card next to the Weekly Tests card.
- **Expected Result**:
  - The card displays the student's rank and points for **This Week** from the `points` board (e.g. `#1` and `215 points`), or `"Not on the board yet"` if the student has no points this week.
  - The card lists the **Top 3** names for the student's level with their points and highlights the student's own row with a `"You"` badge if in the top 3.
  - Clicking **Full leaderboard →** navigates to `/pages/leaderboard.html`.

### Test Case 37: Student Leaderboard Page (`/pages/leaderboard.html`)
- **Action**:
  1. Logged in as a Student (`STU101`), click **Leaderboard** in the top navigation bar (or **Full leaderboard →** on the dashboard card).
  2. Inspect the **"How it works"** box and switch between the 4 board tabs: **Points**, **Streak**, **Practice days**, and **Most improved**.
  3. On **Points** and **Practice days**, switch between **This week**, **This month**, and **All time**.
  4. Switch to **Streak** and **Most improved**.
- **Expected Result**:
  - The period switch (**This week**, **This month**, **All time**) is visible on **Points** and **Practice days** and automatically hidden on **Streak** and **Most improved**.
  - The **"How it works"** explanation updates dynamically per board using values from `competition_rules()` (e.g. multiplier `5`, attendance points `10`, minimum entries `5`) and always includes the note: *"Only your level is shown."*
  - Values display with their proper units (`points`, `days`, `days`, `+<x>% accuracy`). Raw scores and full last names are never shown.
  - The student's own row is highlighted with a `"You"` badge. When a student is ranked outside the top 10 (e.g. `#14`), a separator row appears below the top 10 followed by the student's own row.
  - If a board/period has no rows, an encouraging empty state is shown (e.g. *"No points yet this week. Weekly tests and sessions earn points."*).

### Test Case 38: Admin Leaderboard View (`/pages/leaderboard.html`)
- **Action**:
  1. Log Out and log in as an Admin (`ADMIN01` / `admin123`).
  2. Click **Leaderboard** in the main admin navigation bar.
  3. Use the **Level** dropdown to switch between `All levels` and a specific level (e.g. `Level 1`, `Level 2`), and switch across boards and periods.
  4. Click any student's display name in the table.
- **Expected Result**:
  - The page renders the Admin navigation bar (including `Setup ▾ → Competition`) and the Admin **Level** filter dropdown (`All levels` or distinct student levels).
  - Up to 200 rows are shown, no `"You"` badge is displayed, and the student-only note *"Only your level is shown."* is omitted.
  - Each student's display name is a link to `/pages/student-detail.html?id=<student_id>`.

### Test Case 39: Admin Competition Settings (`/pages/competition.html`)
- **Action**:
  1. Logged in as Admin (`ADMIN01`), open **Setup ▾ → Competition** (`/pages/competition.html`).
  2. Inspect the 4 settings: **Weekly test multiplier**, **Attendance present points**, **Most improved minimum entries**, and **Leaderboard display names**.
  3. Toggle the **Leaderboard display names** radio buttons between **First name + last initial** and **Student ID code** and observe the **Sample Student Preview** box.
  4. Try entering a negative or non-numeric value in a numeric field and click **Save**, then enter a valid number (e.g. `6` for Weekly test multiplier) and click **Save**.
- **Expected Result**:
  - Invalid/empty numbers are blocked with a friendly inline validation message before calling the database.
  - The **Sample Student Preview** immediately updates between `"Aarav S."` and `"STU101"`.
  - Clicking **Save** updates `public.competition_settings` for that key, shows an inline `"✓ Saved"` status + toast, and updates the live `"How it works"` summary on `/pages/leaderboard.html`.
  - Attempting to visit `/pages/competition.html` while logged in as a Student redirects away immediately via the admin-only guard.

### Test Case 40: Admin Students "Show on leaderboards" Toggle (`/pages/students.html`)
- **Action**:
  1. Logged in as Admin (`ADMIN01`), navigate to **Students** (`/pages/students.html`).
  2. Locate the **Show on leaderboards** column and hover over the `ⓘ` tooltip icon in the column header.
  3. Click the toggle button (`✓ Shown` / `Hidden`) for `STU101` (`Aarav Sharma`).
  4. Navigate to `/pages/leaderboard.html` and check the boards.
- **Expected Result**:
  - The header tooltip explains: *"Hidden students do not appear on any leaderboard."*
  - Clicking the toggle updates `profiles.leaderboard_visible` and switches the button state between `✓ Shown` and `Hidden` with a confirmation toast.
  - When a student is set to `Hidden` (`leaderboard_visible = false`), they no longer appear on any leaderboard.

---

## Phase 5c Test Cases (Nightly Google Sheet Backup & Manual Store ZIP Export)

### Test Case 41: Automated Unit & Integration Suite for Phase 5c (`tests/backup.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - All 54 unit tests across `tests/backup.test.js`, `tests/importParser.test.js`, `tests/importPlan.test.js`, `tests/importResolver.test.js`, `tests/monthlyReportPdf.test.js`, and `tests/reportEmail.test.js` pass (`0 fail`).
  - `tests/backup.test.js` verifies:
    - All 18 tables (12 snapshot + 6 append) and their primary keys and cursor columns in `api/_backupTables.js`.
    - `convertValueForSheets`, 49,000-character truncation (`[TRUNCATED]`), evolving append headers (`_backed_up_at`), and microsecond-preserving `buildKeysetOrFilter`.
    - RFC 4180 CSV formatting, formula-injection sanitization (`=`, `+`, `-`, `@`), IEEE 802.3 CRC-32 (`"123456789"` -> `0xCBF43926`), and round-trip PKZIP Store archive creation and parsing (`buildStoreZip` + `parseStoreZip`).
    - Ephemeral RSA-2048 RS256 JWT signing (`buildServiceAccountJwt`), OAuth2 token exchange and caching, HTTP 503 retry, and secret redaction (`sanitizeGoogleErrorMessage`).
    - `/api/backup` concurrency locking (`{ busy: true }` on unique constraint `23505`) and 8-second time-budget pause (`status: 'partial'`, `error: 'more to do'`).

### Test Case 42: Admin Backup Page & Manual ZIP Download (`/pages/backup.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and navigate to **Setup ▾ → Backup** (`/pages/backup.html`).
  2. Inspect the **Google Sheet Backup** card, **Cell Capacity** bar, **Per-Table Backup Status (18 Tables)** table, and **Recent Backup & Export Runs** table.
  3. Click **Download all data (ZIP)** (`#btn-download-zip`).
  4. Click **Back up to Google Sheet now** (`#btn-run-google-backup`).
- **Expected Result**:
  - **Download all data (ZIP)** reads all 18 tables in pages of 1,000 with live progress updates, downloads `trendz-backup-YYYY-MM-DD.zip` containing 18 `.csv` files + `README.txt`, and logs an `'export'` row in `backup_runs` via `admin_log_export`.
  - **Back up to Google Sheet now** executes up to 10 passes against `POST /api/backup` (`{ action: 'run' }`), updating table row counts, cell capacity, and the recent runs table after each pass.
  - On `/pages/admin.html` and `/pages/backup.html`, if the last completed backup is older than 2 days (or has never run), a clear warning banner is displayed with a direct link to `/pages/backup.html`.

---

## Phase 7 & Phase 8 Test Cases (Flash Anzan Trainer & Elements Timed Worksheet Drills)

### Test Case 43: Automated Unit Test Suite for Phase 7b & Phase 8 (`tests/flashStats.test.js`, `tests/flashTimeline.test.js`, `tests/drills.test.js`, `tests/drillStats.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - All unit tests across the repository pass (`0 fail`).
  - `tests/flashTimeline.test.js` verifies `buildTimeline(settings, count)` for `2`, `50`, and `1000` numbers (`2 * count + 1` events, exact millisecond offsets, `FLASH_BLANK_MS = 80`, and final `done` event).
  - `tests/flashStats.test.js` verifies `settingsKey` and `statsByKey` ignoring `questions` and `session_id`, combining old multi-question sets (`total > 1`) and new single-question tries (`total = 1`) via `sum(correct) / sum(total)`, `recentTries` (last 20 tries with `"Correct"`/`"Wrong"` and `"n of m correct"`), `triesThisWeek` in Indian time (`Asia/Kolkata`), and empty data.
  - `tests/drills.test.js` verifies:
    - Exact 1:1 parity between `js/drillCatalog.js` and `api/_drills.js` across all 18 drills.
    - 200 deterministic seeded runs for every one of the 18 drills (3,600 sets total) verifying question counts, non-empty prompts, canonical answers, and domain invariants (including non-square `n` and `(k-1)^2 < n < k^2` for `number_to_be_squared`, 20 distinct numbers for `squares_3d_4d`, non-negative answers for `minutes_to_seconds`, and `1 Year` as the 25th question in `time_conversion`).
    - All known mathematical examples from the specification (`Saturday -> 0`, `February (02) -> 4`, `1857 -> 2`, `3 Week -> 1814400`, `47 -> 2209`, `99 -> 970299`, `97 / 4 -> 24`, `97 / 7 -> 6`, `1261 -> [13, 97]`, `888 / 1554 -> 4/7`, `Jan. 10, 1700 - March 5, 1800 -> 4665600`, `7:00:00 - 19:00:00 -> 43200`, `12:30 - 25:10 -> 760`, `2000000 -> 1415`, `999 -> 998001`).
    - Answer parsing edge cases (`86,400` and `0086400`, prime factor separators `x`, `X`, `×`, `*`, `,`, space in either order, lowest-terms ratio `4/7` accepted while unreduced `8/14` is rejected, invalid/blank inputs returning `null` without throwing).
    - `buildDrillStartResponse` security check ensuring expected answers never appear in the start payload.
  - `tests/drillStats.test.js` verifies `bestForDrill`, `isNewPersonalBest`, `recentSets`, `setsThisWeek` (Monday–Sunday in `Asia/Kolkata`), and `summaryByDrill`.

### Test Case 44: Elements Catalog & Timed Worksheet Flow (`/pages/elements.html`, `/pages/element-drill.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `pass123`) and click **Elements** in the top navigation bar (or click **Open Elements →** on the student dashboard Elements card, or click **Start →** on a daily to-do task in section `'elements'`).
  2. Inspect the 5 drill groups (*Codes*, *Squares and cubes*, *Division*, *Time*, *Other*) and verify that **Modulo Calculation** displays **Coming soon** and its button is disabled.
  3. Click **Start →** on **Day Codes** (or any enabled drill) to open `/pages/element-drill.html?drill=day_codes`.
  4. On the intro screen, verify the title, question count, time limit, and answer-format hint, then click **Start**.
  5. Open DevTools Network tab and inspect the `POST /api/drill` (`action: 'start'`) response to confirm it contains `questions` (strings) and **no** expected answers.
  6. Type answers into several inputs, using `Enter` or `ArrowDown` to move to the next input, leave some blank, and click **Submit now** (or wait for the sticky countdown bar to reach `00:00`).
- **Expected Result**:
  - The worksheet grades on the server via `POST /api/drill` (`action: 'submit'`) and displays the Result & Review screen with `correct / attempted` (`n left blank`), accuracy %, time taken, mistake badge (`n wrong` with colour + text), `"New personal best!"` callout when earned, and a question-by-question table showing `Question`, `Your answer` (or `"Blank"`), `Correct answer`, and explicit `"Correct"` / `"Wrong"` badges.
  - Submitting with 0 attempted answers (`attempted === 0`) shows `"No questions were answered, so this attempt was not saved to your history."` and does not insert a row into `activity_results`.
  - Returning to `/pages/student.html` or `/pages/student-detail.html` shows the updated **Elements** summary card, **Personal Bests by Drill** table, and **Recent Elements Sets** table.

### Test Case 45: Phase 7b Flash Anzan One-Question-Per-Try Flow (`/pages/flash.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `pass123`) and open **Flash Anzan** (`/pages/flash.html`).
  2. Verify there are no preset buttons and no "questions per set" input. Test the **Numbers in the Question** control (`2` to `1000`) using `−`, `+`, `-10`, `+10`, `-100`, `+100`, and direct typing (e.g., type `1` or `1500` and blur to see it clamp silently to `2` or `1000`).
  3. Set **Numbers** to `400` and **Speed** to `1.0 s` (expected duration > 5 minutes) and click **Start Try →**. Confirm that the inline confirmation prompt (`"This will take about 7 minutes. Start?"`) appears before starting. Click **Cancel**, then set **Numbers** to `5` and **Speed** to `0.5 s` and click **Start Try →**.
  4. While the numbers are flashing, switch to another browser tab and switch back. Verify the try is immediately cancelled with the banner: *"You left the page, so this try was cancelled. Start again when you are ready."*
  5. Click **Start Try →** again and watch the `3, 2, 1` countdown and the flashing numbers with the thin progress bar.
  6. When the answer box appears, verify it accepts only digits `0–9` (no minus sign, max 10 digits). Type an answer and press `Enter` (or click **Submit**, or click **I don't know** to send `null`).
  7. On the Result screen, inspect the large **Correct** / **Wrong** banner, **Your Answer**, **Correct Answer**, **Time Taken**, **Settings**, and expand **Show the numbers** (shown when `count <= 100`). Test **Try again** (confirms settings and starts immediately) and **Change settings**.
  8. Inspect **Your results at these settings**, **Most-practised settings**, **Recent Flash Anzan History (Last 20 Tries)**, and the **Flash Anzan** card on `/pages/student.html` and `/pages/student-detail.html`.
- **Expected Result**:
  - Every completed try saves 1 question (`total = 1`, `correct = 1 | 0`) via `flash_submit`, while legacy multi-question rows display `"n of m correct"` in history and count accurately toward `statsByKey` (`sum(correct) / sum(total)`).
  - The shared Flash Anzan card displays **Tries This Week**, **Correct This Week**, and **Most-Practised Settings** with its success rate.

---

## Phase 9a Test Cases (Online Basics Practice One Question at a Time)

### Test Case 46: Automated Unit Test Suite for Phase 9a (`tests/drills.test.js`, `tests/drillPlayer.test.js`, `tests/practiceStats.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - All 113 unit tests across 26 suites pass (`0 fail`).
  - `tests/drills.test.js` verifies:
    - Category name recognition for `1d4r`, `2D2R`, `2d 4r`, `1dx1d`, `2dX1d`, `2d*1d`, `2d×1d`, `3d/1d`, `3d÷1d`, `2d / 1d`, and rejection of `"weird"`, `"0d3r"`, `"9d9r"`, `"1d/2d"`, and inactive categories.
    - 300 seeded sets for each of `1d4r`, `2d2r`, and `2d4r` verifying row count, digit range, positive first row, non-negative running total at every step, no equal adjacent numbers, and exact expected sum.
    - 100 seeded sets for `1dx1d` and `2dx1d` verifying factor ranges (`2..9` for 1-digit factors) and exact products.
    - 100 seeded sets for `2d/1d` and `3d/1d` verifying exact division, dividend digit count, divisor in `2..9`, and exact quotient.
    - Pure `checkSubmission(session, answers, now)` verifying correct/skipped/wrong/blank/spaced/comma answers, rejection of already-submitted, expired, wrong answer-count, too-long (`> 20` chars), and too-fast (`elapsed < questions * 0.6s`) submissions, and start response stripping of expected answers.
  - `tests/drillPlayer.test.js` verifies question order, skipping and revisiting skipped questions at the end of pass 1, building the `answers` array with `null` for unanswered items, and idempotent `finish()`.
  - `tests/practiceStats.test.js` verifies `bestResult` (highest accuracy first, then shorter time), `setsThisWeek` in Indian Standard Time (`Asia/Kolkata`), and empty data handling.

### Test Case 47: End-to-End Online Basics Practice Flow & `"Recorded by the site"` Provenance (`/pages/basics.html`, `/pages/basics-practice.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `pass123`) and navigate to **Basics** (`/pages/basics.html`) or inspect the **Today's To-Do** card on `/pages/student.html`.
  2. Click **Practice online** for `1d4r` (or `2d2r`) to open `/pages/basics-practice.html?cat=<category_id>`.
  3. On the Setup screen, switch between `5`, `10`, and `20` questions and verify the student's level target and Personal Best update. Select `5 Questions` and click **Start Practice**.
  4. Solve questions one at a time using `Enter` / **Next →** and **Skip** (verifying that skipped questions are revisited before finishing and that no Back button is shown).
  5. Inspect the Results screen, then click **Back to basics** (`/pages/basics.html`) and inspect `/pages/student.html`, `/pages/student-detail.html`, and `/pages/review.html`.
- **Expected Result**:
  - The Results screen shows **"✓ This set was saved to your scores."**, score (`correct / total`), accuracy, time, mistake badge (`n wrong`), **`🎯 Target met`** / **`⚠️ Below target`** chip from `results_with_target`, and the question-by-question review table.
  - On `/pages/basics.html`, Student Home, `/pages/student-detail.html`, and `/pages/review.html`, rows with `source = 'site'` display the **`Recorded by the site`** chip (not `"Verified by teacher"`) and have no Edit or Delete buttons, while manually entered rows (`source = 'typed'`) display **`Typed`** (and **`🔒 Verified`** if verified by a teacher).

---

## Phase 8c Test Cases (Elements Worksheet Keyboard Shortcuts & Active-Question Highlight)

### Test Case 48: Automated Unit Tests for Shared Competition Keys (`tests/competitionKeys.test.js`)
- **Action**:
  1. Run `node --test tests/competitionKeys.test.js` (or `node --test tests/*.test.js`) in the terminal.
- **Expected Result**:
  - All tests in `tests/competitionKeys.test.js` pass (`0 fail`), verifying:
    - `'next'` is returned for `key: '+'` and `code: 'NumpadAdd'`.
    - `'previous'` is returned for `key: '-'` (hyphen-minus), `key: '−'` (`\u2212` minus sign), and `code: 'NumpadSubtract'`.
    - `'step'` is returned for `key: '*'` and `code: 'NumpadMultiply'`.
    - `null` is returned whenever `ctrlKey`, `altKey`, or `metaKey` is `true`.
    - `null` is returned for digits, `Enter`, `Tab`, arrow keys, `/`, `^`, and `null`/`undefined`.

### Test Case 49: Elements Worksheet `+` / `-` Navigation, Prime Factor `*` Entry, Active-Question Highlight Toggle & Touch Buttons (`/pages/element-drill.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `pass123`), open **Elements** (`/pages/elements.html`), choose any drill (e.g. **Day Codes** or **Squares 11 to 50**), and click **Start Worksheet →**.
  2. Verify the one-line hint directly under the timer reads: `"Numpad: + next question, - previous question"`.
  3. With Question 1 focused, type a digit and press `+` (both on the numpad and on the main keyboard). Verify that no `+` character is inserted into Question 1 and focus moves to Question 2.
  4. Press `-` (on the numpad or main keyboard). Verify that no `-` character is inserted and focus moves back to Question 1. Press `-` again on Question 1 and verify focus stays on Question 1 (no wrap-around). Navigate to the last question and press `+` to verify focus stops at the last question (no wrap-around).
  5. Test `Enter`, `Tab`, `ArrowDown`, and `ArrowUp` to confirm they still work as before, and test `Ctrl +` / `Ctrl -` to confirm modifier shortcuts are never intercepted.
  6. Open the **Prime Factors** drill (`/pages/element-drill.html?drill=prime_factors`), start the worksheet, and type `2^2*5*13` in an answer box. Verify that `*` (both normal `*` and `NumpadMultiply`) inserts `*` into the input while `+` and `-` move between questions.
  7. Inspect the focused question row: verify it has both a coloured background and a thicker border, and smoothly scrolls into view as you move down the worksheet. Uncheck **"Highlight the active question"**, verify the highlight disappears immediately, reload the page, and start a worksheet again to confirm the preference was remembered in `localStorage`.
  8. On a touch device (or using browser DevTools mobile device emulation), verify the small **Previous** and **Next** buttons appear next to the timer and move focus to the previous/next question (stopping at the first and last question).
- **Expected Result**:
  - `+` and `-` cleanly move focus to the next/previous question input without inserting characters or wrapping around, `*` works normally in Prime Factors, active-question highlight + smooth scroll respects the persistent toggle, and touch devices show working **Previous** and **Next** buttons next to the timer.

---

## Phase 9b-1 Test Cases (Memoriad Competition Practice: Mental Calendar Dates & Mental Additions)

### Test Case 50: Automated Unit Test Suite for Phase 9b-1 (`tests/memoriadServer.test.js`, `tests/answerSlots.test.js`, `tests/columnHighlight.test.js`, `tests/calendarKeys.test.js`, `tests/memoriadFormat.test.js`, `tests/memoriadStats.test.js`, `tests/competitionKeys.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - All unit tests across the repository pass (`0 fail`), verifying:
    - `tests/competitionKeys.test.js`: `'next'` (`+`/`NumpadAdd`), `'previous'` (`-`/`−`/`NumpadSubtract`), `'step'` (`*`/`NumpadMultiply`), `'unstep'` (`/`/`NumpadDivide`), modifier key rejection (`Ctrl`, `Alt`, `Meta`), and `null` for other keys.
    - `tests/memoriadServer.test.js`: Calendar date generation (`25, 50, 75, 100, 125` distinct valid Gregorian dates in `1600..2099`, leap-year rules, weekday checks for `2000-01-01 = Saturday`, `1969-07-20 = Sunday`, `1600-01-01 = Saturday`), Additions generation (10 questions of ten 10-digit numbers with no leading zero and exact `BigInt` sum), evaluation (correct, wrong, blank, leading zeros `"000123"`), plausibility rejection (`< 0.25s/attempt` for Calendar, `< 3s/attempt` for Additions), and stripping of `expected` from the start response.
    - `tests/answerSlots.test.js`: `typeDigit`, `moveCursorLeft`, `moveCursorRight`, `backspace`, `compact`, and `toAnswerString` in both `'rtl'` and `'ltr'` directions.
    - `tests/columnHighlight.test.js`: `highlightedColumns` in `'rtl'` and `'ltr'` directions, `1` and `2` columns per step, manual step offsets, and clamping after the last column.
    - `tests/calendarKeys.test.js`: `dayForKey` for default Saturday (`0 -> Sat, 1 -> Sun, 2 -> Mon, ..., 7 -> Sat`), custom Wednesday (`0 -> Wed, 1 -> Thu, ..., 7 -> Wed`), and `null` for other keys.
    - `tests/memoriadFormat.test.js`: `formatCalendarDate` (`DD-MM-YYYY`, `MM-DD-YYYY`, `YYYY-MM-DD`), `formatDayLabel` (`MON-TUE-WED...`, `Mo-Tu-We...`, full names), and `getOrderedWeekdays`.
    - `tests/memoriadStats.test.js`: best score ranking (highest `correct`, then higher accuracy, then shorter time), Calendar grouping by `dates`, tries this week in India time (`Asia/Kolkata`), and empty data handling.

### Test Case 51: End-to-End Memoriad Competition Practice Flow (`/pages/memoriad.html`, `/pages/memoriad-play.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `student123`) on a laptop or desktop screen ($\ge 1000\text{ px}$ wide) and click **Memoriad** in the top navigation bar (or **Open Memoriad →** on the Student Home **Memoriad Practice** card).
  2. On `/pages/memoriad.html`, verify the 4 module cards: **Mental Calendar Dates** (available), **Mental Additions** (available), **Mental Multiplications** (`Coming soon`, disabled), and **Mental Square Roots** (`Coming soon`, disabled), along with Personal Best and Last 5 Tries (India time).
  3. Click **Start Mental Calendar Dates →** (`/pages/memoriad-play.html?module=calendar`):
     - Change **Day abbreviation style**, **Leftmost day button**, **Day that key `0` stands for** (observe the live `0 → ..., 7 → ...` preview), **Question date format**, **Number of dates** (`25`), and **Concentration countdown** (`3` seconds). Click **Start Competition Stage →**.
     - Verify the top navigation bar hides during the `3, 2, 1` concentration countdown and that questions are not shown in the DOM until the countdown reaches `0`.
     - On the stage, press keys `0`–`7` to choose weekdays and verify focus automatically jumps to the next unanswered date; test `Enter` (skip), `+`/`-` or arrow keys (next/previous without wrap), and clicking a date in the 3-column list. Click **FINISH** to submit.
     - Verify the Results screen shows **SCORE**, used time with 2 decimals, correct, attempted, `"Saved to your scores."`, and the full question-by-question table with `✓ Correct` / `✗ Wrong` / `— Not answered`.
  4. Click **Back to Memoriad** and click **Start Mental Additions →** (`/pages/memoriad-play.html?module=additions`):
     - Choose **Typing direction** (`Right to left` or `Left to right`) and **Number of columns to highlight** (`1` or `2`), then click **Start Competition Stage →**.
     - Type digits `0`–`9` into the 11 answer slots and verify the active column highlight shifts automatically; press `*` (`NumpadMultiply`) to step the column highlight forward and `/` (`NumpadDivide`) to step it back; press `ArrowLeft`/`ArrowRight` and `Backspace`; press `+`/`-` to move between the 10 questions; press `Enter` to close any blank gap (`compact`) and move to the next question.
     - Click **FINISH** and verify the Results screen, then check `/pages/student.html` and `/pages/student-detail.html` (as Admin) to confirm the **Memoriad Practice** card updates and Admin **Daily To-Do** (`Setup ▾ → Daily To-Do`) includes the `Memoriad` section option.
  5. Resize the browser window narrower than `1000 px` on `/pages/memoriad-play.html`: verify the friendly message *"Use a laptop or desktop with a keyboard for this practice"* is shown with a link back to `/pages/memoriad.html`.

---

## Phase 9b-1b Test Cases (Time Limits, Official Calendar Two-Mistake Scoring Rule & Up-to-4-Column Group Typing)

### Test Case 52: Automated Unit Test Suite for Phase 9b-1b (`tests/memoriadServer.test.js`, `tests/answerSlots.test.js`, `tests/columnHighlight.test.js`, `tests/memoriadStats.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - All unit tests across the repository pass (`0 fail`), verifying:
    - **Config Parity & Time Limits (`tests/memoriadServer.test.js`)**: `api/_memoriad.js` and `js/memoriadConfig.js` match (`calendar: 60`, `additions: 600`, `multiplications: 900`, `square_roots: 900`, `MEMORIAD_EXPIRY_GRACE_SECONDS: 30`); `computeMemoriadExpiresAtMs` computes `start + concentration_seconds + limit + 30s`; `computeMemoriadUsedSeconds` caps at `limit` and never drops below `0`; `validateFinishedBy` accepts only `'finish'` or `'time_up'`.
    - **Official Calendar Scoring Rule (`tests/memoriadServer.test.js`)**:
      - `[C, W, C, C]` $\to$ `score: 3, correct: 3, wrong: 1`
      - `[C, W, C, W, C, C]` $\to$ `score: 2, correct: 4, wrong: 2`
      - `[W, W, C]` $\to$ `score: 0, correct: 1, wrong: 2`
      - Skipped questions (`null` or `''`) in between change nothing.
    - **Additions Group Typing (`tests/answerSlots.test.js`)**:
      - `g = 2` on `11` slots: typing `1, 2, 3, 4` fills slots `7..10` with `3, 4, 1, 2` (`"3412"`); typing 5 pairs (10 digits) reaches slot `1` and the 11th digit lands in slot `0`.
      - `g = 3` and `g = 4` group typing including leftmost partial groups (`[0, 1]` for `g = 3`, `[0, 1, 2]` for `g = 4`).
      - `Backspace` in the middle of a group removes the most recently typed digit via `history` and moves the cursor back to its slot.
      - Arrow keys (`Left` / `Right`) move the cursor one slot freely and typing overwrites and continues by the same group rules; `Enter` (`compact`) closes blank gaps.
    - **Additions Column Highlight (`tests/columnHighlight.test.js`)**:
      - `g = 1, 2, 3, 4` on `10` columns in both `rtl` and `ltr` modes, including shorter leftmost blocks (`[0]` for `g = 3`, `[0, 1]` for `g = 4`) and keeping the last block highlighted after all columns are completed.

### Test Case 53: End-to-End Time Limits, Last-10s Notice, Calendar Two-Mistake Scoring & 1–4 Column Group Typing (`/pages/memoriad-play.html`, `/pages/memoriad.html`)
- **Action**:
  1. Open **Mental Calendar Dates** (`/pages/memoriad-play.html?module=calendar`) and verify the Settings card displays fixed information **`Time limit: 1 minute`** alongside Concentration countdown (`0–120s`).
  2. Set **Show timer during stage** to `No (hide stopwatch display)` and **Concentration countdown** to `0`, then click **Start Competition Stage →**.
  3. Verify the top bar shows **`Limit 01:00`**. Enter a pattern of answers with 2 wrong answers followed by additional correct answers (e.g. Q1 right, Q2 wrong, Q3 right, Q4 wrong, Q5 right) and wait until the last 10 seconds (`00:50` elapsed):
     - Confirm the high-contrast **`⚠ TIME ENDING: Xs left`** countdown notice appears in the last 10 seconds **even though the stopwatch display is hidden**.
     - Let the 60-second limit expire: verify inputs lock immediately and the session submits automatically with `finished_by = 'time_up'`.
  4. On the Results screen, verify **`SCORE`** and **`# of Correct Answers`** are shown in separate metric cards (e.g. `SCORE = 2` and `# of Correct Answers = 3`), and check `/pages/memoriad.html` and the Student Home **Memoriad Practice** card to confirm `Score` is displayed as the primary number for Calendar.
  5. Open **Mental Additions** (`/pages/memoriad-play.html?module=additions`):
     - Verify the Settings card displays fixed information **`Time limit: 10 minutes`** and **Number of columns to be highlighted** offers `1`, `2`, `3`, and `4`.
     - Select `2 columns` (or `3` / `4` columns) with `Right to left` typing and start the stage: verify the top bar shows **`Limit 10:00`**, the rightmost `g` columns are highlighted, the cursor starts at slot `11 - g`, typing `1, 2, 3, 4` with `g = 2` produces `3412` in slots `7..10`, and pressing `Backspace` removes the most recently typed digit and returns the cursor to that slot.


---

### Phase 9b-2 — Mental Multiplications, Mental Square Roots, Step Boxes & Exit Button Fix

57. **Automated Unit Tests for Multiplications, Square Roots & Step Boxes (`node --test`)**
    - **Action**: Run `node --test tests/memoriadServer.test.js tests/stepBoxes.test.js tests/memoriadStats.test.js` (or `node --test tests/*.test.js`).
    - **Expected**:
      - `tests/memoriadServer.test.js` passes all tests for:
        - `multiplications`: 10 pairs of 8-digit numbers, exact `BigInt` product (`39951857 * 81044514 = 3237878833962498`), leading zero stripping, trailing zero significance, and `attempted * 5s` plausibility.
        - `square_roots`: seeded generator never produces perfect squares and keeps radicands in `100000..999999`; exact half-up rounding matches known values (`258524 -> 508.45255`, `850772 -> 922.37303`, `115456 -> 339.78817`, `457832 -> 676.63284`, `453077 -> 673.10995`); triangular prefix-digit points (`673.10995` with `675` -> `k=2, 3 pts`; 6 right + 2 wrong -> `21 pts`; all 8 right -> `36 pts`; wrong 3rd digit with later digits right -> `k=2, 3 pts`; blank -> `0 pts`).
      - `tests/stepBoxes.test.js` passes all tests for Multiplications (`n = 8`, presses `1..16` checking `1..8` from the right then leaving `7..1` on the left then `0`, repeating, `/` ignored, sequential click guard) and Square Roots (`n = 6`, `*` checks left-to-right up to 6, `/` unchecks right-to-left down to 0, no wrap-around).
      - `tests/memoriadStats.test.js` verifies that Square Roots ranks by highest `score` then shorter time, and Multiplications ranks by highest `correct` then shorter time.

58. **Interactive Stage Verification for Exit Button, Multiplications & Square Roots**
    - **Action**:
      - Open `/pages/memoriad.html` and verify all 4 competition modules (**Mental Calendar Dates**, **Mental Additions**, **Mental Multiplications**, **Mental Square Roots**) are active.
      - Start any module, click **Exit** during Concentration or Stage, and confirm the **"Discard This Practice Try?"** dialog opens immediately and returns to Settings when confirmed.
      - Open `/pages/memoriad-play.html?module=multiplications`, verify `"Time limit: 15 minutes"` and the disabled `"Side by side (coming later)"` option, start the stage, press `*` 1 to 16 times (or click the dashed step box in sequence) to verify the 8 step boxes and operand digit columns highlight from right to left and then uncheck from right to left, type into the 16 answer slots, and click **FINISH**.
      - Open `/pages/memoriad-play.html?module=square_roots`, start the stage, press `*` and `/` to check/uncheck the 6 step boxes from left to right, type digits into the `___ . _____` answer slots, and click **FINISH** to verify the Results table displays **Correct Digits (`k / 8`)** and **Points** per question.

---

### Phase 10b — Admin Daily To-Do Fixes (`js/todoForm.js`, `/pages/todos.html`, `js/todos.js`, Student Deep Links)

59. **Automated Unit Tests for Daily To-Do Form, Section Options & Student Links (`tests/todoForm.test.js`)**
    - **Action**: Run `node --test tests/todoForm.test.js` (or `node --test tests/*.test.js`).
    - **Expected**:
      - `normalizeTaskInput`: turns `""` and whitespace-only strings into `null` for `category_id`, `activity_key`, and `level`; never sets both `category_id` and `activity_key` across all 5 sections (`basics`, `round`, `elements`, `memoriad`, `flash`); rejects empty titles, 81-character titles (allows 80), and 31-character levels (allows 30).
      - `optionsForSection`: returns only active categories of that exact section for `'basics'` and `'round'` (never mixed); returns only enabled drills from `js/drillCatalog.js` for `'elements'` (excludes disabled `modulo`); returns the 4 modules (`calendar`, `additions`, `multiplications`, `square_roots`) for `'memoriad'`; returns `[]` for `'flash'`.
      - `taskLink`: returns `/pages/basics.html?cat=<id>` (basics with category), `/pages/basics.html` (basics without), `/pages/round-scores.html` (round), `/pages/element-drill.html?drill=<key>` (elements with key), `/pages/elements.html` (elements without), `/pages/memoriad-play.html?module=<key>` (memoriad with key), `/pages/memoriad.html` (memoriad without), and `/pages/flash.html` (flash).
      - `formatTaskTarget`: returns `"Any activity in <Section>"` when no specific category or activity key is set, never `"Unknown Category"`.

60. **End-to-End Admin Daily To-Do & Student To-Do Links Verification (`/pages/todos.html`, `/pages/student.html`)**
    - **Action**:
      - Log in as Admin and open **Setup ▾ → Daily To-Do** (`/pages/todos.html`).
      - Click **+ Add Task**, switch **Section Track** across `Round`, `Basics`, `Elements`, `Memoriad`, and `Flash Anzan`, and verify the second dropdown updates its label and options (`active round categories`, `active basics categories`, `enabled Elements drills`, `4 Memoriad modules`, and disabled `"Any Flash Anzan round"` for Flash Anzan).
      - Save tasks with and without a specific category/drill/module and verify the success toast displays `"Task added successfully"` (not `"error"`) and the table displays either the specific category/drill/module title or *"Any activity in <Section>"* (never *"Unknown Category"*).
      - Log in as Student (`STU101`), inspect the **Today's To-Do** card on `/pages/student.html`, and verify each **Start →** button links to the exact target page computed by `taskLink`.

---

### Phase 10c — Admin Profile Editing & Audit Log, New Calendar Date Formats, and Flat Rounds

61. **Automated Unit Tests for Profile Form, Calendar Date Formats & Flat Rounds (`node --test`)**
    - **Action**: Run `node --test tests/profileForm.test.js tests/memoriadFormat.test.js tests/roundType.test.js` (or `node --test tests/*.test.js`).
    - **Expected**:
      - `tests/profileForm.test.js`: verifies trimming, `full_name` length limits (`2..60`), `level` length limits (`1..30`), empty `level` becoming `null`, case-insensitive `suggestLevel(levels, typed)` (`"junior 1"` -> `"Junior 1"`), and `diffProfileFields` returning only changed fields.
      - `tests/memoriadFormat.test.js`: verifies `formatCalendarDate(1873, 11, 24, 'DD Mon YYYY') === '24 Nov 1873'`, `formatCalendarDate(1873, 11, 24, 'DD-Mon-YYYY') === '24-Nov-1873'`, zero-padded single-digit days (`04 Nov 1873`, `04-Nov-1873`), all twelve English 3-letter month names (`Jan..Dec`), and fallback to `'DD-MM-YYYY'` when the saved setting is missing.
      - `tests/roundType.test.js`: verifies `isFlatRound` returns `true` for `'Flat Round'`, `'Flat round'`, `'  FLAT  '` and `false` for `'Category wise'`, `''`, `null`, or unknown strings, and verifies `buildRoundScoreMatrix` flags flat cells while keeping the round's total time in the `Time Taken` summary row.

62. **End-to-End Admin Profile Edit & Change History Verification (`/pages/students.html`, `/pages/student-detail.html`)**
    - **Action**:
      - Log in as Admin and open **Students** (`/pages/students.html`).
      - Click **Edit** on a student row:
        - Verify **Student ID** is read-only and hovering over it shows *"The student ID is the login name and cannot be changed here"*, and verify no Role field is shown.
        - Verify the note above the **Level** field reads: *"Changing the level moves this student to another leaderboard group and changes which targets and tasks apply."*
        - Type an existing level with different casing (e.g. `level 2` when `Level 2` exists): verify *"Did you mean 'Level 2'?"* appears with a button that fills `Level 2`.
        - Update the student's Full Name, Level, Show on leaderboards, or Active status and click **Save Changes**: verify a single `profiles` update saves only changed fields and refreshes the table.
      - Click **Change history** on that student (or open `/pages/student-detail.html?id=<id>` and click **Edit** / **Change history**):
        - Verify the drawer opens showing `profile_audit` entries newest-first with the date in India time (`IST`), the admin's name, and each changed field as `old value → new value`.

63. **End-to-End Memoriad Calendar Date Formats & Flat Round Time Hiding Verification**
    - **Action**:
      - Open **Memoriad → Mental Calendar Dates** (`/pages/memoriad-play.html?module=calendar`), open the **Date format** dropdown, and verify **`DD Mon YYYY (24 Nov 1873)`** and **`DD-Mon-YYYY (24-Nov-1873)`** are available alongside the default `DD-MM-YYYY`. Start a stage with `DD Mon YYYY` and verify the question list, large display, and results table all format dates as `24 Nov 1873`.
      - Open **Round Scores** (`/pages/round-scores.html`):
        - Type values into **Correct**, **Total**, and **Time (mm:ss)** for a category while **Round Type** is `Category wise`.
        - Switch **Round Type** to `Flat Round`: verify the per-category **Time (mm:ss)** column and inputs hide immediately while **Correct**, **Total**, and **Total Time Taken** remain intact and typed values are preserved when switching back.
        - Save a `Flat Round` entry and inspect the **Competition Round Score Sheet** on `/pages/student.html` and `/pages/student-detail.html`: verify flat round cells show only `correct/total` (no per-category time) while the **Time Taken** summary row continues to show the round's total time.


---

## Phase 10d Test Cases (Readable Google Sheets Score-Sheet Mirror)

### Test Case 54: Automated Unit & Round-Trip Test Suite (`tests/mirror.test.js` & `tests/reportEmail.test.js`)
- **Action**:
  1. Run `node --test tests/mirror.test.js tests/reportEmail.test.js` in the terminal.
- **Expected Result**:
  - All unit tests pass (`0 fail`), verifying:
    - Colour boundaries (`0` wrong $\rightarrow$ `green` `#00E000`; `1` wrong $\rightarrow$ `orange` `#FF9900`; `10` wrong $\rightarrow$ `orange` `#FF9900`; `11` wrong $\rightarrow$ `cyan` `#00E5FF`; `total = 0` $\rightarrow$ `null`).
    - Single series with two rounds (newest on the left): exact cell coordinates for `Name -- <FULL NAME IN CAPITALS>`, student level in capitals above each Score column, `ROUND 2` and `ROUND 1`, `Date - dd/mm/yyyy`, `Score` / `Time` headers, category rows, 1 empty separator row, and 5 bold uncoloured summary rows (`Round Type`, `Time Taken`, `Final Score`, `Total Attempt`, `Marks TO BE CORRECTED`).
    - Flat round: per-category `Time` cells are empty while `Time Taken` displays `hh:mm:ss`.
    - Round without time: `Time Taken` displays `"Without time"`.
    - Surprise Task: numeric score (`"5/6"`) is coloured and counted in `Final Score` and `Total Attempt`; text note is uncoloured and not counted; empty is `"........"`.
    - Two series (current + old): current series is placed on the left, separated by two empty columns (`30 px` each), and shorter blocks are padded with empty rows so the 5 summary rows line up across all blocks.
    - `tabNameFor`: strips `trendz_`, removes `[ ] * ? : / \`, caps length at 95 characters, and disambiguates duplicates (`" 2"`, `" 3"`).
    - `staleStudents`: returns only students whose fingerprint differs or who have no row in `mirror_state`, ordered never-built first, then oldest `last_built_at` first.
    - Round-trip CSV verification: converting `buildStudentTabModel(data)` to CSV via `modelToCsv` and feeding it into `parseScoreSheetCsv` (`js/importParser.js`) produces matching rounds, dates, round types, category scores/times, and `Final Score` with `finalScoreMismatch === false`.
    - Weekly report email (`buildWeeklyEmail`): includes `Score-sheet mirror: <up_to_date> of <total> up to date | Last built: <date>` and emits a warning when `> 3` days old or never built.

### Test Case 55: Admin Backup Page — Score Sheet Mirror Card (`/pages/backup.html`)
- **Action**:
  1. Log in as Admin and open **Setup ▾ → Backup** (`/pages/backup.html`).
  2. Locate the **Score sheet mirror** card (`#mirror-card`).
  3. Inspect the read-only warning banner, the 4 mirror status cards (**Mirror Configured**, **Students Up to Date**, **Last Built (IST)**, **Last Mirror Error**), and click **"If the website is down (4-step emergency workflow)"** to expand the instructions.
  4. Click **↻ Rebuild all tabs** (`#btn-rebuild-mirror-all`) to verify the confirmation modal (`#modal-rebuild-mirror`) opens, and click **📊 Update score sheets now** (`#btn-update-mirror-now`) when configured.
- **Expected Result**:
  - The card displays the read-only warning: *"This sheet is read-only. Anything typed on the sheet will be overwritten the next time the backup runs. To work in the sheet during an outage, make a copy first (File → Make a copy)."*
  - Expanding **"If the website is down"** shows the 4-step outage plan matching `/docs/OUTAGE-PLAN.md`.
  - Clicking **Rebuild all tabs** opens the confirmation modal; confirming resets `mirror_state.fingerprint` to `null` via `POST /api/backup` `{ action: 'rebuild_mirror' }` and runs backup passes until `remaining = 0`.

---

## Phase 10e & Phase 10f Test Cases (Division Worksheet Layout & Staged Square/Cube Drills)

### Test Case 56: Automated Unit Tests for Question Layout & Staged Square/Cube Drills (`tests/questionLayout.test.js`, `tests/drills.test.js`, `tests/drillStats.test.js`, `tests/todoForm.test.js`)
- **Action**:
  1. Run `node --test tests/*.test.js` in the terminal.
- **Expected Result**:
  - `tests/questionLayout.test.js`: verifies `questionLayout(text)` returns `'nowrap'` for 7-character (`"72 / 7"`) and 18-character (`"12:30:00 - 23:45:0"`) texts and `'wrap'` for 19-character (`"Jan. 10, 1700 - Mar"`) texts, and `formatQuestionText(text)` binds operators (`-`, `/`, `-->`) with `\u00A0` on long prompts.
  - `tests/drills.test.js`: verifies:
    - Exact 1:1 parity between `js/drillCatalog.js` and `api/_drills.js` across all 24 drills (keys, titles, question counts, and time limits), and confirms `squares_11_50`, `squares_51_100`, `cubes_11_50`, and `cubes_51_100` are removed from both.
    - Each of the 8 stage drills (`squares_stage_1..4`, `cubes_stage_1..4`) generates its 25 numbers (`1..25`, `26..50`, `51..75`, `76..100`) **exactly once** (sorted array equals `[min..max]`), and both combined drills (`squares_combined`, `cubes_combined`) generate `1..100` **exactly once**.
    - Answers match exact integer arithmetic (`25 -> 625`, `100 -> 10000`, `99 cubed -> 970299`, `76 cubed -> 438976`).
    - Different RNG seeds produce different shuffled question orders.
  - `tests/drillStats.test.js`: verifies old results keep their stored `activity_name`, format as `"<name> (old drill)"` on history lists, and are excluded from `bestForDrill`.
  - `tests/todoForm.test.js`: verifies `optionsForSection('elements')` includes all 10 new staged drills and excludes the 4 old drills, and `formatTaskTarget` / `isTaskActivityAvailable` return `"Activity no longer available"` for tasks pointing to removed keys.

### Test Case 57: End-to-End Elements Staged Square & Cube Drills, History & To-Do Verification (`/pages/elements.html`, `/pages/element-drill.html`, `/pages/todos.html`)
- **Action**:
  1. Log in as a Student (`STU101` / `student123`) and open **Elements** (`/pages/elements.html`).
  2. Locate the **Squares and cubes** section and verify the **Squares** and **Cubes** sub-headings.
  3. Confirm the 10 new drills appear with their exact titles, question counts, and time limits (`Square - Stage 1 (1-25)` through `Square - Combined (1-100)` and `Cube - Stage 1 (1-25)` through `Cube - Combined (1-100)`), and confirm the 4 old drills (`Square (11-50)`, `Square (51-100)`, `Cube (11-50)`, `Cube (51-100)`) are no longer in the catalog.
  4. Start **Square - Stage 1 (1-25)** (`/pages/element-drill.html?drill=squares_stage_1`), verify all 25 numbers from `1` to `25` appear once in random order, type answers (e.g. `25 -> 625`), and submit.
  5. Scroll to **Recent Elements History** on `/pages/elements.html`: verify any historical set from a removed drill displays as `"<name> (old drill)"` (e.g. `"Square (11-50) (old drill)"`) while not affecting personal bests of current drills.
  6. Log in as Admin (`ADMIN01` / `admin123`), open **Setup ▾ → Daily To-Do** (`/pages/todos.html`), click **+ Add Task**, and select **Elements**: verify the activity dropdown lists the 10 new staged drills and none of the 4 old drills, and any old task pointing to a removed key shows `"Activity no longer available"`.

---

## Phase 10g Test Cases (Timed & Unlimited Online Basics Practice)

### Test Case 58: Automated Unit Tests for Timed Basics Pools, Player Countdown & Mode Personal Bests (`tests/drills.test.js`, `tests/drillPlayer.test.js`, `tests/practiceStats.test.js`)
- **Action**:
  1. Run `node --test tests/drills.test.js tests/drillPlayer.test.js tests/practiceStats.test.js` in the terminal.
- **Expected Result**:
  - `tests/drills.test.js`: verifies:
    - Pool sizes and expiry limits (`30s -> 50`, `60s -> 100`, `120s -> 200`, `300s -> 500`, `unlimited -> 1000`).
    - `generateBasicsSet` never produces two identical questions in a row across all basics categories.
    - `checkTimedBasicsSubmission` grades correct, wrong, and skipped (`null`) answers in reached prefixes, caps `used_seconds = min(elapsed, seconds)` for timed rounds and uses `elapsed` for unlimited rounds, caps `detail` at the first 100 attempted questions, and rejects `attempted === 0`, too-fast (`elapsed < attempted * 0.25s`), and expired (`now > expires_at`) submissions.
  - `tests/drillPlayer.test.js`: verifies pool mode (`mode: 'timed'`) records `null` on skip without revisiting at the end, `finish()` returns only reached answers (excluding the on-screen question when time expires), and `computeRemainingSeconds` computes exact remaining seconds and progress fraction with a fixed clock.
  - `tests/practiceStats.test.js`: verifies `computePerMinuteRates`, separate personal bests for `'timed'` vs `'unlimited'` (`bestForMode`, `bestByCategoryAndMode`), and tie-breaking (`correct_per_minute`, then `accuracy`, then `attempted`).

### Test Case 59: End-to-End Timed & Unlimited Online Basics Practice, Targets & Chips (`/pages/basics-practice.html`, `/pages/targets.html`, `/pages/basics.html`, `/pages/review.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open **Setup ▾ → Targets** (`/pages/targets.html`).
  2. Click **+ Add Target Rule** (or **Edit** on an existing rule for `1d4r`):
     - Enter **Minimum Accuracy (%)**: `90`, **Minimum questions per minute**: `40`, **Maximum Time (mm:ss)**: `2:00`, and click **Save Rule**.
     - Verify the rule row displays: `"Accuracy at least 90%, at least 40 questions per minute in timed rounds, time at most 2:00 in fixed sets"`.
  3. Log in as Student (`STU101` / `student123`) and open **Basics → Practice online** (`/pages/basics-practice.html`).
  4. On the **Setup** card:
     - Verify the 5 time mode buttons appear (`30 seconds`, `1 minute` [default], `2 minutes`, `5 minutes`, `Unlimited (stopwatch)`) and are remembered per category in `localStorage`.
     - Verify the student's target benchmark and personal best for the selected category and mode (`Timed` vs `Unlimited`) are displayed.
  5. Select **30 seconds** and click **Start Practice**:
     - Verify the countdown clock (`00:30` down to `00:00`) and shrinking progress bar appear at the top along with `"Answered n"`.
     - Answer several questions (`Enter`), skip one (`Space` or `Skip`), and either let the timer reach `00:00` (auto-submits reached questions, excluding the on-screen question) or click **Finish** early and confirm.
  6. On the **Results** card:
     - Verify `Correct / Attempted`, `Accuracy`, `Time used`, `Correct per minute` (1 decimal place), `Attempted per minute` (1 decimal place), the score colour tag (`"n wrong"`), the authoritative target badge (`🎯 Target met` or `⚠️ Below target` from `results_with_target`), `"New personal best"` when beaten, `"This round was saved to your scores."`, the wrong-first review table with **Show all**, and the **Same mode again** / **Change mode** buttons.
  7. Open `/pages/basics.html`, `/pages/student.html`, `/pages/student-detail.html`, and `/pages/review.html`:
     - Verify rows saved from timed/unlimited practice show the **`Timed`** or **`Unlimited`** chip next to **`Recorded by the site`** and display their speed as `attempted / min`.

---

## Phase 11a Test Cases (UX Pass, Reporting Periods, Round Entry States, Flash Setup & Demo Removal)

### Test Case 60: Automated Unit Tests for IST Reporting Periods (`tests/periods.test.js`) & Production Bundle Verification
- **Action**:
  1. Run `node --test tests/periods.test.js` (and `node --test tests/*.test.js`).
  2. Run `npm run build` (`vite build`) and verify that `dist/` contains no `demoDb` fake data (e.g. `Aarav Sharma`).
- **Expected Result**:
  - `tests/periods.test.js` passes (`0 fail`), verifying `getMondayOfWeekIST`, `getSundayOfWeekIST`, `formatWeekPeriod` (same-month `"Mon 19 Oct to Sun 25 Oct"`, cross-month `"Mon 26 Oct to Sun 1 Nov"`, and cross-year boundaries), and `formatLast7DaysPeriod` (`"Last 7 days: 22 to 28 Oct"`).
  - The production build in `dist/` aliases `js/demoDb.js` to `js/demoDbStub.js` and excludes all demo records.

### Test Case 61: Today-First Student Home, Reporting Periods & Plain Language (`/index.html`, `/pages/student.html`, `/pages/student-detail.html`)
- **Action**:
  1. Open `/index.html`: verify the login card has no quick test credential buttons and no setup guide modal.
  2. Log in as a student and open `/pages/student.html`:
     - Verify the top-to-bottom order is: **(1) Today** header with the date in India time, **(2) Today's plan** card, **(3) Compact one-row Streak card** (`Current streak`, `Best`, `Shield status`, `Practice recorded today: yes/no`, and the one-line note *"A streak counts any practice today; assigned tasks may still be pending."*), **(4) Three 7-day metric cards** (`Accuracy`, `Speed` in questions per minute, and `Practice days` showing `"n of the last 7 days"` and exact `"Last 7 days: <d Mon> to <d Mon>"`), **(5) Explore practice modes** compact card (`Basics`, `Flash Anzan`, `Elements`, `Memoriad`), and **(6) Practice cards, score sheet, and charts** below.
     - In **Today's plan**, verify the primary button reads **"Practice online"** and a secondary **"Log result"** button appears only for `basics` and `round` tasks (never two `"Start"` buttons).
     - Inspect the **Flash Anzan**, **Memoriad**, **Elements**, and **Basics** cards on `/pages/student.html` and `/pages/student-detail.html`: verify each card shows the exact Monday-to-Sunday period (`"Mon ... to Sun ..."`), visually separates **This week** from **All time**, and distinguishes `"No tries this week"` from `"0 correct"`.

### Test Case 62: Round Entry States, Inline Validation & Flash Anzan Last-Used Summary (`/pages/round-scores.html`, `/pages/flash.html`)
- **Action**:
  1. Open `/pages/round-scores.html`:
     - Verify the sentence under the round header explains which fields can still be edited and why others are locked.
     - Verify each category row displays one of the 6 exact status chips: `"Not entered"`, `"Edited - not saved"`, `"Saved"`, `"Locked (verified)"`, `"Locked (corrected by your teacher)"`, or `"Locked (older than 7 days)"`, and locked rows look read-only with a reason tooltip.
     - Type a value where `Correct > Total` (e.g. `12` correct out of `10` attempted) or a negative number: verify an inline validation message appears directly next to the field (`"Correct cannot be more than attempted."`) and the save bar shows `"n unsaved changes"`.
     - Attempt to click a navigation link while changes are unsaved: verify the confirmation prompt asks before leaving.
  2. Open `/pages/flash.html`:
     - Verify the top of the setup card shows `"Last used: 1 digit - 10 numbers - 1.0 s - add"` with a primary **Start** button while custom controls remain visible below (no presets).
     - Verify the speed unit (`"1.0 s"`) is shown once and the sound option reads `"Play a short tone for each number"` (with no mention of `"Web Audio API"`).

---

## Phase 12a Test Cases (Daily Tasks Required Count, Progress Display, To-Do Streak Rule & Nightly Finalize)

### Test Case 63: Automated Unit Tests for `required_count`, `todoProgress` & `todo_finalize` (`tests/todoForm.test.js`, `tests/todoProgress.test.js`, `tests/backup.test.js`)
- **Action**:
  1. Run `node --test tests/todoForm.test.js tests/todoProgress.test.js tests/backup.test.js` (and full suite `node --test tests/*.test.js`).
- **Expected Result**:
  - `tests/todoForm.test.js`: verifies `normalizeTaskInput` rejects `required_count` values `0`, `51`, `2.5`, and `"abc"`, normalizes empty (`""`, `null`, `undefined`) to `1`, accepts `4` and `50`, and `requiredCountLabelForSection` returns `"Rounds per day"` (`basics`, `round`, `memoriad`), `"Sets per day"` (`elements`), and `"Tries per day"` (`flash`).
  - `tests/todoProgress.test.js`: verifies `progressText` caps displayed done count at `required_count` (`"4 of 4"` when `done_count = 5, required_count = 4`), `percent` caps at `100`, and `summary(tasks)` returns `"n of m tasks done today"` strictly from `task.done === true`.
  - `tests/backup.test.js`: verifies `executeBackupRunPass` calls `supabase.rpc('todo_finalize')` once at the start of both `cron` and `manual` runs, records `todo_days_finalized: n`, and continues without failing the backup run if `todo_finalize` returns an error.

### Test Case 64: Admin Daily To-Do Required Count & Competition Settings Streak Start Date (`/pages/todos.html`, `/pages/competition.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open **Setup ▾ → Daily To-Do** (`/pages/todos.html`).
  2. Click **+ Add Task**:
     - Verify the hint under the modal title reads: *"Changes apply from today. Avoid editing tasks between midnight and 3 AM."*
     - Change **Section Track** across `Round`, `Basics`, `Elements`, `Flash Anzan`, and `Memoriad`: verify the count field label updates dynamically to **"Rounds per day"**, **"Rounds per day"**, **"Sets per day"**, **"Tries per day"**, and **"Rounds per day"**, with the helper text explaining how each saved result or round counts.
     - Set the count to `4`, enter a title (e.g. `"1d4r Speed Drill"`), and click **Save Task**.
     - Verify the task row in the table displays **`x 4 per day`** next to the title, and clicking **Edit** loads `4` into the number field.
  3. Open **Setup ▾ → Competition** (`/pages/competition.html`):
     - Locate card **5. To-do streak rule starts on** (`todo_streak_start`), select a date (`YYYY-MM-DD`), and click **Save Start Date** (or **Save All Settings**).
     - Verify `✓ Saved` appears with no error.

### Test Case 65: Student & Admin Student Detail To-Do Progress, Streak Card & Backup Summary (`/pages/student.html`, `/pages/student-detail.html`, `/pages/backup.html`)
- **Action**:
  1. Log in as a student and open `/pages/student.html` (and as Admin, open `/pages/student-detail.html?id=...` for the same student):
     - In **Today's plan** / **Today's Daily Tasks**, verify the header shows **`"n of m tasks done today"`**.
     - Verify each task row stays in the list even when completed, showing its title, progress **`"2 of 4"`** (or **`"4 of 4"`** even if 5 were done), a small progress bar, **`✓ Done`** when `done` is `true`, and the practice/log link.
     - In the **Practice Streak** card, verify the status shows **`"Today counts: Yes"`** or **`"Today counts: Not yet"`** (directly from `active_today`) and the plain sentence under the numbers reads *"A day counts for your streak only when all of today's tasks are done (n of m done)."* when tasks exist today, or *"No tasks today, so any practice counts."* when no tasks are assigned today.
  2. Open **Setup ▾ → Backup** (`/pages/backup.html`) and run a backup or inspect **Recent Backup & Export Runs**:
     - Verify the run summary displays **`todo_days_finalized: n`**.

---

## Phase 12b Test Cases (Daily To-Do Leaderboard & Own-Level / Global Scope Switch)

### Test Case 66: Automated Unit Tests for Pure Leaderboard View Helpers (`tests/leaderboardView.test.js`)
- **Action**:
  1. Run `node --test tests/leaderboardView.test.js` (and full suite `node --test tests/*.test.js`).
- **Expected Result**:
  - `tests/leaderboardView.test.js` passes (`0 fail`), verifying:
    - `scopeLabel(level, scope)` returns `"<level> (your level only)"` when a level is present, `"Your group (your level only)"` when the student has no level, and `"Global (all trainees)"` when `scope === 'global'`.
    - `boardTitle(board, period, scope, level)` formats card headers such as `"Streak - Global (all trainees)"` and `"Daily To-Do - This week - Junior 2 (your level only)"`.
    - `mapLeaderboardRows` maps RPC rows cleanly, shows level chips in global mode, marks `is_outside_top_10` for a student's own row beyond #10, and strips `student_id` and `"You"` highlights appropriately for student vs. admin views.

### Test Case 67: Student Leaderboard Daily To-Do Tab, Scope Switch & Dashboard Link (`/pages/student.html`, `/pages/leaderboard.html`)
- **Action**:
  1. Log in as a student (`STU101`) and open `/pages/student.html`:
     - Locate the **Leaderboard** card: verify it still shows the student's own level top 3 and includes a **"See global"** link.
  2. Click **"See global"** (or open `/pages/leaderboard.html` and use the top scope segmented control):
     - Verify the two-option scope switch at the top shows **`"<student's level> (your level only)"`** (or **`"Your group (your level only)"`** if unassigned) and **`"Global (all trainees)"`**.
     - Switch between own level and **Global (all trainees)**: verify the card header updates to include the board, period (when applicable), and scope (e.g. **`"Streak - Global (all trainees)"`**), each row in global mode displays a level chip beside the name, and the choice persists across page reloads.
     - Click the **`☑️ Daily To-Do`** tab (after `Practice days`): verify the **How it works** text reads *"Days on which you finished every task on your daily list. Different levels have different tasks, so we count days, not tasks."*, the period switch (`This week`, `This month`, `All time`) is visible, and if empty it shows *"Nobody has finished a full day yet in this period"*.
     - Verify the footer line under the list reads: *"Everyone is shown by first name and last initial. Only totals are shown, never scores."*

### Test Case 68: Admin Daily To-Do Tab & Competition Settings Global Leaderboard Switch (`/pages/leaderboard.html`, `/pages/competition.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open `/pages/leaderboard.html`:
     - Verify the **`☑️ Daily To-Do`** tab appears after `Practice days` and works with the Admin **Level** filter dropdown (`All levels`, `Level 1`, etc.) without showing the student scope switch.
  2. Open **Setup ▾ → Competition** (`/pages/competition.html`):
     - Locate card **6. Global leaderboard (all trainees)** (`global_leaderboard`), verify the helper text reads *"Students can see first name, last initial and level of every active trainee who is shown on leaderboards. No scores are shown. You can hide an individual student on the Students page."*, switch it to **Off**, and click **Save Global Switch**.
  3. Log in as a student and open `/pages/leaderboard.html`:
     - Verify the **Global (all trainees)** option is hidden and the page shows the student's own level scope.

### Test Case 69: Pure Weekly Test View & Backup Table Unit Tests (`tests/weeklyTestView.test.js`, `tests/backup.test.js`)
- **Command**: `node --test tests/weeklyTestView.test.js tests/backup.test.js`
- **Expected**:
  - `sectionStatusLabel(section, testState)` returns `'Done'` when `attempt === 'submitted'`, `'Not finished'` when `attempt === 'started'`, `'Missed'` when `testState === 'closed'` and not started, `'Ready'` when `testState === 'open'` and not started, and `'Upcoming'` when `testState === 'upcoming'`.
  - `isSectionStartable(section, testState)` returns `true` only when `testState === 'open'` and `!section.attempt`.
  - `nextSection(sections)` returns the first section in position order with `!section.attempt`, or `null` when all sections have been started or submitted.
  - `windowText(opens_at, closes_at)` returns `"Open all day (India time)"` when both are empty, or formatted India-time window strings when set.
  - `groupTests(tests)` partitions tests into `availableNow` (`type === 'online' && state === 'open'`), `upcoming` (`state === 'upcoming'` or offline `'today'` without scores), and `past` (`state === 'closed'`, `'past'`, or offline `'today'` with scores).
  - `SNAPSHOT_TABLES` in `api/_backupTables.js` includes `weekly_test_sections`, `weekly_test_attempts`, `weekly_test_removals`, and `announcements` (16 snapshot tables + 6 append tables = 22 total tables).

### Test Case 70: Admin Create/Edit Online & Offline Weekly Tests, Online Results & Section Reset (`/pages/weekly-tests.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open **Tests** (`/pages/weekly-tests.html`).
  2. Click **+ New Weekly Test**:
     - Verify the type radio defaults to **"Offline - the trainer enters the scores"** and switching to **"Online - students take it on the website"** reveals the **Sections (1 to 6)** builder and optional **Opens at** / **Closes at** fields.
     - Verify the **Category** dropdown in each section lists active Basics categories supported online, while unsupported Basics categories are disabled with **"(Not available online)"**, and **Time limit** offers `30 seconds`, `1 minute`, `2 minutes`, and `5 minutes`.
     - Add 2 sections, fill in Date, Title, optional Level, and Remind days (`7`), and click **Save Test**.
  3. Select the online test in the left list (verify the **`Online`** badge and **`n sections`** count):
     - Verify the offline score grid is hidden, the info banner reads *"Scores come from students taking the test online. To enter paper scores, create an Offline test."*, and the **Online Test Results** table displays each student's per-section status (`Not started`, `Started, not finished`, or `Done` with `<correct> of <total>`, accuracy %, and time).
  4. For a student with a `Started, not finished` or `Done` section, click **Reset** next to that section:
     - Verify the confirmation prompt reads *"Delete this student's attempt and score for <section>? They will be able to take this section again while the test is open."* and confirming resets that section to `Not started`.

### Test Case 71: Admin Remove Weekly Test & 30-Day Recently Removed Restore Drawer (`/pages/weekly-tests.html`)
- **Action**:
  1. On `/pages/weekly-tests.html`, select a weekly test and click **Remove this test** in the test header.
  2. Verify the confirmation dialog shows the test title, date, and number of recorded scores, states *"Removing this test deletes its scores and recalculates points and leaderboards. A backup copy is kept for 30 days."*, and requires a reason (`1..200` characters) before **Remove test** is enabled.
  3. Enter a reason and confirm: verify the test disappears from the active list.
  4. Click **Recently removed** at the bottom of the left panel: verify the removed test appears with its title, date, removal date, score count, reason, and a **Restore** button. Click **Restore** and verify the test and its scores return to the active list.

### Test Case 72: Student Home Available Test Banner & Student Online Weekly Test Player (`/pages/student.html`, `/pages/weekly-test.html`)
- **Action**:
  1. Log in as a student (`STU101` / `pass123`) and open `/pages/student.html`:
     - Verify that when an online test is open (`state = 'open'`) with at least one unattempted section, a highlighted **Weekly Test Available Now** card appears above **Today's To-Do** showing `"Weekly test available now: <title>"`, `"<done> of <total> sections done"`, and an **"Open test"** button.
  2. Click **"Open test"** (or **Weekly Test** in the top navigation bar to open `/pages/weekly-test.html`):
     - Verify tests are grouped into **Available now**, **Upcoming**, and **Past**, with offline tests showing *"Offline test (on paper)"* (and read-only teacher scores once entered).
  3. On an **Available now** online test, click **Start section** on a `Ready` section:
     - Verify the confirmation modal states *"You can take this section only once. If you leave the page, the section is lost."* with **Cancel** and **Start now**.
     - Click **Start now**: verify the one-question-at-a-time timed player starts with the section's countdown timer, question counter (`Question 1 of N`), and answer input (`Enter` submits each answer).
     - Complete or wait out the timer: verify the results view shows `correct out of attempted`, `accuracy %`, `time taken`, `"Saved as part of <test title>"`, and a **Next section** button (or **Test complete** when all sections are finished), and the completed section is now locked as **`Done`**.

---

## Phase 13b Test Cases (Student Notifications, Admin Announcements, WhatsApp Test Share & Weekly Email Upcoming Tests)

### Test Case 73: Pure Notification, Share Message & Weekly Report Email Unit Tests (`tests/notificationsView.test.js`, `tests/reportMessage.test.js`, `tests/reportEmail.test.js`)
- **Command**: `node --test tests/notificationsView.test.js tests/reportMessage.test.js tests/reportEmail.test.js`
- **Expected**:
  - `stageLabel(days_left)` returns `'Today'` for `0`, `'Tomorrow'` for `1`, `'In N days'` for `>= 2`, and `''` for `null`/`undefined`/`< 0`.
  - `groupNotifications(items)` partitions notifications into `{ weeklyTests, announcements }` and sorts weekly tests by `days_left` ascending.
  - `badgeText(count)` returns `''` for `0` or negative, `'1'`..`'9'` for `1..9`, and `'9+'` for `> 9`.
  - `buildWeeklyTestShareMessage(test)` formats `"Weekly test: <title> on <weekday, day month>. <Online on the Trendz Tracker website / With your trainer>. <notes shortened to 120 characters>"`.
  - `buildWeeklyEmail(data)` includes the `"Upcoming weekly tests (next 7 days)"` section with HTML-escaped titles, types, dates, and levels, or `"No weekly tests scheduled"` when the list is empty.

### Test Case 74: Student Notification Bell Badge, Home Reminder Strip & Notifications Page (`/pages/student.html`, `/pages/notifications.html`)
- **Action**:
  1. Log in as a student (`STU101` / `pass123`) and open `/pages/student.html`.
  2. Inspect the top navigation bar:
     - Verify the **Notifications** bell link is visible and displays a numeric badge (`1`–`9` or `9+`) when `my_notifications()` returns items, or hides the badge when `0`.
     - Verify the count is cached in `sessionStorage` for 60 seconds (`tt_student_notifications_cache_v1`) so navigating across student pages does not re-fetch on every click.
  3. Inspect the **Reminders** strip above **Today's To-Do** on `/pages/student.html`:
     - Verify up to 3 active reminders are shown with stage chip (`Today`, `Tomorrow`, `In N days` or `Announcement`), title, **Open** link, and a **See all notifications →** link.
  4. Click **Notifications** in the top navigation bar (`/pages/notifications.html`):
     - Verify items are grouped under **Weekly tests** and **Announcements**.
     - Verify each card shows the title, body, date chip (e.g. `Sun 2 Nov`), stage text chip (`In 4 days`, `Tomorrow`, `Today`), an **Open** button, and a **Dismiss** button.
     - Click **Dismiss** on an item: verify the item is removed immediately, the bell badge count updates and refreshes the `sessionStorage` cache, and a 5-second toast appears with an **Undo** button.
     - Click **Undo** within 5 seconds: verify the item is restored to the list; if not undone within 5 seconds, `dismiss_notification(p_ref)` persists the dismissal.
     - When all notifications are dismissed, verify the friendly empty state **"You are all caught up"** is shown.

### Test Case 75: Admin Announcements Page, Live Student Preview & Upcoming Tests WhatsApp Share (`/pages/announcements.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open **Setup ▾ → Announcements** (`/pages/announcements.html`).
  2. In the **Post an announcement** form:
     - Type a title (`1..80` chars) and message (`1..500` chars) and watch the live character counter (`0 / 500`) and the **"What students see"** preview card update in real time.
     - Switch **Audience** between **Everyone** and **Specific level** (with level suggestions from existing students).
     - Verify **Show from** defaults to current India time and **Hide after** is optional (and rejects a hide-after timestamp that is not after show-from).
     - Click **Publish announcement**: verify the button disables during save to prevent double clicks and adds the announcement to the list with a status chip (`Active`, `Scheduled`, or `Expired`).
  3. On any announcement in the list, click **Delete**, confirm in the modal, and verify the announcement is removed.
  4. Inspect the **Upcoming tests (next 14 days)** panel on `/pages/announcements.html`:
     - Verify weekly tests scheduled in the next 14 days appear with title, type chip (`Online` / `Offline`), date, level, reminder days, and section count.
     - Click **Copy text**: verify the formatted share message (`Weekly test: <title> on <weekday, day month>...`) is copied to the clipboard.
     - Click **Share on WhatsApp**: verify it opens `https://wa.me/?text=<encoded>` in a new tab with no phone numbers stored or requested.

### Test Case 76: Admin Weekly Test Reminder Date Preview (`/pages/weekly-tests.html`)
- **Action**:
  1. Logged in as Admin, open **Tests** (`/pages/weekly-tests.html`) and click **+ New Weekly Test**.
  2. Change the **Date** or **Remind students from N days before** (`0` to `30`, default `7`).
  3. Verify the live preview line next to the input updates immediately to read: `"Students will see a reminder from <date> until the test day."` (or `"Students will see a reminder on the test day only."` when `0`).

---

## Phase 14a Test Cases (Flash Anzan Daily Task Settings & Live Task Match)

### Test Case 77: Automated Unit Tests for Flash Task Normalization, Summary, Links & Matching (`tests/todoForm.test.js`, `tests/flashTaskMatch.test.js`)
- **Command**: `node --test tests/todoForm.test.js tests/flashTaskMatch.test.js`
- **Expected**:
  - `normalizeTaskInput` accepts `flash_digits` (`1..5`), `flash_count` (`2..1000`), `flash_speed_ms` (input `0.2..5.0` s in `0.1` s steps converted to `200..5000` ms without floating-point rounding errors, e.g. `0.5 -> 500`, `1.1 -> 1100`), and `flash_mode` (`'add'` | `'add_sub'`) for section `'flash'`, converts empty/`"any"` to `null`, rejects out-of-range values (including `1` number), and clears all four fields to `null` for non-flash sections.
  - `flashSummary(task)` returns `"Any flash anzan try"` when empty and comma-separated summaries such as `"1 digit, 50 numbers, 0.5 s, add only"` when fields are set.
  - `taskLink(task)` builds `/pages/flash.html?task=1` plus only the parameters that are set (`digits`, `count`, `speed` in ms, `mode`).
  - `matchesTask(settings, task)` returns `true` when every non-empty task setting matches `settings` and `false` when any fixed field differs.

### Test Case 78: Admin Add & Edit Flash Anzan Daily Task (`/pages/todos.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`) and open **Setup ▾ → Daily To-Do** (`/pages/todos.html`).
  2. Click **+ Add Task** and set **Section Track** to **Flash Anzan**:
     - Verify the standard category/activity dropdown is replaced by the **"Flash Anzan settings (optional)"** group with four fields: **Digits** (`Any`, `1` to `5`), **Numbers in the question** (`2` to `1000` or empty for Any), **Speed per number in seconds** (`0.2` to `5.0` in steps of `0.1` or empty for Any), and **Mode** (`Any`, `Add only`, `Add and subtract`).
     - Verify the helper text reads: *"Leave a field on Any to accept every value. A try counts when it matches every field you set."*
     - Verify the count field is labelled **"Tries per day"**.
  3. Set Digits = `1`, Numbers = `50`, Speed = `0.5`, Mode = `Add only`, and click **"Use these settings as the title"**:
     - Verify the **Task Title** fills with `"Flash: 1 digit, 50 numbers, 0.5 s, add only"`.
     - Change Digits to `2` and click **"Use these settings as the title"** again: verify the title updates because it was filled by the button. Type a custom title manually and click the button again: verify manual text is not overwritten.
  4. Click **Save Task**:
     - Verify the **Assigned Target** column in the Flash Anzan section of the table shows `"1 digit, 50 numbers, 0.5 s, add only"` (or *"Any flash anzan try"* when all four fields are left on Any).
     - Click **Edit** on the saved task: verify Digits (`1`), Numbers (`50`), Speed (`0.5`), and Mode (`Add only`) load back into the form accurately.

### Test Case 79: Student To-Do Card Flash Summary & Flash Anzan Live Task Banner (`/pages/student.html`, `/pages/flash.html`)
- **Action**:
  1. Log in as a student (`STU101` / `pass123`) and open **Home** (`/pages/student.html`).
  2. In **Today's Plan (To-Do List)**, locate the **Flash Anzan** task:
     - Verify the summary (e.g. `"1 digit, 50 numbers, 0.5 s, add only"`) is displayed directly under the task title.
  3. Click **Practice online** on that Flash Anzan task:
     - Verify it opens `/pages/flash.html?task=1&digits=1&count=50&speed=500&mode=add` and prefills the Setup controls with those exact values.
     - Verify the task banner appears above the setup card: *"Today's task needs: 1 digit, 50 numbers, 0.5 s, add only. A try counts for the task only with these settings."* alongside **"✓ This try counts for today's task"**.
  4. Change any fixed control on the setup screen (for example, click `2` under Digits or change Mode to `Add and subtract`):
     - Verify the banner immediately switches to **"⚠ These settings will not count for today's task"** and shows the **"Restore task settings"** button.
  5. Click **"Restore task settings"**:
     - Verify the controls return to the task's required settings and the status returns to **"✓ This try counts for today's task"**.

---

## Phase 14b Test Cases & Visual Checklist (Calmer UI, Pass 1)

### Test Case 80: Automated Unit Tests for Form Pattern, Settings Hub & Table Density (`tests/formPattern.test.js`, `tests/settingsHub.test.js`, `tests/tableDensity.test.js`)
- **Command**: `npm test`
- **Expected**:
  - `shouldOpenMoreOptions(optionalValues, isEdit)` returns `false` on create flows, `false` when editing with all optional fields empty/`"any"`, and `true` when editing and at least one optional field has a value.
  - `buildModalLiveSummary(kind, values)` returns accurate single-line summaries for all modal kinds (`todo`, `weeklyTest`, `profile`, `studentCreate`, `target`, `resource`, `announcement`, `attendance`, `round`).
  - `filterSettingsEntries(groupId, query)` filters Settings hub entries by category group and search query; `getSettingsBreadcrumb(pathname)` resolves sub-page breadcrumbs.
  - `getTableDensity` and `setTableDensity` read/write `trendz_table_density` safely inside `try/catch`.

### Test Case 81: Admin Settings Hub & Navigation (`/pages/settings.html`)
- **Action**:
  1. Log in as Admin (`ADMIN01` / `admin123`).
  2. Verify the top navigation bar across all admin pages shows: **Overview, Students, Review, Attendance, Weekly Tests, Leaderboard, Settings**, plus the right-hand account menu (**name, Account, Sign out**).
  3. Click **Settings** (`/pages/settings.html`):
     - Verify the left group list shows **All settings, Practice, Competition, Communication, Data**.
     - Type `"flash"` or `"zip"` in the search box: verify entries filter immediately with one-line descriptions.
     - Click **Daily To-Do** (`/pages/todos.html`): verify the page loads at its existing address and displays the breadcrumb **Settings > Daily To-Do** at the top.

### Test Case 82: Standardized 520px Modal Pattern Across All 8 Modals
- **Action**:
  1. Open each of the 8 modals:
     - **Add Daily Task** (`/pages/todos.html` $\rightarrow$ `+ Add Task`)
     - **Create Weekly Test** (`/pages/weekly-tests.html` $\rightarrow$ `+ New Weekly Test`)
     - **Edit Profile / Add Student** (`/pages/students.html` $\rightarrow$ `Edit` or `+ Add Student`)
     - **Add Target** (`/pages/targets.html` $\rightarrow$ `+ Add Target Rule`)
     - **Add Resource** (`/pages/resources.html` $\rightarrow$ `+ Add Resource`)
     - **Post Announcement** (`/pages/announcements.html` $\rightarrow$ `+ Post announcement`)
     - **Create Attendance Session** (`/pages/attendance.html` $\rightarrow$ `+ New Session`)
     - **Create / Edit Student Round** (`/pages/rounds.html` $\rightarrow$ `+ Custom Round` or `Edit`)
  2. Verify in every modal:
     - Max width is `520px` with title + one short subtitle sentence.
     - Field labels are sentence-case (`14px`, weight `500`), including **"Type"**, **"Specific activity (optional)"**, and **"Level (optional)"**.
     - Required fields appear first; optional fields are inside **More options** (collapsed on create; automatically open when editing a record with an optional value).
     - A live summary sentence updates above the footer buttons as fields change.
     - Footer has right-aligned **Cancel** (ghost), **Save and add another** (secondary, on create flows), and **Save** (single primary button).

### Test Case 83: Visual & Responsive Checklist at `1280px`, `1024px`, `768px`, and `390px`
- **How to run**: Open browser DevTools (`F12`), toggle the Device Toolbar (`Ctrl+Shift+M` / `Cmd+Shift+M`), and inspect `/pages/admin.html`, `/pages/settings.html`, `/pages/todos.html`, `/pages/students.html`, and `/pages/attendance.html` at each width:
  1. **`1280px` (Desktop Wide)**:
     - Top navigation displays all 7 admin links inline (`Overview` through `Settings`) plus the right-hand account menu without wrapping.
     - `/pages/settings.html` shows the 2-column layout (`240px` left group nav + right settings cards).
     - Modals center at `520px` max-width; `.form-row-2` pairs (`Per day` + `Level (optional)`, `Date` + `Type`) sit side-by-side in 2 columns.
     - Admin tables show sticky headers, `12px` vertical cell padding, no zebra stripes, hover row highlight, and the **Compact** density toggle in the table toolbar (`8px` vertical padding when active).
  2. **`1024px` (Laptop / Landscape Tablet)**:
     - Top bar remains on a single row with comfortable spacing; cards have `1px solid #E3E8EF` border and `none` box-shadow by default.
     - At most one `.btn-primary` button is visible on any screen or inside any open modal.
     - Status chips for completed/active informational states use neutral slate (`#F1F5F9` / `#334155`), while semantic colours appear only on states needing attention.
  3. **`768px` (Portrait Tablet)**:
     - Mobile hamburger menu button toggles the admin navigation drawer cleanly; account menu and **Sign out** remain reachable.
     - On `/pages/settings.html`, the left sidebar switches to the mobile `<select>` category selector above the search input.
     - Modals (`520px` max-width) keep `.form-row-2` side-by-side (since `768px >= 600px`) and scroll internally if content exceeds viewport height.
  4. **`390px` (Mobile Phone Touch Viewport)**:
     - All interactive buttons, inputs, selects, and touch targets meet the `44px` minimum height rule.
     - Inside modals, `.form-row-2` stacks cleanly into a single column (`< 600px`), and modal footer buttons wrap cleanly without horizontal overflow.
     - Wide admin tables scroll horizontally inside `.table-wrapper` while page layout remains locked to `390px` width with zero horizontal page scroll.

---

## Phase 14c Verification — Daily To-Do Task Speed Leaderboard & Leaderboard Date Options

### Test Case 84: Automated Pure Helper Unit Tests (`js/periods.js` & `js/leaderboardView.js`)
1. Run the Node test suite:
   ```bash
   node --test tests/periods.test.js tests/leaderboardView.test.js
   ```
2. **Expected**:
   - `parsePeriod`, `periodValue`, `periodLabel`, and `validatePeriodDate` pass all cases:
     - `'today'`, `'yesterday'`, `'week'`, `'month'`, `'year'`, `'all'`, and `'date:YYYY-MM-DD'`.
     - Future dates (after `todayIST`), dates before `2020-01-01`, non-leap `2026-02-29`, and malformed strings are rejected.
     - Leap day `2028-02-29` is accepted when `todayIST >= '2028-02-29'`.
     - `periodLabel` returns `"Today, Sat 31 Oct"`, `"Yesterday, Fri 30 Oct"`, `"26 Oct to 1 Nov"`, `"Oct 2026"`, `"2026"`, `"All time"`, and `"Thu 29 Oct 2026"` for reference date `2026-10-31`.
   - `isSpeedRankableTask` returns `true` only for `section === 'basics'` with a non-empty `category_id`.
   - `formatBoardValue('todo', value)` formats completed days (`"1 day"`, `"3 days"`) and never formats seconds.
   - `mapTaskLeaderboardRows` formats `Best` (`"42 correct/min"`), `Best round` (`"21 of 22 in 30 s"`), and `Rounds` (`"5"`).

### Test Case 85: Daily To-Do Leaderboard — All Tasks vs. Basics Task with Category vs. Other Task Types
1. Sign in as a student or admin and open `/pages/leaderboard.html`.
2. Click the **Daily To-Do** tab.
3. **Default (`All tasks`)**:
   - Confirm **All tasks** is selected by default in the task filter.
   - Confirm the table shows 3 columns: `Rank`, `Student`, and `Days completed` (showing values like `5 days`, `4 days` — never `3s` or `1s`).
   - Confirm the card title reads `Daily To-Do - <period label> - <scope or level>`.
4. **Basics task with a category**:
   - Select a Basics task that has a specific category (e.g. `Mental Basics: 1-digit 4-rows (1d4r)`).
   - Confirm the page calls `todo_task_leaderboard` and displays 5 columns: `Rank`, `Student` (with level chip in Global scope), `Best` (e.g. `42 correct/min`), `Best round` (e.g. `21 of 22 in 30 s`), and `Rounds`.
   - Confirm the explanation text reads: *"Ranked by correct answers per minute in each student's best round on the website. Typed scores, rounds under 20 seconds and rounds under 10 questions do not count."*
   - Confirm the card title reads `<task title> - <period label> - <scope or level>`.
   - If no qualifying rounds exist in the chosen period, confirm the empty state reads *"No qualifying rounds in this period."*
5. **Every other task type (`flash`, `elements`, `memoriad`, `round`, or `basics` without a category)**:
   - Select a Round, Flash Anzan, Elements, Memoriad, or Any-Basics task.
   - Confirm `todo_task_leaderboard` is **not** called, no time column is shown, and the info banner *"Speed ranking is not available for this kind of task yet."* appears above the **All tasks** days-completed board.
   - Confirm the card title reads `<task title> - <period label> - <scope or level>`.

### Test Case 86: Period Selector, Date Picker, and Shareable URL State
1. On `/pages/leaderboard.html`, verify the period selector appears on **Points**, **Practice days**, **Daily To-Do**, and the task board, and is hidden on **Streak** and **Most improved**.
2. Click each period option (**Today**, **Yesterday**, **This week**, **This month**, **This year**, **All time**) and verify:
   - The badge next to the card title shows the exact India-time range (`Today, Sat 31 Oct`, `Yesterday, Fri 30 Oct`, `26 Oct to 1 Nov`, `Oct 2026`, `2026`, `All time`).
   - The browser address bar updates (`?board=...&period=...`).
3. Click **Pick a date**:
   - Confirm a date input (`min="2020-01-01"`, `max="<today in IST>"`) appears.
   - Pick a valid past date (e.g. `2026-10-29`) and confirm the URL updates to `period=date:2026-10-29` and the range badge next to the title shows `Thu 29 Oct 2026`.
   - Reload the page (or open the URL in a new tab) and confirm the board, period (`date:2026-10-29`), and selected task are restored.
   - Test an invalid URL such as `?board=todo&period=date:2099-01-01` or `?period=bad`: confirm invalid values are ignored and the board falls back cleanly to `This week`.

---

## Phase 14d & 14e Verification — Desktop Inline Header Restoration (`>= 1024 px`) & Mobile-Only Three-Dot Menu (`< 1024 px`)

### Test Case 87: Automated Navigation Config, Breakpoint Parity & Menu State Unit Tests (`node --test`)
1. Run the navigation unit test suites:
   ```bash
   node --test tests/navConfig.test.js tests/navMenuState.test.js
   ```
2. **Expected**:
   - `tests/navConfig.test.js` verifies that `--nav-mobile-breakpoint` in `css/variables.css` and `NAV_MOBILE_BREAKPOINT_PX` in `js/navConfig.js` both equal `1024`.
   - Every HTML entry point in `vite.config.ts` appears in `js/navConfig.js` (`student` or `admin`) or in `NAV_STAGE_AND_PUBLIC_ALLOWLIST` (`/index.html`, `/pages/basics-practice.html`, `/pages/element-drill.html`, `/pages/memoriad-play.html`, `/pages/student-detail.html`).
   - Zero duplicate `href`s or `id`s exist within a role.
   - Desktop entries match the restored pre-14d layout (`Today, Round scores, Practice ▾, Weekly Test, Leaderboard, Monthly Report` + notifications bell for Student; `Overview, Review, Students, Attendance, Weekly Tests, Leaderboard, Monthly Report, Setup ▾` for Admin).

### Test Case 88: Responsive Header & Navigation Checklist at `390`, `768`, `1023`, `1024`, `1280`, and `1440 px` (Both Roles)
Open browser DevTools (`F12`), toggle the Device Toolbar (`Ctrl+Shift+M` / `Cmd+Shift+M`), and check both a **Student** session (`/pages/student.html`) and an **Admin** session (`/pages/admin.html`):

1. **At `1440 px` and `1280 px` width (Desktop Wide)**:
   - **Three-dot menu hidden**: Confirm the three-dot menu button and drawer are `display: none` and `hidden` (they take zero space and cannot receive keyboard focus).
   - **Admin inline header**: Confirm `[Logo] [Trendz Tracker]` followed by `Overview`, `Review`, `Students`, `Attendance`, `Weekly Tests`, `Leaderboard`, `Monthly Report`, and `Setup ▾` (opening the setup pages dropdown on hover/click), and on the right `[Name · Admin] [Sign out]`.
   - **Student inline header**: Confirm `[Logo] [Trendz Tracker]` followed by `Today`, `Round scores`, `Practice ▾` (`Basics`, `Flash Anzan`, `Elements`, `Memoriad`), `Weekly Test`, `Leaderboard`, `Monthly Report`, the notifications bell with its count badge, and on the right `[Name · ID] [Sign out]`.
   - **Active underline**: Confirm the current page (or parent dropdown when on a child page) has the primary active underline.

2. **At `1024 px` (and `1100 px`) width (Desktop Breakpoint & Compact Laptop)**:
   - **Inline links active, three-dot menu hidden**: Confirm `1024 px` displays the desktop inline header (not the three-dot button).
   - **Admin compact fit (`1024–1280 px`)**: Confirm spacing is tightened and the teacher's name shows the **first name only** (hovering over the name reveals the full name in a tooltip) so `"Trendz Tracker"`, all inline links, `Setup ▾`, the first name, and `Sign out` fit on a single line without wrapping or overflowing.

3. **At `1023 px` and `768 px` width (Mobile/Tablet Just Below Breakpoint)**:
   - **Live switch on resize**: Resize from `1024 px` down to `1023 px` without reloading. Confirm any open desktop dropdown closes automatically, the inline links/dropdowns become hidden (`display: none` and `hidden`), and the `44 x 44 px` three-dot menu button (`⋮`) appears beside `"Trendz Tracker"`.
   - **Anchored menu panel (`701–1023 px`)**: Click the three-dot button at `1023 px` and `768 px`. Confirm the `300 px` anchored panel opens below the button with all grouped links for the role, `ArrowDown`/`ArrowUp` wrap-around, and `Escape` closing the panel and returning focus to the button.

4. **At `390 px` width (Mobile Phone)**:
   - **Header layout**: Confirm `[Logo] [Trendz Tracker] [Three-Dot Menu Button]` on the left and `[First Name] [Sign out]` on the right stay on a single line (`white-space: nowrap`), with the user's name shortened to their first name (`< 480 px`).
   - **Left slide-in drawer (`<= 700 px`)**: Tap the three-dot button. Confirm the left slide-in drawer opens over the dimmed backdrop, background scroll is locked, `Tab` traps focus inside the drawer, and tapping the backdrop or pressing `Escape` closes the drawer.

5. **Full-Screen Stage Focus Mode**:
   - Start a Flash Anzan try, Basics round, Elements worksheet, Memoriad stage, or online Weekly Test section and confirm `body.stage-focus-mode` hides the header as before.

---

## Phase 16a — Weekly Test Sections of Every Kind, Trainer Section Scores & Weekly Test Leaderboards

### Automated Unit Tests (`node --test`)
- `tests/weeklySections.test.js`:
  - `sectionSummary(section, categoriesById)` for all 5 section kinds (`basics`, `round`, `flash`, `elements`, `memoriad`).
  - `validateSections(sections, testType, categories)` for empty/too many (>12) sections, online `round` rejection (`"Round scores are available for offline tests only for now"`), wrong category section, unavailable online Basics category, missing online Basics duration, invalid Elements/Memoriad activity keys, out-of-range Flash settings, and duplicate sections.
  - `toRows(sections, categories)` and `speedSecondsToMs` float rounding (`0.2..5.0` s -> `200..5000` ms without floating-point drift).
- `tests/weeklyTestBoard.test.js`:
  - `scoreText(correct, attempted)` (`"38 of 40"`, `"0 of 0"`).
  - `boardTitle(testTitle, period, scope, level)` for both single-test and period-based Weekly Test leaderboards.
  - `mapWeeklyTestLeaderboardRows` privacy, level chip in global scope, and own-rank divider outside top 10.
- `tests/weeklyTestView.test.js`:
  - `isSectionStartable` (true only for open, unattempted `basics` sections) and `isSectionComingSoon` (true for open, unattempted `flash`, `elements`, and `memoriad` sections).

### Manual Browser Verification
1. **Admin Multi-Kind Sections Builder (`/pages/weekly-tests.html`)**:
   - Click **+ New Weekly Test**, add sections of kind **Basics**, **Flash Anzan**, **Elements**, **Memoriad**, and (when Offline) **Round scores**, reorder with `↑`/`↓`, and save.
   - Switch between **Offline** and **Online** in the modal and verify that **Round scores** is disabled for Online tests with `"Round scores are available for offline tests only for now"`.
   - Edit an existing test that has student scores/attempts and verify locked sections cannot be deleted while new sections can be added in place.
2. **Admin Section Score Entry & Per-Test Leaderboard**:
   - Select a test with sections, click each section tab (`1. Basics: ...`, `2. Flash: ...`), enter `Correct`, `Total`, and optional `Time (mm:ss)`, verify live wrong count and shared score colour, and click **Save scores**.
   - Switch to the **Leaderboard** tab on the test detail card and verify live rankings (`Rank`, `Student`, `Points`, `Correct of attempted`, `Time`).
3. **Student Weekly Test Page & Main Leaderboard (`/pages/weekly-test.html`, `/pages/leaderboard.html`)**:
   - Sign in as a student, open **Weekly Test**, and verify that open Online tests show **Start** on Basics sections and a disabled **Available soon** button on Flash, Elements, and Memoriad sections.
   - Switch to the **Leaderboard** tab on `/pages/weekly-test.html`, test the **All tests** period selector (`This week`, `This month`, `This year`, `All time`, `Pick a date`) and individual closed/offline tests, and verify the **Weekly tests** tab on `/pages/leaderboard.html`.

---

## Phase 16b — Online Weekly Test Runners for Elements, Flash Anzan & Memoriad

### Automated Unit Tests (`node --test`)
1. Run the Phase 16b unit tests:
   ```bash
   node --test tests/weeklyTestView.test.js tests/weeklyTestPhase16b.test.js
   ```
2. **Expected**:
   - `applyFlashTry`: increments `tries_started` up to `question_count`, increments `tries_correct` only on correct answers, accumulates `seconds_used`, updates `score_row` (`correct = tries_correct`, `total = question_count`), marks `done = true` and `status = 'submitted'` on the final try, and refuses tries beyond `question_count`.
   - `finalScore`: converts `basics`, `elements`, `memoriad` (`total = questions_total`), and `flash` results into `{ correct, total, time_seconds, shouldSave }`.
   - `runnerLink` & `flashProgressText`: builds `/pages/basics-practice.html?test=...&section=...`, `/pages/element-drill.html?test=...&section=...`, `/pages/flash.html?test=...&section=...`, and `/pages/memoriad-play.html?test=...&section=...`, and formats `"Try 1 of 5"`.
   - Isolation test verifies that running `elements`, `flash`, and `memoriad` weekly test sections writes only to `weekly_test_scores` and `weekly_test_attempts` and leaves `results` and `activity_results` unchanged.

### Manual Browser Verification
1. **Student Weekly Test Page (`/pages/weekly-test.html`)**:
   - Sign in as a student (`AB001` / `pass123`) and open **Weekly Test**.
   - On an open online test, verify that **Basics**, **Flash Anzan**, **Elements**, and **Memoriad** sections all show **Start** (no *"Available soon"* button).
   - Click **Start** on a section and confirm the modal warns: *"You can take this section only once. If you leave the page, the section ends."* with **Cancel** and **Start now**.
2. **Elements Section Runner (`/pages/element-drill.html?test=<id>&section=<id>`)**:
   - Start an Elements section from an open online test.
   - Confirm the site header and drill chooser are hidden, the test title and **Exit** button are shown, and the timer starts immediately.
   - Answer the worksheet questions and click **Submit Answers**.
   - Confirm the result screen shows your score, accuracy, time, wrong answers first, *"✓ Saved as part of <test title>"*, and **Back to Weekly Test** (with no *"Try again"* button).
3. **Flash Anzan Multi-Try Section Runner (`/pages/flash.html?test=<id>&section=<id>`)**:
   - Start a Flash Anzan section (e.g., `3 tries`).
   - Confirm the setup screen and history table are hidden and the top summary shows *"Try 1 of 3"*.
   - After try 1 finishes and you enter an answer, confirm the screen says **"Answer recorded"** (without revealing whether the answer was right or wrong) and shows a **"Next try"** button.
   - Leave the page after try 1 and return to `/pages/weekly-test.html`: confirm the section status shows *"In progress: 1 of 3 tries"* with a **"Continue"** button.
   - Click **Continue**, finish the remaining tries, and confirm the final screen shows *"<tries_correct> of 3 correct"*, total time, shared score colour badge, *"✓ Saved as part of <test title>"*, and **Back to Weekly Test**.
4. **Memoriad Section Runner & Narrow-Screen Pre-Check (`/pages/memoriad-play.html?test=<id>&section=<id>`)**:
   - Resize the browser window below `1000 px` and start a Memoriad section: confirm the page shows *"Memoriad uses a full desktop keyboard..."* and **Back to Weekly Test** **before** starting the attempt (so the section remains `"To do"`).
   - At `>= 1000 px` width, start the Memoriad section: confirm the setup screen is skipped, fixed competition defaults are used, and submitting shows *"Saved as part of <test title>"* and **Back to Weekly Test**.
5. **Admin Online Results & Reset (`/pages/weekly-tests.html`)**:
   - Sign in as Admin (`ADMIN01` / `admin123`), open `/pages/weekly-tests.html`, and select the online test.
   - Confirm completed sections show score, wrong count, and time, while an in-progress Flash section shows *"Started, not finished"* + *"tries n of m"* + **Reset**.
   - Click **Reset** on a student's section and confirm both the attempt and score for that section are cleared so the student can take it again.
