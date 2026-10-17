# Phase 3: Student Dashboard & Admin Management (Daily To-Do & Resources)

An interactive, responsive student dashboard and comprehensive administrative management suite for **Trendz Tracker**, designed for students preparing for the Junior Mental Calculation World Championship. Built with vanilla HTML5, CSS custom properties, and modular JavaScript without external frameworks or third-party chart libraries.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural decisions and user preferences have been confirmed and will guide the build:

- **Demo & Offline Fallback**: All mock fallbacks for RPCs (`streak_for`, `todo_for`, `today_ist()`) and the `resources` table are isolated into a single file (`js/demoDb.js`) containing fixed, static sample data (e.g., streak of 8, 1 shield used, 4 of 7 to-dos done). Demo mode is enabled **only** when Supabase keys are placeholders; it is strictly locked out once real credentials exist. A prominent banner *"DEMO MODE — data is fake"* will appear on all pages in demo mode. Admin create actions will be safely blocked in demo mode.
- **Round History Sheet Pagination**: The competition sheet table displays 5 rounds at a time (newest first). Pagination shifts batches of 5 rounds using "Older" and "Newer" buttons with a descriptive badge (e.g. `Rounds 240–244 · 12 Oct – 17 Oct`), disabling boundaries when reaching newest/oldest rounds. The category column remains sticky on both mobile and desktop.
- **Responsive Desktop Layout**:
  - **Top Row (Two-Column Grid)**: Greeting & action buttons, Streak card, Today's to-do, Basics this week, Learning resources.
  - **Bottom Row (Full Width)**: Sheet-style 5-round score table and inline SVG progress charts (Accuracy, Speed, Category Drilldown) spanning the full width for optimal legibility.
- **Pure Statistics Calculations (`js/stats.js`)**: All aggregations (accuracy, speed in questions/minute, 30-day trends, category drilldowns) reside in a standalone, pure JS module with no DOM manipulation, ensuring high testability and reliability.
- **Database-Authoritative Logic & Timezone**: Streaks, shields, and daily to-do completion are calculated strictly within PostgreSQL RPCs (`streak_for`, `todo_for`). Dates and "today" are locked to Indian Standard Time (`Asia/Kolkata`) via `today_ist()`, preventing client clock manipulation.

---

## 1. Overview & Core Concept

### What It Delivers
1. **Student Dashboard (`/pages/student.html`)**:
   - **Hero & Actions**: Personalized greeting, student code, level badge, and primary buttons for Phase 2 entry screens (*Enter Round Scores* & *Enter Basics*).
   - **Streak & Shield Card**: Visual streak counter, all-time best streak, freeze/shield status, today's completion indicator, and upcoming milestone markers (7, 25, 50, 100 days) with inline SVG iconography.
   - **Today's To-Do**: Real-time checklist from `todo_for`, showing completion progress (e.g., "4 of 7 done today"), clickable task links directly pre-filling the relevant entry screen, and an empty state if no tasks are assigned.
   - **Competition Round Sheet Table**: Faithful recreation of the abacus paper sheet. Active round categories as rows, last 5 rounds as columns, color-coded cells using `js/scoreColors.js`, and summary rows for Total Time, Final Score, Total Attempts, and Marks to be Corrected, plus "Partial" round badges and 5-round pagination.
   - **Accessible Inline SVG Charts**: 30-day Accuracy trend (`sum(correct)/sum(total)`), 30-day Speed trend (`sum(total) / (sum(time_seconds) / 60)`), and an interactive Category Drilldown showing the last 10 entries with hover/tap inspection tooltips and accessibility summary tables.
   - **Basics This Week**: 7-day roll-up of mental speed drills (1d4r, 2d2r) showing entry counts, average accuracy, and speed.
   - **Learning Resources**: Curated practice PDFs, guides, and links grouped by topic, sorted by `sort_order`, with strict HTTP/HTTPS validation and `rel="noopener noreferrer"`.

