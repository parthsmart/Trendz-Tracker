# Phase 16b — Online Weekly Test Runners for Elements, Flash Anzan & Memoriad

Online weekly test sections of kind **Elements**, **Flash Anzan**, and **Memoriad** become playable directly on the website alongside **Basics**, reusing the existing worksheet, Flash Anzan, and Memoriad stage pages in a dedicated locked test mode (`?test=<id>&section=<id>`) backed by `/api/weekly-test` and storing scores exclusively in `weekly_test_scores`.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Session Scope Decision: Full Phase 16b vs. Two-Part Split**
> - **Recommended Default (Option A — Complete Phase 16b in One Session)**: Implement all four online section kinds (`basics`, `elements`, `flash`, and `memoriad`), the unified `/api/weekly-test` endpoint, the pure helpers and unit tests, the student Weekly Test "Start" / "Continue" flow, and the Admin Flash reset support in a single cohesive pass. Because `api/_drills.js` and `api/_memoriad.js` already expose pure generators and graders, all three runners can be wired cleanly in one session without leaving Memoriad disabled.
> - **Alternative (Option B — Elements & Flash First, Memoriad Next)**: Implement the `/api/weekly-test` switch to `section_id` plus the **Elements** and **Flash Anzan** test runners first, leaving Memoriad sections on `"Available soon"` for a follow-up session. Let me know if you prefer Option B.

> [!NOTE]
> **Zero New Dependencies & Strict Database Boundaries**
> - **New Dependencies**: **None** (`0` packages added). Built strictly with plain HTML, CSS, and vanilla ES2022 JavaScript modules.
> - **Isolated Test Storage**: Online weekly test submissions write **only** to `weekly_test_scores` and `weekly_test_attempts` (plus `drill_sessions` with `settings.kind = 'weekly_test'`). They **never** write to `activity_results` or `results`, ensuring weekly tests never tick daily tasks or count toward practice streaks.
> - **Authoritative Eligibility & Generation**: Eligibility is checked exclusively via the service-role RPC `weekly_test_check_section(p_test, p_student, p_section)`, and Flash Anzan test numbers are generated exclusively via the service-role RPC `flash_generate_question(p_digits, p_count, p_mode)`.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Unified Section-Based Weekly Test API (`/api/weekly-test`)**: Switches `start` and `submit` actions to `section_id`, enforces a 60-starts-per-hour rate limit per student, delegates eligibility to `weekly_test_check_section`, and handles server-authoritative generation and grading for `basics`, `elements`, `memoriad`, and multi-try `flash` sections without ever returning expected answers on `start` or logging student answers/tokens.
  2. **Test Mode in Existing Runners (`?test=<id>&section=<id>`)**: Reuses the Elements worksheet page, the Flash Anzan page, and the Memoriad stage page (plus Basics) in a distraction-free test mode: hides the site header/navigation and setup screens, uses server-fixed settings, guards against accidental exits (`beforeunload` + Exit confirmation), supports network-error retries (`"Try sending again"`) until session expiry, and finishes with `"Saved as part of <test title>"` and a `"Back to Weekly Test"` button.
  3. **Multi-Try Flash Anzan Test Sections**: Supports `1–10` tries (`question_count`) with live progress (`"Try 2 of 5"`), records each try immediately into `weekly_test_scores` (`correct = tries_correct, total = question_count`) so started/unanswered tries count as wrong, withholds per-try correctness (`"Answer recorded"` + `"Next try"`), reveals `"n of m correct"` after the final try, and allows resuming remaining tries if the student reloads or returns via `"Continue"`.
  4. **Student & Admin Weekly Test Updates**: Replaces `"Available soon"` on the student Weekly Test page with active `"Start"` buttons (and `"Continue"` for in-progress Flash sections with tries remaining), updates the confirmation modal text, and ensures Admin `"Reset"` cleanly clears both `weekly_test_attempts` and `weekly_test_scores` for Flash and all other section kinds.
