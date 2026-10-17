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