2. **Admin Daily To-Do Management (`/pages/todos.html`)**:
   - Interface to view, create, edit, reorder (up/down), and activate/deactivate daily student assignments.
   - Dynamic category selector that updates according to the chosen section (`round`, `basics`, `elements`, `flash`).
   - Clear instructional guide explaining task evaluation rules (category-level vs. section-level completion).

3. **Admin Resources Management (`/pages/resources.html`)**:
   - Management console to list, add, edit, reorder, and activate/deactivate study materials and reference links with browser-side and database-enforced URL validation.

4. **Unified Admin Navigation**:
   - Standardized top navigation across all admin pages: *Students*, *Daily To-Do*, *Resources*, *Categories*, and *Rounds*.

---

## 2. User Experience & Visual Design

### Design Language & Layout
- **Design Constitution Compliance**: Follows the `frontend-design` constitution and SaaS dashboard guidelines.
- **Zero-Pill Discipline**: Static metadata (dates, levels, categories) rendered as clean typography with subtle separators (`·`), reserving bordered pill shapes strictly for interactive buttons, tabs, and score feedback badges.
- **Tabular Figures**: All timestamps (`mm:ss`), scores (`18/20`), dates, and metrics use tabular numerals (`font-mono` / `tabular-nums`) to prevent layout jitter.
- **Color Coding**: Reuses `getScoreFeedback` from `js/scoreColors.js` directly:
  - `0 wrong` (100%): Emerald green (`--color-score-perfect`)
  - `1–10 wrong`: Amber warning (`--color-score-warning`)
  - `>10 wrong`: Cyan alert (`--color-score-alert`)
  - Empty/Unattempted: Neutral slate (`--color-neutral`)