- **Target Audience**: Students taking timed online weekly tests across all mental-math disciplines and trainers monitoring/resetting attempts.
- **Key Value**: Completes the end-to-end online weekly test lifecycle across every discipline while reusing proven worksheet and stage interfaces.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Student Weekly Test Page (`My Tests` Tab)**:
   - Open, unattempted sections of kind `basics`, `elements`, `flash`, and `memoriad` display an active **Start** button.
   - A `flash` section with `attempt === 'started'` and `tries_started < question_count` displays a **Continue** button (and status chip showing progress, e.g. `"In progress: 2 of 5 tries"`), allowing the student to finish their remaining tries.
   - Completed sections show `"Done: 18 of 20"` with the shared score colour (`js/scoreColors.js`). Abandoned non-Flash sections (or closed tests) show `"Missed"`.
   - Clicking **Start** (or **Continue**) opens the confirmation modal with the exact warning:
     > *"You can take this section only once. If you leave the page, the section ends."*
   - Confirming navigates to the corresponding runner in test mode (`?test=<test_id>&section=<section_id>`) or starts the inline Basics player.

2. **Common Test Mode Rules Across All Runners (`?test=<id>&section=<id>`)**:
   - **No Site Header or Setup Screen**: The top navigation bar and setup/configuration controls are hidden; the runner immediately calls `POST /api/weekly-test { action: 'start', test_id, section_id }` using only the server-returned settings.
   - **Exit & Tab-Close Protection**:
     - An **Exit** button is shown in the runner top bar; clicking it prompts: *"This section can be taken only once. Leaving now ends it."* before returning to `/pages/weekly-test.html`.
     - While a section is in progress, `beforeunload` warns the student before closing or reloading the tab.
   - **Network Retry**: If `submit` fails due to a network or 5xx error, answers remain in memory and a retry banner offers **"Try sending again"** until the session's `expires_at` timestamp.
   - **Test Result Screen**: Shows `"Saved as part of <test title>"` and a primary **"Back to Weekly Test"** button (plus **"Next section"** when another startable section remains).

3. **Elements Runner in Test Mode**:
   - Displays the test title, drill title, answer hint, countdown timer, and all worksheet questions.
   - Auto-submits when the countdown reaches `00:00` or when the student clicks **Submit now**.
   - Grades via `/api/weekly-test { action: 'submit', session_id, answers }` and displays the score, shared score colour (`wrong = attempted - correct`), question review, `"Saved as part of <test title>"`, and **"Back to Weekly Test"**.

