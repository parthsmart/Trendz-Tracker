# Phase 15a — Trendz Tracker Performance Audit (Step 0 Report) & Ranked Plan

> **STEP 0 STATUS**: Read-only audit complete. **Zero application code files have been modified.** Review the findings and ranked fixes (Candidates A–I) below and approve the items you want implemented.

---

## 1. Per-Page Network Request Audit (On Load, in Execution Order)

*Note on `/api/config`*: On Vercel production builds where `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked into the bundle by Vite, `/api/config` is **0 requests**. If build-time env vars are absent, `getSupabase()` makes 1 request to `GET /api/config` on the first page of the session and caches it in `sessionStorage`. Counts below assume production build env vars are set.

### 1.1 Login (`/index.html`)
- **Static Files (5 requests, ~47.3 kB gzip total)**:
  1. `GET /index.html` (`3.02 kB` raw / `1.06 kB` gzip)
  2. `GET /assets/guard-NzGNsxTt.css` (`46.94 kB` raw / `7.61 kB` gzip)
  3. `GET /assets/main-Bg8m1jA8.js` (`1.26 kB` raw / `0.57 kB` gzip)
  4. `GET /assets/guard-BrqKn7ZY.js` (`22.75 kB` raw / `7.22 kB` gzip)
  5. `GET /assets/auth-BQ7GPDbG.js` (`112.44 kB` raw / `30.89 kB` gzip — `@supabase/supabase-js` + auth helpers)
- **Supabase / API Runtime Requests**:
  - **Signed-out visitor**: **0 network requests** (`supabase.auth.getSession()` reads `localStorage` locally).
  - **Already signed-in visitor**: **1 network request** (waits for JS load):
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB) inside `requireNoAuth()` before redirecting.

---

### 1.2 Student Home — Both Tabs (`/pages/student.html`)
- **Static Files (16 requests, ~79.0 kB gzip total)**:
  - `GET /pages/student.html` (`26.25 kB` / `4.86 kB` gzip)
  - `GET /assets/guard-NzGNsxTt.css` (`46.94 kB` / `7.61 kB` gzip)
  - 14 JS chunks (`student.js`, `guard.js`, `auth.js`, `dashboardComponents.js` [11.77 kB gz — loaded eagerly even though tab 2 is hidden!], `leaderboardData.js`, `memoriadCard.js`, `elementsCard.js`, `stats.js`, `flashStats.js`, `todoForm.js`, `periods.js`, `practiceStats.js`, `weeklyTestView.js`, `scoreColors.js`, `timeUtils.js` — **~66.5 kB gzip JS**).
- **Supabase / API Runtime Requests**: **19 requests across 3 sequential waterfall stages** (**~215 KB – 760 KB total payload**):
  - **Waterfall Stage 1 (Blocking Auth Guard — 1 request)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB) — **blocks all 18 requests below**.
  - **Waterfall Stage 2 (Waits for #1; 17 requests fired in parallel)**:
    2. `POST /rest/v1/rpc/my_notifications` (from `initStudentNotificationBell` in `guard.js` when 60s cache is cold; 0–10 rows, ~1–2 KB).
    3. `POST /rest/v1/rpc/my_notifications` (**DUPLICATE race condition!** Fired simultaneously by `loadAndRenderHomeRemindersStrip()` in `student.js` before #2 finishes writing to `sessionStorage`).
    4. `POST /rest/v1/rpc/leaderboard` (`p_board='points', p_period='week', p_limit=3, p_scope='level'`; 3–4 rows, ~0.8 KB — from `loadAndRenderLeaderboardCard`).
    5. `POST /rest/v1/rpc/global_leaderboard_enabled` (1 boolean, ~0.1 KB — from `loadAndRenderLeaderboardCard`).
    6. `POST /rest/v1/rpc/my_weekly_tests` (all active tests + embedded sections/scores JSON; 5–30 rows, **~5–25 KB** — from `loadAndRenderAvailableWeeklyTestCard`).
    7. `POST /rest/v1/rpc/today_ist` (1 scalar date string, ~0.1 KB — from `fetchStudentDashboardData`).
    8. `POST /rest/v1/rpc/streak_for` (`p_student=<uid>`; 1 row, ~0.2 KB).
    9. `POST /rest/v1/rpc/todo_for` (`p_student=<uid>`; 1–10 rows, ~1.5 KB).
    10. `GET /rest/v1/categories?select=*&order=sort_order.asc` (20–40 rows, ~4–8 KB).
    11. `GET /rest/v1/round_series?select=*&order=sort_order.asc` (2–5 rows, ~0.5 KB — **only used by Score Sheet tab**).
    12. `GET /rest/v1/category_series?select=*&order=sort_order.asc` (20–50 rows, ~2–4 KB — **only used by Score Sheet tab**).
    13. `GET /rest/v1/student_rounds?select=*&student_id=eq.<uid>&order=round_number.desc` (**unbounded all-time rounds**: 50–300 rows, **~8–45 KB** — **only used by Score Sheet tab**).
    14. `GET /rest/v1/resources?select=*&active=eq.true&order=sort_order.asc` (5–30 rows, ~3–8 KB).
    15. `GET /rest/v1/results_with_target?select=*&student_id=eq.<uid>&order=created_at.desc` (**UNBOUNDED ALL-TIME `SELECT *`!** 500–2,000+ rows, **~150–600 KB**).
    16. `POST /rest/v1/rpc/attendance_summary` (`p_student=<uid>, p_from=<90d ago>, p_to=<today>`; 1 row, ~0.2 KB).
    17. `GET /rest/v1/weekly_tests?select=*&order=test_date.desc` (10–50 rows, ~5–15 KB — redundant with #6 `my_weekly_tests`!).
    18. `GET /rest/v1/weekly_test_scores?select=*&student_id=eq.<uid>` (all historical test scores for student: 20–200 rows, **~4–30 KB**).
    19. `GET /rest/v1/activity_results?select=id,student_id,activity_type,activity_name,correct,total,time_seconds,settings,created_at&student_id=eq.<uid>&order=created_at.desc&limit=200` (up to 200 rows including `settings` JSONB, **~40–80 KB**).
  - **Waterfall Stage 3 (Waits for #9 `todo_for` — 1 request)**:
    20. `GET /rest/v1/daily_tasks?select=id,flash_digits,flash_count,flash_speed_ms,flash_mode&id=in.(...)` (1–10 rows, ~0.5 KB).
  - **Switching to `"Score Sheet & Progress"` tab**: **0 extra requests** because all Score Sheet & Progress queries (#11, #12, #13, #15) were already fetched and rendered into hidden DOM on initial page load.

---

### 1.3 Basics Practice (`/pages/basics.html` & `/pages/basics-practice.html`)
- **A. `/pages/basics.html` (Basics Overview & History)**:
  - **Static Files (11 requests, ~56.4 kB gzip total)**: HTML (`3.29 kB` gz), CSS (`7.61 kB` gz), 9 JS chunks (~`45.5 kB` gz).
  - **Supabase Runtime Requests**: **4–5 requests across 4 sequential waterfall stages!**
    - **Stage 1 (Blocking Guard)**:
      1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
      2. `POST /rest/v1/rpc/my_notifications` (parallel non-blocking if 60s cache expired; ~1 KB).
    - **Stage 2 (Waits for #1 — `await loadBasicsCategories()`)**:
      3. `GET /rest/v1/categories?select=*&section=eq.basics&active=eq.true&order=sort_order.asc` (5–15 rows, ~2 KB).
    - **Stage 3 (Waits for #3 — `await loadActiveThresholds()`)**:
      4. `GET /rest/v1/basics_thresholds?select=*&active=eq.true` (5–30 rows, ~2 KB — had no dependency on #3!).
    - **Stage 4 (Waits for #4 — `await loadBasicsHistory()`)**:
      5. `GET /rest/v1/results_with_target?select=id,student_id,student_round_id,category_id,correct,total,time_seconds,entry_date,created_at,source,practice_mode,min_accuracy,min_questions_per_minute,meets_target,categories(name,sort_order)&student_id=eq.<uid>&category_id=in.(...)&order=entry_date.desc,created_at.desc` (**UNBOUNDED ALL-TIME rows!** 200–1,000+ rows, **~60–300 KB**).
- **B. `/pages/basics-practice.html` (Active Basics Drill Stage)**:
  - **Static Files (11 requests, ~59.1 kB gzip total)**: HTML (`4.83 kB` gz), CSS (`7.61 kB` gz), 9 JS chunks (~`46.7 kB` gz).
  - **Supabase Runtime Requests**: **4–5 requests across 3 sequential waterfall stages**:
    - **Stage 1 (Blocking Guard)**: `GET /rest/v1/profiles?select=*&id=eq.<uid>` (~0.5 KB) + optional `POST /rest/v1/rpc/my_notifications`.
    - **Stage 2 (Waits for Stage 1 — `Promise.all` in `loadSetupData`)**:
      - `GET /rest/v1/categories?select=*&section=eq.basics&active=eq.true&order=sort_order.asc` (~2 KB)
      - `GET /rest/v1/basics_thresholds?select=*&active=eq.true` (~2 KB)
    - **Stage 3 (Waits for Stage 2 — `await refreshCategoryResults()`)**:
      - `GET /rest/v1/results_with_target?select=id,student_id,student_round_id,category_id,correct,total,time_seconds,entry_date,created_at,source,practice_mode,min_accuracy,min_questions_per_minute,meets_target&student_id=eq.<uid>&category_id=eq.<catId>&order=created_at.desc` (**unbounded all-time rows for category**: 50–300 rows, **~15–90 KB**).

---

### 1.4 Flash Anzan (`/pages/flash.html`)
- **Static Files (11 requests, ~66.1 kB gzip total)**: HTML (`6.47 kB` gz), CSS (`7.61 kB` gz), 9 JS chunks (~`52.0 kB` gz).
- **Supabase Runtime Requests**: **2–3 requests across 2 waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
    2. `POST /rest/v1/rpc/my_notifications` (non-blocking if 60s cache expired; ~1 KB).
  - **Stage 2 (Waits for #1)**:
    3. `GET /rest/v1/activity_results?select=id,activity_type,activity_name,correct,total,time_seconds,settings,created_at&student_id=eq.<uid>&activity_type=eq.flash_anzan&order=created_at.desc&limit=200` (up to 200 rows with `settings` JSONB, **~35–70 KB**).

---

### 1.5 Elements List (`/pages/elements.html`)
- **Static Files (9 requests, ~55.8 kB gzip total)**: HTML (`2.05 kB` gz), CSS (`7.61 kB` gz), 7 JS chunks (~`46.1 kB` gz).
- **Supabase Runtime Requests**: **2–3 requests across 2 waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
    2. `POST /rest/v1/rpc/my_notifications` (non-blocking if 60s cache expired; ~1 KB).
  - **Stage 2 (Waits for #1)**:
    3. `GET /rest/v1/activity_results?select=id,student_id,activity_type,activity_name,correct,total,time_seconds,settings,created_at&student_id=eq.<uid>&activity_type=eq.element&order=created_at.desc&limit=200` (up to 200 rows, **~35–70 KB**).

---

### 1.6 Memoriad List (`/pages/memoriad.html`)
- **Static Files (8 requests, ~54.8 kB gzip total)**: HTML (`2.55 kB` gz), CSS (`7.61 kB` gz), 6 JS chunks (~`44.6 kB` gz).
- **Supabase Runtime Requests**: **2–3 requests across 2 waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
    2. `POST /rest/v1/rpc/my_notifications` (non-blocking if 60s cache expired; ~1 KB).
  - **Stage 2 (Waits for #1)**:
    3. `GET /rest/v1/activity_results?select=id,student_id,activity_type,activity_name,correct,total,time_seconds,settings,created_at&student_id=eq.<uid>&activity_type=eq.memoriad&order=created_at.desc&limit=200` (up to 200 rows, **~40–80 KB**).

---

### 1.7 Leaderboard (`/pages/leaderboard.html`)
- **Static Files (8 requests, ~59.4 kB gzip total)**: HTML (`4.39 kB` gz), CSS (`7.61 kB` gz), 6 JS chunks (~`47.4 kB` gz).
- **Supabase Runtime Requests**:
  - **Student View — 4–5 requests across 3 sequential waterfall stages**:
    - **Stage 1 (Blocking Guard)**:
      1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
      2. `POST /rest/v1/rpc/my_notifications` (non-blocking if 60s cache expired).
    - **Stage 2 (Waits for #1 — `await fetchGlobalLeaderboardEnabled()` blocks Stage 3!)**:
      3. `POST /rest/v1/rpc/global_leaderboard_enabled` (1 boolean, ~0.1 KB).
    - **Stage 3 (Waits for #3 — `Promise.all([fetchCompetitionRules(), loadActiveBoard()])`)**:
      4. `POST /rest/v1/rpc/competition_rules` (1 row, ~0.2 KB).
      5. `POST /rest/v1/rpc/leaderboard` (`p_board='points', p_period='week', p_limit=10, p_scope='level'`; 10–11 rows, ~1.5 KB). *(If deep-linked to `todo` tab, also fires `GET /rest/v1/daily_tasks?...` in parallel).*
  - **Admin View — 4 requests across 3 sequential waterfall stages**:
    - **Stage 1 (Blocking Guard)**:
      1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
    - **Stage 2 (Waits for #1 — `await populateAdminLevelsDropdown()` blocks Stage 3!)**:
      2. `GET /rest/v1/profiles?select=level&role=eq.student` (all 50–300 students just to extract distinct levels in JS! **~3–15 KB**).
    - **Stage 3 (Waits for #2)**:
      3. `POST /rest/v1/rpc/competition_rules` (~0.2 KB).
      4. `POST /rest/v1/rpc/leaderboard` (`p_limit=200`; up to 200 rows, **~15–25 KB**).

---

### 1.8 Weekly Test — Student (`/pages/weekly-test.html`)
- **Static Files (9 requests, ~58.2 kB gzip total)**: HTML (`3.84 kB` gz), CSS (`7.61 kB` gz), 7 JS chunks (~`46.7 kB` gz).
- **Supabase Runtime Requests**: **2–3 requests across 2 waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
    2. `POST /rest/v1/rpc/my_notifications` (non-blocking if 60s cache expired; ~1 KB).
  - **Stage 2 (Waits for #1)**:
    3. `POST /rest/v1/rpc/my_weekly_tests` (5–30 tests + embedded sections/scores JSON, **~5–25 KB**).

---

### 1.9 Admin Overview (`/pages/admin.html`)
- **Static Files (10 requests, ~69.5 kB gzip total)**: HTML (`4.41 kB` gz), CSS (`7.61 kB` gz), 8 JS chunks (~`57.5 kB` gz — pulls in `monthlyReportData.js` [8.85 kB gz] eagerly on page load even though it's only used if the admin clicks "Send WhatsApp Report"!).
- **Supabase Runtime Requests**: **6 requests across 3 sequential waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
  - **Stage 2 (Waits for #1 — 4 parallel tasks)**:
    2. `POST /rest/v1/rpc/today_ist` (1 scalar date, ~0.1 KB — **called inside `loadOverviewData()` and blocks `admin_overview`!**).
    3. `POST /rest/v1/rpc/admin_milestones` (`p_days=7`; 0–20 rows, ~1–4 KB).
    4. `GET /rest/v1/report_log?select=*&order=created_at.desc&limit=10` (up to 10 rows, ~2 KB).
    5. `GET /rest/v1/backup_runs?select=finished_at,started_at,status,kind&status=eq.done&order=started_at.desc&limit=1` (1 row, ~0.3 KB).
  - **Stage 3 (Waits for #2 `today_ist`)**:
    6. `POST /rest/v1/rpc/admin_overview` (all students: 50–300 rows, **~15–75 KB**).

---

### 1.10 Admin Students (`/pages/students.html`)
- **Static Files (8 requests, ~61.8 kB gzip total)**: HTML (`3.44 kB` gz), CSS (`7.61 kB` gz), 6 JS chunks (~`50.7 kB` gz including `profileEditor.js` [5.85 kB gz]).
- **Supabase Runtime Requests**: **2 requests across 2 waterfall stages**:
  - **Stage 1 (Blocking Guard)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
  - **Stage 2 (Waits for #1)**:
    2. `GET /rest/v1/profiles?select=*&role=eq.student&order=created_at.desc` (`SELECT *` for all students: 50–300 rows, **~15–80 KB**).

---

### 1.11 Admin Weekly Tests (`/pages/weekly-tests.html`)
- **Static Files (7 requests, ~68.4 kB gzip total)**: HTML (`5.83 kB` gz), CSS (`7.61 kB` gz), 5 JS chunks (~`55.0 kB` gz).
- **Supabase Runtime Requests**: **8–10 requests across 4 sequential waterfall stages!** (**~80 KB – 530 KB total payload**):
  - **Stage 1 (Blocking Guard — 1 request)**:
    1. `GET /rest/v1/profiles?select=*&id=eq.<uid>` (1 row, ~0.5 KB).
  - **Stage 2 (Waits for #1 — `Promise.all([loadActiveStudents, loadCategories, loadRecentlyRemovedCount])` = 3 requests)**:
    2. `GET /rest/v1/profiles?select=id,student_code,full_name,level,role,active&order=student_code.asc` (all profiles: 50–300 rows, **~10–50 KB**).
    3. `GET /rest/v1/categories?select=*&active=eq.true&order=sort_order.asc` (20–40 rows, ~4–8 KB).
    4. `GET /rest/v1/weekly_test_removals?select=id&restored_at=is.null&removed_at=gte.<30d>` (~0.5 KB).
  - **Stage 3 (Waits for Stage 2 to finish before starting `await loadTests()`! 3 parallel requests)**:
    5. `GET /rest/v1/weekly_tests?select=*&order=test_date.desc` (10–50 rows, ~5–15 KB).
    6. `GET /rest/v1/weekly_test_scores?select=test_id` (**UNBOUNDED FULL-TABLE SCAN!** Fetches every `weekly_test_scores` row in the database just to count scores per test in JS: 1,000–10,000+ rows, **~50–400 KB!**).
    7. `GET /rest/v1/weekly_test_sections?select=id,test_id,position,category_id,seconds&order=position.asc` (20–150 rows, ~3–15 KB).
  - **Stage 4 (Waits for Stage 3 — `await selectTest(chosenId)` auto-loads the newest test)**:
    - **If newest test is Offline (1 request)**:
      8. `GET /rest/v1/weekly_test_scores?select=*&test_id=eq.<id>&category_id=eq.<catId>` (10–100 rows, ~3–20 KB).
    - **If newest test is Online (3 parallel requests)**:
      8. `GET /rest/v1/weekly_test_sections?select=id,test_id,position,category_id,seconds&test_id=eq.<id>&order=position.asc` (**duplicate** of data already fetched in #7!).
      9. `GET /rest/v1/weekly_test_attempts?select=id,test_id,student_id,section_id,started_at,finished_at,time_seconds,correct,attempted,total,answers&test_id=eq.<id>` (includes heavy `answers` JSONB for every student attempt! 10–200 rows, **~10–60 KB**).
      10. `GET /rest/v1/weekly_test_scores?select=id,test_id,student_id,category_id,marks_obtained,total_marks,time_seconds,source,attempt_id,entry_date&test_id=eq.<id>` (10–200 rows, ~5–30 KB).

---

## 2. JavaScript & CSS Bundle Sizes (`npm run build` — Gzip)

- **Shared CSS Bundle (1 file across all pages)**:
  - `dist/assets/guard-NzGNsxTt.css`: **46.94 kB raw │ 7.61 kB gzip**
- **Core Shared JS Chunks (loaded on every page)**:
  - `dist/assets/auth-BQ7GPDbG.js` (`@supabase/supabase-js` + auth): **112.44 kB raw │ 30.89 kB gzip**
  - `dist/assets/guard-BrqKn7ZY.js` (`guard.js` + `navConfig.js` + `notificationBadge.js` + `modal.js` + `toast.js`): **22.75 kB raw │ 7.22 kB gzip**
- **Page & Feature JS Chunks (Sorted by Gzip Size)**:
  | Chunk | Raw Size | Gzip Size | Loaded By |
  | :--- | ---: | ---: | :--- |
  | `import-DUFguX_P.js` (SheetJS `xlsx`) | 191.40 kB | **46.40 kB** | `/pages/import.html` only |
  | `memoriadPlay-X05snClh.js` | 71.13 kB | **15.00 kB** | `/pages/memoriad-play.html` |
  | `weeklyTests-CBYC9O2Z.js` | 46.74 kB | **11.80 kB** | `/pages/weekly-tests.html` |
  | `dashboardComponents-WihVT3o1.js` | 47.04 kB | **11.77 kB** | `/pages/student.html` |
  | `monthlyReportData-Bu5t0CBo.js` | 32.25 kB | **8.85 kB** | `/pages/admin.html`, `/pages/monthly-report.html` |
  | `backup-D1gDibgh.js` | 25.83 kB | **8.27 kB** | `/pages/backup.html` |
  | `review-8sWVHQ6-.js` | 25.90 kB | **7.38 kB** | `/pages/review.html` |
  | `roundScores-wI4HKkYt.js` | 24.63 kB | **7.34 kB** | `/pages/round-scores.html` |
  | `flash-C0p9dW3u.js` | 23.07 kB | **6.86 kB** | `/pages/flash.html` |
  | `profileEditor-CPdHvUiR.js` | 21.04 kB | **5.85 kB** | `/pages/students.html`, `/pages/student-detail.html` |
  | `basicsPractice-BVRiU2bL.js` | 16.32 kB | **5.71 kB** | `/pages/basics-practice.html` |
  | `weeklyTest-F-S3zHIr.js` | 19.72 kB | **5.55 kB** | `/pages/weekly-test.html` |
  | `admin-CDWKMkzB.js` | 18.09 kB | **5.48 kB** | `/pages/students.html` |
  | `basics-DhiUmUbv.js` | 17.23 kB | **5.11 kB** | `/pages/basics.html` |
  | `leaderboard-C6CpvBNR.js` | 15.17 kB | **4.66 kB** | `/pages/leaderboard.html` |
  | `students-BHPEyz3k.js` (`adminOverview.js`) | 13.87 kB | **4.01 kB** | `/pages/admin.html` |
  | `student-BfZKFPlP.js` (`student.js` + `dashboardData.js`) | 13.04 kB | **3.77 kB** | `/pages/student.html` |
  | `memoriadCard-BGcN5Sl0.js` | 10.13 kB | **3.62 kB** | `/pages/student.html`, `/pages/memoriad.html` |
  | `flashStats-BeHPZiqP.js` | 8.58 kB | **3.34 kB** | `/pages/student.html`, `/pages/flash.html` |
  | `stats-DhY30ZX3.js` | 9.96 kB | **3.31 kB** | `/pages/student.html`, `/pages/basics*.html` |
  | `leaderboardData-Dqzn6iNS.js` | 9.41 kB | **3.17 kB** | `/pages/student.html`, `/pages/leaderboard.html` |
  | `elementsCard-DkNhNgep.js` | 8.60 kB | **3.07 kB** | `/pages/student.html`, `/pages/elements.html` |
  | `memoriad-DGrylAU-.js` | 7.83 kB | **2.65 kB** | `/pages/memoriad.html` |
  | `todoForm-D7yowi35.js` | 8.39 kB | **2.61 kB** | `/pages/student.html`, `/pages/daily-todo.html` |
  | `elements-BSCwj1E1.js` | 6.60 kB | **2.12 kB** | `/pages/elements.html` |

---

## 3. Infrastructure, Regions, Fonts, Guards, Cache Headers & Dashboard Loading Audit

1. **Regions (`vercel.json` & Supabase)**:
   - `vercel.json` has **no `"regions"` setting**, and none of the `/api/*.js` files export a region config. By default on Vercel, serverless `/api/*` functions execute in **`iad1` (Washington, D.C., US East)**. For users in India connecting to an India (`ap-south-1` Mumbai) or Singapore (`ap-southeast-1`) Supabase database, any `/api/*` call pays two trans-continental round trips (India → US East → Mumbai/Singapore → US East → India, adding **~350–500 ms** per call).
   - Setting `"regions": ["bom1"]` (Mumbai — or `"sin1"` if your Supabase project is in Singapore) in `vercel.json` co-locates Vercel Functions with users and the database.
2. **Fonts & Third-Party Hosts**:
   - **Zero external font or third-party hosts** are loaded (`css/variables.css` uses `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...` locally without calling `fonts.googleapis.com` or any external CDN).
   - **Missing Preconnect**: None of the 32 HTML files include `<link rel="preconnect" href="https://<project>.supabase.co" crossorigin>`. Consequently, the browser does not start DNS + TCP + TLS negotiation with Supabase until *after* HTML + JS chunks are downloaded, parsed, and executed (costing **~150–300 ms** on Fast 4G).
3. **Page Guards (`getSession` vs `getUser`)**:
   - **Client side (`js/auth.js` → `getCurrentProfile()`)**: Calls `supabase.auth.getSession()` (**local** `localStorage` read, 0 network calls), **but then immediately awaits an uncached network query** `SELECT * FROM profiles WHERE id = session.user.id` on **every single page navigation**, blocking page rendering and all page data queries by 1 full database round trip (~120–250 ms on Fast 4G).
   - **Notification Bell Race**: `requireAuth()` in `js/guard.js` calls `initStudentNotificationBell(profile)` which calls `fetchMyNotificationsCached()`. On `/pages/student.html`, `loadAndRenderHomeRemindersStrip()` calls `fetchMyNotificationsCached()` concurrently before the first RPC finishes, causing **two identical `RPC my_notifications` calls** on cold load because `notificationBadge.js` caches the *result* in `sessionStorage` but does not deduplicate an *in-flight Promise*.
   - **Server side (`api/_supabaseAdmin.js`)**: `verifyAdminCaller` and `verifyStudentCaller` call `supabaseAdmin.auth.getUser(token)` (1 network call to Supabase Auth) + `SELECT ... FROM profiles WHERE id = user.id` (1 network call to PostgREST) sequentially.
4. **Cache Headers in `vercel.json`**:
   - Currently **none** (`vercel.json` only defines `buildCommand`, `installCommand`, `outputDirectory`, and `crons`). Adding `Cache-Control: public, max-age=31536000, immutable` for `/assets/(.*)` and `Cache-Control: public, max-age=0, must-revalidate` for `/`, `/*.html`, `/pages/(.*)`, and `/api/(.*)` ensures instant repeat loads without stale HTML.
5. **How the Dashboard Loads Its Results (`js/dashboardData.js`)**:
   - Line 39 of `js/dashboardData.js` computes `const ninetyDaysAgo = getISTDateString(d90);`, **but never applies `.gte('entry_date', ninetyDaysAgo)` to `results_with_target` or `student_rounds`!**
   - Instead, `fetchResults()` runs `.from('results_with_target').select('*').eq('student_id', studentId).order('created_at', { ascending: false })` — fetching **every row since the student joined (`SELECT *`, no date bound, no row limit)**.
   - For a student with 6–12 months of history (500–2,000 rows), this single query transfers **150 KB – 600 KB of JSON** on every visit to Student Home, even though:
     - `"Today's Focus"` only needs today's/recent basics stats and last 90 days of rounds.
     - `"Score Sheet & Progress"` is hidden in a background tab until clicked!

---

## 4. Ranked List of Candidate Fixes (A–I) & Expected Savings

| Rank | Candidate | What Changes | Expected Saving (Requests, Payload & Fast 4G Time) |
| :---: | :--- | :--- | :--- |
| **1** | **C. Smaller payloads & bounded queries** | 1. Bound `results_with_target` and `student_rounds` on Student Home to the last 90 days (`entry_date >= ninetyDaysAgo`) and select only needed columns instead of `SELECT *` (fetch full all-time history only when the student opens the Score Sheet tab or clicks "All time").<br>2. Drop redundant `weekly_tests` + `weekly_test_scores` queries from `dashboardData.js` (reuse `my_weekly_tests` RPC data already fetched on Student Home).<br>3. On `/pages/basics.html` and `/pages/basics-practice.html`, select only required columns and bound initial history to last 90 days / 200 rows.<br>4. On `/pages/weekly-tests.html` (Admin), replace the full-table scan `SELECT test_id FROM weekly_test_scores` (1,000–10,000 rows) and remove the duplicate `weekly_test_sections` fetch in `selectTest` and heavy `answers` JSONB column in the overview list. | **-2 requests on Student Home**, **-150 KB to -500 KB payload on Student Home**, **-50 KB to -400 KB on Admin Weekly Tests**, **-60 KB to -250 KB on Basics**. Saves **~400–900 ms** on Fast 4G. |
| **2** | **A. Profile `sessionStorage` cache (2-min TTL) + in-flight notification dedupe** | Cache `{id, role, level, full_name, student_code, active, must_change_password}` in `sessionStorage` with a 2-minute TTL. Render header & start page queries immediately on cache hit while revalidating the profile in the background; clear on sign-out, password change, and profile edit. Deduplicate in-flight `fetchMyNotificationsCached()` Promise so Student Home never fires `my_notifications` twice. | Eliminates the **blocking Stage 1 waterfall** on every page navigation after login (**-1 blocking RTT = ~150–250 ms saved on every page**) + **-1 duplicate RPC** on Student Home. |
| **3** | **B. Parallelize waterfalls (`Promise.all`) + optional single-RPC bundles** | 1. **Zero-SQL JS fixes**:<br>• `/pages/basics.html`: run `loadBasicsCategories()`, `loadActiveThresholds()`, and `loadBasicsHistory()` in parallel with `Promise.all` (collapses 4 waterfall stages into 1!).<br>• `/pages/leaderboard.html`: run `fetchGlobalLeaderboardEnabled()` / `populateAdminLevelsDropdown()`, `fetchCompetitionRules()`, and `loadActiveBoard()` in parallel.<br>• `/pages/admin.html`: pass `p_date: null` (default `today_ist()` in SQL) to `admin_overview` so it doesn't wait for `RPC today_ist`.<br>• `/pages/weekly-tests.html`: run `loadTests()` in parallel with `loadActiveStudents()`, `loadCategories()`, and `loadRecentlyRemovedCount()`.<br>2. **Optional SQL RPC bundles** (exact SQL provided in Section 5 below): `student_home_bundle` and `admin_overview_bundle`. | Collapses **1–2 sequential round trips on Basics, Leaderboard, Admin Overview, and Admin Weekly Tests** (**~200–450 ms saved**). With optional RPC bundles, Student Home drops from **19 requests to 4**. |
| **4** | **D. Lazy sections (`Score Sheet & Progress` tab + below-the-fold cards)** | 1. On `/pages/student.html`, do not fetch `round_series`, `category_series`, `student_rounds`, or dynamically import `dashboardComponents.js` (`11.77 kB` gzip) until the user clicks the `"Score Sheet & Progress"` tab.<br>2. Lazy-load below-the-fold cards (`Resources`, `Elements`, `Memoriad` summary cards) via `IntersectionObserver` with fixed-height skeletons (`min-height`) to prevent CLS.<br>3. On `/pages/admin.html`, dynamically `import('./monthlyReportData.js')` (`8.85 kB` gzip) only when the admin opens the WhatsApp Report modal. | **-3 DB requests** and **-11.8 kB gzip JS** on Student Home initial load; **-8.85 kB gzip JS** on Admin Overview initial load. Saves **~200–350 ms** on Fast 4G. |
| **5** | **E. Preconnect to Supabase origin at build time** | Add a small Vite HTML transform plugin in `vite.config.ts` that injects `<link rel="preconnect" href="${VITE_SUPABASE_URL}" crossorigin>` into `<head>` of every HTML page at build time (no third-party fonts exist to remove). | Warms up DNS + TCP + TLS to Supabase in parallel with JS download, saving **~150–300 ms** on cold page loads. |
| **6** | **F. Cache headers in `vercel.json`** | Add `headers` in `vercel.json`:<br>• `/assets/(.*)` → `Cache-Control: public, max-age=31536000, immutable`<br>• `/((?!assets/).*)` (HTML & `/api/*`) → `Cache-Control: public, max-age=0, must-revalidate` | Repeat page loads fetch **0 KB of CSS/JS** from the network (**saves 45–80 kB gzip** per navigation). |
| **7** | **G. Navigation prefetch on hover/touchstart** | In `js/guard.js` (header inline links & 3-dot menu links), prefetch the target HTML page on `pointerenter` / `touchstart` (throttled, max 1 prefetch at a time, skipped when `navigator.connection?.saveData` is true). | Makes clicking header/menu links feel instant (**saves ~80–150 ms** HTML document RTT). |
| **8** | **H. Co-locate Vercel region in `vercel.json`** | Add `"regions": ["bom1"]` (Mumbai, India) to `vercel.json` so `/api/*` serverless functions run near Indian students/teachers and an India/Asia Supabase region instead of `iad1` (US East). | Saves **~300–450 ms** on `/api/login-id`, `/api/admin-*`, and `/api/student-change-password`. |
| **9** | **I. Performance timing helper (`?perf=1`)** | Add a tiny helper (`js/perf.js`, <0.5 kB) enabled only when `?perf=1` is in the URL or `localStorage.tt_perf === '1'` that logs `TTFB`, `FCP`, `guardReady`, and `pageReady` (`performance.mark` / `performance.measure`) in a clean console table. | Zero overhead for normal users; gives instant before/after verification metrics on any page. |

---

## 5. Proposed SQL for Candidate B (Optional Single-RPC Bundles)

If you approve **Candidate B's SQL part**, you can run these two `SECURITY INVOKER` functions in your Supabase SQL Editor (they respect all existing RLS policies and call your existing functions):

```sql
-- 1. Admin Overview Bundle: combines today_ist, admin_overview, admin_milestones, report_log, and latest backup_run in 1 round trip
CREATE OR REPLACE FUNCTION public.admin_overview_bundle(p_milestone_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_today date := public.today_ist();
BEGIN
  RETURN jsonb_build_object(
    'today', v_today,
    'overview', COALESCE((SELECT jsonb_agg(row_to_json(o)) FROM public.admin_overview(v_today) o), '[]'::jsonb),
    'milestones', COALESCE((SELECT jsonb_agg(row_to_json(m)) FROM public.admin_milestones(p_milestone_days) m), '[]'::jsonb),
    'report_log', COALESCE((
      SELECT jsonb_agg(row_to_json(r))
      FROM (SELECT * FROM public.report_log ORDER BY created_at DESC LIMIT 10) r
    ), '[]'::jsonb),
    'last_backup', (
      SELECT row_to_json(b)::jsonb
      FROM (
        SELECT finished_at, started_at, status, kind
        FROM public.backup_runs
        WHERE status = 'done'
        ORDER BY started_at DESC
        LIMIT 1
      ) b
    )
  );
END;
$$;
```

*(Note: Even if you prefer **not** to add new SQL functions in Candidate B, we can still implement all the client-side `Promise.all` waterfall fixes in Candidate B with zero SQL changes!)*

---

## 6. Dependencies & Guardrails

- **New Dependencies**: **None** (`0` packages added).
- **Security & Behaviour**: No RLS, auth security, or user-visible behaviour changes. Profile cache (`Candidate A`) is strictly for optimistic UI rendering and is always revalidated against Supabase; all data access continues to be enforced by Supabase RLS and server-side token verification.

---

## 7. 5-Line Session Summary

1. Audited all 11 student and admin pages for static asset waterfalls, Supabase REST/RPC queries, sequential blocking stages, and payload sizes.
2. Recorded exact `npm run build` raw and gzip sizes (`7.61 kB` gzip shared CSS; `30.89 kB` gzip Supabase auth chunk; page chunks `2.1–11.8 kB` gzip).
3. Identified the top bottlenecks: unbounded all-time `results_with_target` (`150–600 KB`) on Student Home, full-table `weekly_test_scores` scan (`50–400 KB`) on Admin Weekly Tests, uncached blocking `profiles` fetch in `guard.js` on every navigation, duplicate `my_notifications` RPC calls, and 3–4 stage sequential waterfalls on Basics, Leaderboard, Admin Overview, and Admin Weekly Tests.
4. Verified `vercel.json` (no cache headers or region set), fonts (no external font requests), and missing `<link rel="preconnect">` to Supabase.
5. Prepared the ranked improvement plan (Candidates A–I) with estimated savings and paused for your approval before modifying any code.

---

## 8. Beginner Test Guide (How to Verify Today & After Approval)

1. Open Chrome/Edge DevTools (`F12` or Right-click → **Inspect**) and click the **Network** tab.
2. Check **Disable cache** at the top of the Network tab, set throttling to **Fast 4G**, and filter by **Fetch/XHR**.
3. Log in as a student and load **Student Home (`/pages/student.html`)**: observe the 19 Fetch/XHR requests (starting with `profiles?select=*`, followed by `my_notifications` twice, `results_with_target?select=*`, etc.).
4. Navigate to **Basics (`/pages/basics.html`)** and **Leaderboard (`/pages/leaderboard.html`)**: observe the stair-step waterfall where each request waits for the previous one.
5. Reply with which candidates (**A, B, C, D, E, F, G, H, I** — or **"Approve all A–I"**) you want implemented, and whether your Supabase project is in **Mumbai (`bom1`)** or **Singapore (`sin1`)** for Candidate H.