### Layout Wireframe (Desktop)
```
┌────────────────────────────────────────────────────────────────────────┐
│ Top Bar: Brand 🧮 Trendz Tracker | Nav Links | User Code · Sign Out    │
├────────────────────────────────────────────────────────────────────────┤
│ [DEMO BANNER (if active)]                                              │
├───────────────────────────────────┬────────────────────────────────────┤
│ Greeting & Action Buttons         │ Streak & Milestone Card            │
│ [Enter Round Scores] [Enter Basics]│ 🔥 Current: 8 | 🛡️ Shield Ready   │
├───────────────────────────────────┼────────────────────────────────────┤
│ Today's To-Do (4 of 7 done)       │ Basics This Week (Last 7 Days)     │
│ [x] Round 242 ADD                 │ 1d4r: 6 entries · 96% · 42 q/m     │
│ [ ] Basics 2d2r                   │ 2d2r: 4 entries · 88% · 28 q/m     │
├───────────────────────────────────┴────────────────────────────────────┤
│ Learning Resources (Grouped by Topic)                                  │
│ • Championship Rules · Mental Speed Drill Guide                        │
├────────────────────────────────────────────────────────────────────────┤
│ Competition Score Sheet (Last 5 Rounds)          [< Older] [Newer >]   │
│ Categories (Sticky) │ Round 244 │ Round 243 │ Round 242 │ Round 241    │
│ 1. ADD              │ 20/20     │ 19/20     │ 20/20     │ —            │
│ 2. SUB              │ 18/20     │ 20/20     │ 17/20     │ —            │
│ Summary Rows: Time Taken | Final Score | Total Attempt | Corrections   │
├───────────────────────────────────┬────────────────────────────────────┤
│ 30-Day Accuracy Trend (SVG)       │ 30-Day Speed (q/min) Trend (SVG)   │
├───────────────────────────────────┴────────────────────────────────────┤
│ Category Drilldown: [Select Category ▼] (Last 10 Entries)               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Key Product Decisions & Trade-Offs

### ADR-005: Database-Authoritative Streak & To-Do Evaluation
- **Chosen Approach**: Calling PostgreSQL RPCs `streak_for(p_student)` and `todo_for(p_student)`.
- **Why**: Streaks and task completion depend on consecutive calendar dates and specific rule definitions. Calculating streaks in client JavaScript creates clock drift, timezone loopholes (students shifting device clocks backwards to preserve broken streaks), and duplicate business logic. PostgreSQL executes timezone conversions in `Asia/Kolkata` authoritatively.
- **Alternatives Considered**: Calculating streaks client-side from raw result history. Rejected because local clocks cannot be trusted and fetching years of historical logs wastes client bandwidth.

### ADR-006: Handcrafted Inline SVG Charts over External Chart Libraries
- **Chosen Approach**: Rendering responsive `<svg viewBox="0 0 W H">` polylines, area fills, grid lines, and interactive hover dots with vanilla DOM nodes.
- **Why**: Zero external dependencies (Chart.js, Recharts, or D3 add 100KB–300KB and future maintenance burdens). Inline SVG allows precise styling matching CSS design tokens, renders instantly without canvas blur on Retina/high-DPI screens, and embeds accessible SVG `<title>` and keyboard/tap inspection natively.
- **Alternatives Considered**: Installing Chart.js or ApexCharts. Rejected per user prompt constraints ("Do not add any framework, chart library or other dependency").

### ADR-007: Isolation of Demo Fallback in `js/demoDb.js`
- **Chosen Approach**: Consolidating all mock data and local fallback responses into a single dedicated file (`js/demoDb.js`), gated strictly by `!isSupabaseConfigured()`.
- **Why**: Allows instant deletion before production deployment without risking orphaned mock branches inside production modules.

---

## 4. Technical Architecture & Implementation Plan

### System Flow Diagram
```
                     ┌──────────────────────────────┐
                     │     pages/student.html       │
                     └──────────────┬───────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           ▼                        ▼                        ▼
  ┌──────────────────┐    ┌──────────────────┐     ┌──────────────────┐
  │ js/student.js    │    │ js/stats.js      │     │ js/scoreColors.js│
  │ UI Coordinator   │    │ Pure Math & Aggr │     │ Score Badges     │
  └────────┬─────────┘    └──────────────────┘     └──────────────────┘
           │ (Promise.all)
           ├────────────────────────┬────────────────────────┐
           ▼                        ▼                        ▼
  ┌──────────────────┐    ┌──────────────────┐     ┌──────────────────┐
  │ RPC streak_for   │    │ RPC todo_for     │     │ RPC today_ist    │
  │ Current/Best/    │    │ Daily task status│     │ IST Date String  │
  │ Shields/Active   │    │ & direct links   │     │ (Asia/Kolkata)   │
  └──────────────────┘    └──────────────────┘     └──────────────────┘
           │
           ▼
  ┌──────────────────┐
  │ 90-Day Results   │ ──► [Calculates: 30d Accuracy, 30d Speed,
  │ + Categories Join│      Basics 7d Rollup, Sheet 5-Round Grid]
  └──────────────────┘
```

### File Changes & Structure

1. **New Pure Logic Module**:
   - `js/stats.js`: Pure mathematical functions (no DOM code) for:
     - `calculateAccuracyTrend(results, days = 30)`: Group by IST date, return daily accuracy percentage (`total > 0`).
     - `calculateSpeedTrend(results, days = 30)`: Group by IST date, calculate questions/minute (`total > 0`, `time_seconds > 0`).
     - `calculateCategoryHistory(results, categoryId, limit = 10)`: Last N entries for a specific category.
     - `calculateBasicsWeeklySummary(results, categories)`: Last 7 days breakdown for basics drills.
     - `buildRoundScoreMatrix(results, categories, roundOffset = 0, batchSize = 5)`: 2D matrix for round sheet table with summary rows (Time, Score, Attempts, Corrections).

2. **Refactored & Extended Student Dashboard**:
   - `pages/student.html`: Updated HTML shell with skeleton loading states, metric cards grid, full-width sheet table container, SVG chart containers, and resource sections.
   - `js/student.js`: Main controller loading data via `Promise.all`:
     - Checks user session; handles optional `studentId` URL query (only permitted if caller is admin).
     - Renders Streak card with milestone indicators (7, 25, 50, 100 days) and shield status.
     - Renders Today's To-Do list with deep links (`/pages/round-scores.html` or `/pages/basics.html?cat=...`).
     - Renders interactive SVG line charts with tooltips and tap inspection.
     - Renders 5-round score sheet with pagination controls and category stickiness.
     - Renders Basics this week card and Learning Resources list.

3. **Admin Daily To-Do Management**:
   - `pages/todos.html`: Clean HTML management view with task table and creation modal.
   - `js/todos.js`: Logic to fetch tasks from `todos`, add new tasks with dynamic category filtering by section, reorder sort orders, and toggle active state.

4. **Admin Learning Resources Management**:
   - `pages/resources.html`: Management view for curriculum links and study PDFs.
   - `js/resources.js`: CRUD logic, sorting, topic grouping, and URL validation (`http://` or `https://`).