4. **Memoriad Runner in Test Mode**:
   - On screens narrower than `1000 px`, displays the desktop-keyboard required message and a **"Back to Weekly Test"** button **before** calling `start` (so the student's attempt is not consumed on a phone).
   - Uses fixed competition settings from the server (`Calendar`: 125 dates; typing direction right-to-left; additions highlight columns 1; concentration time 5 s; timer shown).
   - Runs the 5-second Concentration countdown, followed by the full-viewport Stage, and submits on **Finish** or when time expires.
   - Displays the evaluation breakdown, `"Saved as part of <test title>"`, and **"Back to Weekly Test"**.

5. **Flash Anzan Runner in Test Mode**:
   - Displays the test title, `"Try <try_no> of <question_count>"`, and the locked section settings summary.
   - Runs the 3-2-1 countdown, flashes the server-generated numbers (`buildTimeline`), and shows the numeric answer input (`Submit` or `I don't know`).
   - **Per-Try Privacy**: After submitting a try before the last one, shows **"Answer recorded"** (never revealing whether the try was right or wrong, nor the expected sum) and a **"Next try"** button that requests the next try from `/api/weekly-test { action: 'start', test_id, section_id }`.
   - **Final Summary**: After the final try (`try_no === question_count`), displays **`"<tries_correct> of <question_count> correct"`**, total time used, shared score colour feedback, `"Saved as part of <test title>"`, and **"Back to Weekly Test"**.
   - **Reload / Resume Behavior**: Because `tries_started` is incremented on `start` and `weekly_test_scores` is updated on every try, reloading mid-try forfeits that single try as wrong while allowing the student to continue any remaining tries (`tries_started < question_count`).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dedicated Pure Helper Modules (`api/_weeklyTest.js` & `js/weeklyTestRunner.js`)**
  - *Chosen Approach*: Extract all pure state transitions, score mapping, and URL/progress formatting into `api/_weeklyTest.js` (`applyFlashTry`, `finalScore`, `isWeeklyTestSession`, `buildMemoriadFixedSettings`) and `js/weeklyTestRunner.js` (`runnerLink`, `flashProgressText`, `parseTestRunnerQuery`), each covered by `node --test` unit tests.
  - *Why*: Keeps `/api/weekly-test.js` and the browser runner controllers clean, deterministic, and testable without mocking DOM or network calls.
  - *Alternatives Considered*: Embedding Flash try counters and score conversion directly inside `/api/weekly-test.js` — rejected because pure functions make edge cases (e.g. `tries_started` cap at `question_count`, `attempted === 0`, Memoriad `questions_total` vs Elements `attempted`) verifiable in isolation.

- **Decision 2: Immediate Score Upsert on Every Flash Try**
  - *Chosen Approach*: When a Flash section starts for the first time, insert `weekly_test_attempts` (`tries_started: 0, tries_correct: 0, seconds_used: 0, status: 'started'`) and upsert `weekly_test_scores` (`correct: 0, total: question_count, time_seconds: 0, source: 'online', section_id`). Each `start` call atomically increments `tries_started` (up to `question_count`), and each `submit` updates `tries_correct`, `seconds_used`, and `weekly_test_scores` (`correct = tries_correct, total = question_count, time_seconds = seconds_used`), setting `attempt.status = 'submitted'` when `tries_started === question_count`.
  - *Why*: Guarantees that even if a student closes the browser after starting some tries, their recorded score in `weekly_test_scores` accurately reflects `tries_correct` out of `question_count` (unanswered started tries count as wrong).
  - *Alternatives Considered*: Waiting until the last try to insert `weekly_test_scores` — rejected because abandoning midway would leave no score row despite completed tries.

- **Decision 3: Pre-Flight Desktop Viewport Check for Memoriad Test Sections**
  - *Chosen Approach*: Check viewport width (`>= 1000 px`) on the client **before** sending `POST /api/weekly-test { action: 'start' }` for a Memoriad test section.
  - *Why*: Calling `start` creates the single-attempt `weekly_test_attempts` row on the server. Checking the viewport before calling `start` ensures a student opening a Memoriad section on a mobile phone sees the friendly desktop-required notice without losing their attempt.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Pure Weekly Test Modules (Unit Tested)                   │
│                                                                              │
│  ┌────────────────────────────────────┐  ┌────────────────────────────────┐  │
│  │         api/_weeklyTest.js         │  │     js/weeklyTestRunner.js     │  │
│  │ - applyFlashTry(att, sec, ok, s)   │  │ - runnerLink(section, testId)  │  │
│  │ - finalScore(kind, evaluation)     │  │ - flashProgressText(s, total)  │  │
│  │ - isWeeklyTestSession(session)     │  │ - parseTestRunnerQuery(search) │  │
│  │ - getMemoriadTestFixedSettings(m)  │  └───────────────┬────────────────┘  │
│  └─────────────────┬──────────────────┘                  │                   │
└────────────────────┼─────────────────────────────────────┼───────────────────┘
                     │                                     │
                     ▼                                     ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────────┐
│     Serverless API: /api/weekly-test  │  │   Browser Runners in Test Mode    │
│                                       │  │     (?test=<id>&section=<id>)     │
│  POST { action: 'start',              │  │                                   │
│         test_id, section_id }         │◄─┼─ 1. Basics (weeklyTest.js /       │
│  - verifyStudentCaller(req)           │  │     basicsPractice.js)            │
│  - 60 starts/hr rate limit            │  │  2. Elements (elementDrill.js)    │
│  - RPC weekly_test_check_section      │  │  3. Flash Anzan (flash.js)        │
│  - Branch by kind:                    │  │  4. Memoriad (memoriadPlay.js     │
│    • basics   -> generateBasicsSet    │  │     with >=1000px pre-check)      │
│    • elements -> DRILLS[key].generate │  │                                   │
│    • memoriad -> generateMemoriadSet  │  │  Common Test Mode UX:             │
│    • flash    -> RPC                  │  │  - Hide header & setup controls   │
│      flash_generate_question          │  │  - Exit confirm + beforeunload    │
│                                       │  │  - Network retry until expires_at │
│  POST { action: 'submit',             │  │  - "Saved as part of <title>" +   │
│         session_id, answers|answer }  │  │    "Back to Weekly Test"          │
│  - Verify open weekly_test session    │  └───────────────────────────────────┘
│  - Claim drill_sessions ('submitted') │
│  - Grade & write ONLY to              │
│    weekly_test_scores &               │
│    weekly_test_attempts               │
└───────────────────────────────────────┘
```

### Server & Client Specifications

1. **Serverless Endpoint (`/api/weekly-test.js` + `/api/_weeklyTest.js`)**:
   - **Rate Limit**: Counts `drill_sessions` started by `student.id` in the last 1 hour (`started_at >= now - 1h`); rejects with HTTP 429 if `>= 60`.
   - **`start` (`{ action: 'start', test_id, section_id }`)**:
     - Calls service-role RPC `weekly_test_check_section(p_test: testId, p_student: student.id, p_section: sectionId)` (with fallback compatibility if legacy `category_id` is passed). When `check.ok !== true`, returns HTTP 400 with `{ error: check.reason }`.
     - **`basics`**: Generates pool by `check.seconds` (`30->50, 60->100, 120->200, 300->500`), inserts `weekly_test_attempts` (`status: 'started', section_id, category_id`), inserts `drill_sessions` (`activity_type: 'basics'`, `settings: { kind: 'weekly_test', test_id, section_id, category_id, seconds, pool, title }`, `expires_at = now + seconds + 60s`), and returns `{ ok: true, session_id, kind: 'basics', title, category_name, seconds, questions }`.
     - **`elements`**: Looks up `DRILLS[check.activity_key]` (must be enabled); generates questions & expected answers; inserts `weekly_test_attempts` (`status: 'started', section_id`); inserts `drill_sessions` (`activity_type: 'element'`, `settings: { kind: 'weekly_test', test_id, section_id, drill: check.activity_key, title: check.title, time_limit_seconds }`, `expires_at = now + time_limit_seconds + 60s`); returns `{ ok: true, session_id, kind: 'elements', title: check.title, drill: check.activity_key, drill_title: drill.title, questions: questionTexts, time_limit_seconds: drill.time_limit_seconds, hint: drill.hint }`.
     - **`memoriad`**: Uses fixed competition settings (`calendar`: `{ dates: 125, concentration_seconds: 5, timer_shown: true, day_style: 'upper3', leftmost_day: 0, key_zero_day: 5, highlight_active: true, date_format: 'DD-MM-YYYY' }`; `additions`: `{ typing_direction: 'rtl', highlight_columns: 1, concentration_seconds: 5, timer_shown: true }`; `multiplications`: `{ typing_direction: 'rtl', question_format: 'stacked', concentration_seconds: 5, timer_shown: true }`; `square_roots`: `{ concentration_seconds: 5, timer_shown: true }`); generates via `generateMemoriadSet`; inserts `weekly_test_attempts` (`status: 'started', section_id`); inserts `drill_sessions` (`activity_type: 'memoriad'`, `settings: { kind: 'weekly_test', test_id, section_id, module: check.activity_key, title: check.title, ...fixedSettings }`, `expires_at = now + concentration_seconds + limit + 60s`); returns `{ ok: true, session_id, kind: 'memoriad', title: check.title, module: check.activity_key, module_title, questions, time_limit_seconds, settings: fixedSettings }`.
     - **`flash`**:
       - On first try (`!check.resume` and no existing attempt row): inserts `weekly_test_attempts` (`test_id, student_id, section_id, status: 'started', tries_started: 0, tries_correct: 0, seconds_used: 0`) and upserts `weekly_test_scores` (`test_id, student_id, section_id, correct: 0, total: check.question_count, time_seconds: 0, source: 'online'`).
       - Atomically increments `tries_started` on `weekly_test_attempts` (never above `check.question_count`; rejects if already at `question_count`).
       - Calls service-role RPC `flash_generate_question(p_digits: check.flash_digits, p_count: check.flash_count, p_mode: check.flash_mode)` to get the signed `numbers` array and computes the canonical sum on the server.
       - Computes `min_seconds = Math.max(1, Math.floor((check.flash_count * check.flash_speed_ms) / 1000 * 0.8))` and `expires_at = now + Math.ceil((check.flash_count * check.flash_speed_ms) / 1000) + 600s`.
       - Inserts `drill_sessions` (`activity_type: 'flash_anzan'`, `settings: { kind: 'weekly_test', test_id, section_id, title: check.title, try_no, question_count: check.question_count, digits: check.flash_digits, count: check.flash_count, speed_ms: check.flash_speed_ms, mode: check.flash_mode }`, `questions: [numbers]`, `expected: [expectedSum]`, `min_seconds`, `expires_at`).
       - Returns `{ ok: true, session_id, kind: 'flash', title: check.title, numbers, settings: { digits, count, speed_ms, mode }, try_no, question_count: check.question_count }`.
   - **`submit` (`{ action: 'submit', session_id, answers | answer }`)**:
     - Loads student's own open `drill_sessions` row where `settings.kind === 'weekly_test'`, verifies `now <= expires_at`, evaluates by `activity_type`, and atomically claims `drill_sessions` (`status = 'open' -> 'submitted'`).
     - **`basics`**: Same as Phase 16a (`checkTimedBasicsSubmission`; if `attempted === 0`, marks attempt `'submitted'` with no score row; if `attempted > 0`, upserts `weekly_test_scores` with `total = attempted` and marks attempt `'submitted'`).
     - **`element`**: Validates and grades with `gradeDrillSubmission` and checks `elapsed >= attempted * 0.25`. If `attempted === 0`, marks attempt `'submitted'` and saves no score row. If `attempted > 0`, upserts `weekly_test_scores` (`correct: graded.correct, total: graded.attempted, time_seconds: graded.seconds, source: 'online', section_id`) and marks attempt `'submitted'`.
     - **`memoriad`**: Computes `usedSeconds` with `computeMemoriadUsedSeconds` and grades with `evaluateMemoriadSubmission`. If `evaluation.attempted === 0`, marks attempt `'submitted'` and saves no score row. If `evaluation.attempted > 0`, upserts `weekly_test_scores` (`correct: evaluation.correct, total: evaluation.questions_total, time_seconds: Math.round(usedSeconds), source: 'online', section_id`) and marks attempt `'submitted'`.
     - **`flash_anzan`**: Checks `elapsed >= session.min_seconds`, compares `answer` (`number` or `null` for `"I don't know"`) to `expected[0]`, computes `trySeconds = Math.max(1, Math.round(elapsedSeconds))`, and applies `applyFlashTry(attemptRow, sectionSpec, isCorrect, trySeconds)`:
       - Increments `tries_correct` when `isCorrect` is true, adds `trySeconds` to `seconds_used`, and sets `status = 'submitted'` (and `finished_at = now`) when `tries_started >= question_count`.
       - Upserts `weekly_test_scores` (`correct: updated.tries_correct, total: question_count, time_seconds: updated.seconds_used, source: 'online', section_id`).
       - When `tries_started < question_count`, returns `{ ok: true, recorded: true, done: false, try_no, question_count }` (never returning `correct` or `expected`).
       - When `tries_started >= question_count`, returns `{ ok: true, recorded: true, done: true, try_no, question_count, tries_correct: updated.tries_correct, total: question_count, time_seconds: updated.seconds_used }`.
       - If any score/attempt DB update fails after claiming `drill_sessions`, re-opens the `drill_sessions` row so the student can retry submitting.
       - Also updates `js/demoDb.js` so Demo Mode on localhost/preview supports starting and submitting all 4 weekly test section kinds.
       - Also adds clean URL rewrites or query support so both `/pages/element-drill.html?test=<id>&section=<id>` (and alias `/pages/elements-worksheet.html`) and `/pages/memoriad-play.html?test=<id>&section=<id>` (and alias `/pages/memoriad-stage.html`) work seamlessly.