5. **Demo Fallback Isolation**:
   - `js/demoDb.js`: Dedicated file containing fixed sample mocks for `streak_for`, `todo_for`, `today_ist()`, and `resources`.

6. **Shared Styling & Admin Nav**:
   - `css/style.css`: Add styles for SVG chart containers, tooltip overlays, sticky sheet tables, to-do checklists, and milestone badges.
   - Update admin navigation across `pages/admin.html`, `pages/categories.html`, and `pages/rounds.html` to include *Daily To-Do* and *Resources*.

7. **Documentation Updates**:
   - `docs/HANDOVER.md`: Prepend Phase 3 session summary.
   - `docs/DECISIONS.md`: Record ADR-005, ADR-006, and ADR-007.
   - `docs/DATA.md`: Document RPC signatures (`streak_for`, `todo_for`, `today_ist`) and `resources` table.
   - `docs/THREAT.md`: Record junk entries threat, unverified score editing, and third-party resource link threats.
   - `docs/TESTING.md`: Step-by-step verification checklist for all student and admin views.

---

## 5. Verification Plan

### Automated Build & Lint Check
- Run `npm run build` to confirm Vite compiles all HTML entries and static assets.
- Run `npm run lint` (`tsc --noEmit`) to verify clean TypeScript/JS syntax without missing imports or type errors.

### Functional Browser & End-to-End Scenarios
1. **Student Dashboard Flow**:
   - Log in as student (`STU101` / `student123`).
   - Verify IST date header, streak counter, shields, and today's to-do items.
   - Click a round to-do item -> verify navigation to `/pages/round-scores.html`.
   - Click a basics to-do item -> verify navigation to `/pages/basics.html` with category selected.
   - Inspect 5-round sheet table: verify sticky category column, cell color coding (`js/scoreColors.js`), and 4 summary rows.
   - Click `< Older` and `Newer >` pagination -> verify 5-round shift with descriptive range label.
   - Inspect SVG charts: test hover/tap tooltips on data points, check accessibility fallback text.
2. **Admin Daily To-Do Management**:
   - Log in as admin (`ADMIN01` / `admin123`).
   - Navigate to `/pages/todos.html`.
   - Add a task for section "round" -> verify category dropdown populates only round categories.
   - Add a task for section "basics" -> verify category dropdown populates only basics categories.
   - Reorder tasks and toggle active/inactive -> verify changes persist.
3. **Admin Resources Management**:
   - Navigate to `/pages/resources.html`.
   - Add a resource with an invalid URL (e.g. `javascript:alert(1)`) -> verify validation error.
   - Add a valid resource with `https://...` -> verify it appears grouped by topic on `/pages/student.html`.
4. **Security & Role Constraints**:
   - As a student, attempt to load `/pages/student.html?studentId=usr-102` -> verify parameter is ignored and only logged-in student's data is displayed.
   - As an admin, load `/pages/student.html?studentId=usr-102` -> verify viewing student 102's dashboard.
