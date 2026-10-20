# Trendz Tracker — Phase 9b-1: Memoriad-Style Competition Practice (Mental Calendar Dates & Mental Additions)

Builds the shared desktop competition practice environment and the first two competition modules (**Mental Calendar Dates** and **Mental Additions**, with **Mental Multiplications** and **Mental Square Roots** shown as `"Coming soon"`), backed by server-side generation and scoring (`api/_memoriad.js`, `/api/memoriad.js`), five pure client logic modules with unit tests, a shared dashboard summary card, Daily To-Do integration (`section = 'memoriad'`), and full documentation updates.

---

## 1. Dependencies & Stack

- **New Dependencies**: **None** (`package.json` is unchanged).
- **Stack**: Plain HTML, CSS, vanilla ES6 JavaScript, Node `crypto.randomInt`, `BigInt`, Supabase (`@supabase/supabase-js` already installed), Vercel serverless functions, and `node --test`.
- **Reused Modules**:
  - `api/_supabaseAdmin.js` (`verifyStudentCaller`, `getAdminClient`)
  - `js/scoreColors.js` (`getScoreFeedback`)
  - `js/competitionKeys.js` (`keyAction`, extended with `'unstep'` for `'/'` and `NumpadDivide`)
  - `js/guard.js` (`requireAuth`)

---

## 2. Explicit Assumptions

1. **Additions Left-to-Right Column Highlight Progression**: When `typing_direction === 'ltr'` on the Mental Additions stage, `highlightedColumns` starts at the leftmost column (`index 0`, or `[0, 1]` when highlighting 2 columns) and advances rightward by `stepCols` (`1` or `2`) each time `typedCount` crosses a step boundary; once past the rightmost column (`index 9`), the rightmost column(s) (`[9]` or `[8, 9]`) stay highlighted. Documented in `docs/DECISIONS.md` and `js/columnHighlight.js`.
2. **Calendar Weekday Convention (`0 = Monday ... 6 = Sunday`)**: Both `api/_memoriad.js` and `js/calendarKeys.js` / `js/memoriadFormat.js` use canonical weekday indices `0 = Monday, 1 = Tuesday, 2 = Wednesday, 3 = Thursday, 4 = Friday, 5 = Saturday, 6 = Sunday`. Key `0..7` maps via `(keyZeroDayIndex + keyNum) % 7` so key `7` always resolves to the same weekday as key `0`.
3. **Calendar Best Score Grouping**: On `/pages/memoriad.html` and in `js/memoriadStats.js`, Calendar results are grouped by `settings.dates` (`25, 50, 75, 100, 125`, defaulting to `125` if omitted), picking the best attempt per date-count tier (highest `correct`, then higher accuracy `correct / total`, then shorter `time_seconds`) as well as exposing the overall top Calendar best for compact card display.
4. **Additions Answer Slot Cursor & Backspace Semantics**:
   - There are `11` digit slots (indices `0..10`, left to right) because the sum of ten 10-digit numbers has at most 11 digits.
   - In **right-to-left (`rtl`)** mode: cursor starts at index `10` (rightmost). Typing a digit writes into the current cursor slot and moves the cursor 1 slot left (`Math.max(0, cursor - 1)`). `Backspace` clears the previously typed slot (to the right of the cursor, `cursor + 1`, and moves the cursor there; or if at the starting edge / current slot has a digit at boundary, clears appropriately so consecutive Backspaces undo typed digits in reverse order).
   - In **left-to-right (`ltr`)** mode: cursor starts at index `0` (leftmost). Typing a digit writes into the current cursor slot and moves the cursor 1 slot right (`Math.min(10, cursor + 1)`). `Backspace` clears the slot to the left (`cursor - 1`) and moves the cursor left.
   - `compact(state)` closes blank gaps between typed digits (packing all non-blank digits to the right edge `..10` in `rtl` mode, or to the left edge `0..` in `ltr` mode).
5. **Original Visual Design & Viewport Guard**: No Memoriad logos, artwork, fonts, or colour schemes are used. All screens use Trendz design tokens (`--color-primary`, `--bg-surface`, `--text-main`, tabular numerals, high-contrast borders). On `/pages/memoriad-play.html`, if viewport width is `< 1000px`, a friendly notice (`"Use a laptop or desktop with a keyboard for this practice"`) with a link back to `/pages/memoriad.html` is displayed instead of the competition stage.

---

## 3. Architectural Alternatives Considered

1. **Where to Store Competition Practice Results (`activity_results` with `activity_type = 'memoriad'` vs `results` Round Categories)**:
   - *Chosen*: Save competition practice sets in `public.activity_results` with `activity_type = 'memoriad'`, `correct = number correct`, `total = number attempted`, `time_seconds = Math.round(used_seconds)`, and structured `settings` JSON (`{ module, questions, attempted, correct, score, used_seconds, concentration_seconds, dates }`).
   - *Alternative Rejected*: Writing into `public.results` under competition round categories. `results` represents the 24-category teacher-tracked round score sheet (`student_rounds`) and speed basics (`basics`), where `total` is fixed per sheet and teacher verification workflows apply. Keeping self-paced competition simulator runs in `activity_results` preserves round score sheet integrity while still feeding `streak_for`, `todo_for` (`section = 'memoriad'`), and practice-day tracking.
2. **Server-Authoritative Generation, Timing & Scoring (`/api/memoriad.js` + `api/_memoriad.js`) vs Browser Generation**:
   - *Chosen*: Generate all questions and canonical expected answers on the server (`crypto.randomInt` and `BigInt`), persist expected answers only in `public.drill_sessions` via the service role, strip expected answers from the `'start'` response, and compute `used_seconds`, plausibility checks, and scores exclusively on `'submit'`.
   - *Alternative Rejected*: Generating dates/numbers or scoring in client JavaScript. Client-side generation/scoring would allow inspecting expected answers in DevTools or forging elapsed times and scores.
3. **Pure State Machines (`js/answerSlots.js`, `js/columnHighlight.js`, `js/calendarKeys.js`, `js/memoriadFormat.js`, `js/memoriadStats.js`) vs Inline DOM Logic**:
   - *Chosen*: Extract all slot-cursor manipulations, column-step calculations, weekday key mappings, date/day formatting, and personal-best statistics into pure, DOM-free ES modules with dedicated `node --test` suites.
   - *Alternative Rejected*: Embedding cursor and key-mapping arithmetic inside DOM event listeners in `js/memoriadPlay.js`, which would be brittle and impossible to unit-test without a browser DOM.

---

## 4. Detailed File-by-File Plan

### A. Server Modules & API

1. **`api/_memoriad.js` (NEW — pure functions, injectable `rng`, unit-tested)**
   - **Named Constants**:
     - `CALENDAR_ALLOWED_DATES = [25, 50, 75, 100, 125]`
     - `CALENDAR_DEFAULT_DATES = 125`
     - `CALENDAR_YEAR_MIN = 1600`, `CALENDAR_YEAR_MAX = 2099`
     - `ADDITIONS_QUESTION_COUNT = 10`, `ADDITIONS_NUMBERS_PER_QUESTION = 10`, `ADDITIONS_DIGITS_PER_NUMBER = 10`
     - `MIN_CONCENTRATION_SECONDS = 0`, `MAX_CONCENTRATION_SECONDS = 120`, `DEFAULT_CONCENTRATION_SECONDS = 5`
     - `PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT = { calendar: 0.25, additions: 3 }`
     - `MEMORIAD_SESSION_EXPIRY_SECONDS = 3 * 3600` (3 hours)
     - `WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']`
   - **Default RNG**: `defaultRng(minInclusive, maxInclusive)` using `crypto.randomInt(minInclusive, maxInclusive + 1)`.
   - **Gregorian Calendar Helpers**:
     - `isLeapYear(year)`: divisible by 4, except centuries not divisible by 400 (`1600` and `2000` are leap years; `1700, 1800, 1900` are not).
     - `daysInMonth(year, month)`: `1..12` accurate day count.
     - `isValidGregorianDate(year, month, day)`: validates `1600 <= year <= 2099`, valid month, valid day.
     - `weekdayIndex(year, month, day)`: pure Gregorian calculation (Sakamoto / Zeller / UTC Date math) returning `0 = Monday .. 6 = Sunday`. Verified against `2000-01-01 -> 5 (Saturday)`, `1969-07-20 -> 6 (Sunday)`, `1600-01-01 -> 5 (Saturday)`.
   - **`MODULES` Registry**:
     - `calendar`:
       - `title: 'Mental Calendar Dates'`, `defaultQuestions: 125`, `minSecondsPerAttempt: 0.25`
       - `generate(rng, settings)`: validates `settings.dates` (`25, 50, 75, 100, 125`, default `125`). Picks `dates` **distinct** valid `[year, month, day]` triples uniformly (year `1600..2099`, month `1..12`, day `1..daysInMonth(year, month)`). Returns `{ questions: [[y, m, d], ...], expected: [weekdayIdx, ...] }`.
       - `evaluate(session, answers)`: `answers` has one entry per question (`0..6` integer or numeric string or `null`). `attempted` = count of non-null valid day answers; `correct` = count matching `expected[i]`; `score = correct`. Builds `detail: [{ index, expected_display, given_display, correct, attempted }]`.
     - `additions`:
       - `title: 'Mental Additions'`, `defaultQuestions: 10`, `minSecondsPerAttempt: 3`
       - `generate(rng, settings)`: generates 10 questions; each question is an array of 10 strings of 10 digits (first digit `1..9`, remaining 9 digits `0..9`). `expected[i]` is the exact sum computed via `BigInt` as a decimal string. Returns `{ questions: [[numStr1, ... numStr10], ...], expected: [sumStr, ...] }`.
       - `evaluate(session, answers)`: each answer is trimmed; blank or `null` means `attempted = false`. Non-blank digit strings are normalised by stripping leading zeros (`'000'` $\to$ `'0'`) and compared numerically (`BigInt`) against `expected[i]`. Returns `{ score: correct, correct, attempted, questions_total: 10, detail: [{ index, expected_display, given_display, correct, attempted }] }`.
   - **Plausibility Helper**:
     - `checkMemoriadPlausibility(moduleKey, attempted, usedSeconds)`: rejects when `attempted > 0` and `usedSeconds < attempted * PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT[moduleKey]`.

2. **`api/memoriad.js` (NEW — Vercel Serverless Function)**
   - Uses `verifyStudentCaller(req)` and `getAdminClient()` from `./_supabaseAdmin.js`.
   - Enforces rate limit of `60` starts per hour per student on `drill_sessions` (`student_id = student.id`).
   - **`POST { action: 'start', module, settings }`**:
     - Validates `module` (`'calendar'` or `'additions'`), `concentration_seconds` (integer `0..120`, default `5`), and `dates` (`25, 50, 75, 100, 125` for `calendar`).
     - Calls `generateMemoriadSet(module, validatedSettings)`.
     - Inserts into `drill_sessions` (`activity_type: 'memoriad'`, `activity_name: moduleDef.title`, `settings: validatedSettings`, `questions`, `expected`, `min_seconds: 0`, `started_at`, `expires_at: now + 3 hours`, `status: 'open'`).
     - Returns `{ session_id, module, title, questions, settings: validatedSettings }` — **never** includes `expected`.
   - **`POST { action: 'submit', session_id, answers }`**:
     - Validates `session_id` and `answers` array (exact length matching `session.questions.length`, each entry a string $\le 20$ chars, a day integer `0..6` for calendar, or `null`).
     - Loads student's own session (`student_id = student.id`, `activity_type = 'memoriad'`), checks `status === 'open'` and not expired (`now <= expires_at`).
     - Computes `used_seconds = Math.max(0, (nowMs - startedAtMs) / 1000 - concentration_seconds)` and rounds to 2 decimals for display (`Number(used_seconds.toFixed(2))`).
     - Evaluates answers via `evaluateMemoriadSession(session, answers)`.
     - Checks plausibility (`used_seconds >= attempted * minSecondsPerAttempt`); if implausibly fast, returns `400` with a friendly message.
     - Atomically claims session (`UPDATE drill_sessions SET status = 'submitted', submitted_at = nowIso WHERE id = session.id AND status = 'open'`).
     - If `evaluation.attempted === 0`: saves no row in `activity_results` and returns `{ ...evaluation, used_seconds, saved: false, message: 'No questions were attempted, so no score was saved.' }`.
     - If `evaluation.attempted > 0`: inserts into `activity_results` with service role:
       - `student_id: student.id`
       - `activity_type: 'memoriad'`
       - `activity_name: moduleDef.title`
       - `correct: evaluation.correct`
       - `total: evaluation.attempted`
       - `time_seconds: Math.round(used_seconds)`
       - `settings: { module, questions: evaluation.questions_total, attempted: evaluation.attempted, correct: evaluation.correct, score: evaluation.score, used_seconds: Number(used_seconds.toFixed(2)), concentration_seconds, ...(module === 'calendar' ? { dates: session.settings.dates } : {}) }`
       - Updates `drill_sessions.result_id` with the inserted `activity_results.id` (reopening session if insert fails).
     - Never logs answers, expected values, or tokens.

3. **`server.ts` (MODIFY)**
   - Mount `app.all(['/api/memoriad', '/api/memoriad.js'], ...)` alongside `/api/drill` so local Vite/Express development routes `/api/memoriad` identically to Vercel.

---

### B. Shared & Pure Client Logic Modules (with Unit Tests)

1. **`js/competitionKeys.js` (MODIFY)**
   - Add `'unstep'` return value when `key === '/'` or `code === 'NumpadDivide'` (when no `Ctrl`, `Alt`, or `Meta` modifier is pressed).
   - Keep `'next'` (`+` / `NumpadAdd`), `'previous'` (`-` / `−` / `NumpadSubtract`), and `'step'` (`*` / `NumpadMultiply`) unchanged.

2. **`js/answerSlots.js` (NEW — pure state machine)**
   - Manages an array of `slotCount` (default `11`) character slots (`''` or `'0'..'9'`) and `cursor` index (`0 .. slotCount - 1`) with `direction` (`'rtl'` or `'ltr'`).
   - Functions:
     - `createAnswerSlots(slotCount = 11, direction = 'rtl', initialValue = '')`
     - `typeDigit(state, digit)`: accepts `'0'..'9'`, writes at `state.cursor`, advances cursor (`cursor - 1` for `'rtl'`, `cursor + 1` for `'ltr'`, clamped to `0 .. slotCount - 1`).
     - `moveCursorLeft(state)` / `moveCursorRight(state)`: moves cursor left/right within `0 .. slotCount - 1`.
     - `backspace(state)`: clears the previous slot relative to typing direction (`cursor + 1` in `'rtl'`, `cursor - 1` in `'ltr'`, handling edge boundaries cleanly) and moves cursor to that cleared slot.
     - `compact(state)`: closes blank gaps between typed digits — packs all non-empty digits flush right (`..slotCount - 1`) for `'rtl'`, or flush left (`0..`) for `'ltr'`.
     - `toAnswerString(state)`: joins all non-empty slots in left-to-right visual order into a digit string (or `''` if all slots are empty).

3. **`js/columnHighlight.js` (NEW — pure function)**
   - `highlightedColumns({ totalColumns = 10, direction = 'rtl', columnsPerStep = 1, typedCount = 0, manualStepOffset = 0 })`:
     - Computes active step `stepIndex = Math.max(0, Math.floor(typedCount / columnsPerStep) + manualStepOffset)`.
     - For `'rtl'`: starts at rightmost column(s) (`totalColumns - 1` for 1 col, `[totalColumns - 2, totalColumns - 1]` for 2 cols) and shifts left by `columnsPerStep` per step; beyond the leftmost column, clamps to the leftmost column(s) (`[0]` or `[0, 1]`).
     - For `'ltr'`: starts at leftmost column(s) (`[0]` or `[0, 1]`) and shifts right by `columnsPerStep` per step; beyond the rightmost column, clamps to the rightmost column(s) (`[totalColumns - 1]` or `[totalColumns - 2, totalColumns - 1]`).

4. **`js/calendarKeys.js` (NEW — pure function)**
   - `dayForKey(keyInput, keyZeroDayIndex = 5)`:
     - Accepts `'0'..'7'` (or integer `0..7`). Returns `(keyZeroDayIndex + k) % 7` where `0 = Monday .. 6 = Sunday`.
     - Returns `null` for any other key.
     - Default `keyZeroDayIndex = 5` (Saturday): `0 -> 5 (Saturday)`, `1 -> 6 (Sunday)`, `2 -> 0 (Monday)`, ..., `7 -> 5 (Saturday)`.
     - When `keyZeroDayIndex = 2` (Wednesday): `0 -> 2 (Wednesday)`, `1 -> 3 (Thursday)`, ..., `7 -> 2 (Wednesday)`.

5. **`js/memoriadFormat.js` (NEW — pure formatting helpers)**
   - `formatCalendarDate([year, month, day], format = 'DD-MM-YYYY')`: supports `'DD-MM-YYYY'`, `'MM-DD-YYYY'`, `'YYYY-MM-DD'` with zero-padded 2-digit day/month and 4-digit year.
   - `formatDayLabel(dayIndex, style = 'upper3')`:
     - `'upper3'`: `['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']`
     - `'short2'`: `['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']`
     - `'full'`: `['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']`
   - `getOrderedWeekdays(leftmostDayIndex = 0)`: returns array of 7 day indices starting at `leftmostDayIndex` (`(leftmostDayIndex + i) % 7`).

6. **`js/memoriadStats.js` (NEW — pure statistics helpers)**
   - Defines catalog metadata for the 4 modules (`calendar`, `additions`, `multiplications` [comingSoon], `square_roots` [comingSoon]).
   - `compareMemoriadAttempts(a, b)`: ranks by higher `correct`, then higher accuracy (`correct / total`), then shorter `time_seconds`.
   - `summarizeMemoriadModule(rows, moduleKey, todayIst)`:
     - Filters `activity_results` where `activity_type === 'memoriad'` and matches module (`settings.module === moduleKey` or `activity_name`).
     - Computes `bestOverall`, `bestByDates` (for `calendar`, keyed by `settings.dates`: `25, 50, 75, 100, 125`), `lastFive` (up to 5 most recent tries with IST date, `score`/`correct`, `attempted`/`total`, `time_seconds`, and `dates`), and `triesThisWeek` (last 7 days in `Asia/Kolkata`).
   - `summarizeAllMemoriad(rows, todayIst)`: aggregates `triesThisWeek` across all Memoriad modules plus per-module summaries for `/pages/memoriad.html` and the shared dashboard card.

---

### C. Pages, Shared Card, To-Do Integration & Demo Fixtures

1. **`/pages/memoriad.html` & `js/memoriad.js` (NEW)**
   - Logged-in guard (`requireAuth(['student', 'admin'])`).
   - Displays 4 module cards:
     - **Mental Calendar Dates** (`available`): shows best score (overall & per date count if present), last 5 tries table (Date in India time, Score, Attempted, Time), and **Start Practice** button linking to `/pages/memoriad-play.html?module=calendar`.
     - **Mental Additions** (`available`): shows best score, last 5 tries table, and **Start Practice** button linking to `/pages/memoriad-play.html?module=additions`.
     - **Mental Multiplications** (`Coming soon` badge, disabled button).
     - **Mental Square Roots** (`Coming soon` badge, disabled button).

2. **`/pages/memoriad-play.html` & `js/memoriadPlay.js` (NEW)**
   - Logged-in guard (`requireAuth(['student', 'admin'])`).
   - Viewport guard (`< 1000px`): shows friendly message `"Use a laptop or desktop with a keyboard for this practice"` with a link back to `/pages/memoriad.html`.
   - Four single-page states (`Settings` $\to$ `Concentration` $\to$ `Stage` $\to$ `Results`):
     - **Settings State**:
       - Persists per-module settings in `localStorage` inside `try/catch`.
       - **Calendar Settings**: Day abbreviation style (`MON-TUE-WED...`, `Mo-Tu-We...`, `Full names`), Leftmost day button (`Monday..Sunday`, default `Monday`), Key `0` day (`Monday..Sunday`, default `Saturday`), Highlight active question (`Yes`/`No`, default `Yes`), Question format (`DD-MM-YYYY`, `MM-DD-YYYY`, `YYYY-MM-DD`), Number of dates (`25, 50, 75, 100, 125`, default `125`), Timer shown (`Yes`/`No`, default `Yes`), Concentration time (`0..120` seconds, default `5`).
       - **Additions Settings**: Typing direction (`Right to left` default, or `Left to right`), Number of columns to highlight (`1` or `2`, default `1`), Timer shown (`Yes`/`No`, default `Yes`), Concentration time (`0..120` seconds, default `5`).
     - **Concentration State**:
       - Calls `POST /api/memoriad` (`action: 'start'`) and holds questions in JS memory (not rendered into the DOM until countdown reaches 0).
       - Hides top site navigation; shows Fullscreen toggle (`requestFullscreen`/`exitFullscreen` wrapped in `try/catch`) and Exit button (with confirmation that discards the attempt).
       - Large tabular countdown (`concentration_seconds` down to `0`) with short note `"Get ready — questions will appear automatically when the countdown finishes."`
     - **Stage State (1280×800 no-scroll competition layout)**:
       - Top bar with upward-counting stopwatch (`mm:ss`, hidden when `timer_shown` is `false` while still tracked), module title, Fullscreen button, Exit button (with confirmation), and prominent **FINISH** button.
       - **Calendar Stage**:
         - 3-column scrollable list of all dates (`1..N`) showing question number, formatted date, and chosen day label (or blank); active row has high-contrast background + thick border + indicator when highlight is enabled; clicking any item selects it.
         - Centre active-question panel displaying the active date in large tabular numerals, `BACK` (previous), `SKIP` (next without answering), and 7 day buttons in the chosen order and label style (with keyboard shortcut hint `0..6`).
         - Keyboard handling: `0..7` selects day via `dayForKey` and jumps to the next **unanswered** question (or stays/prompts if all answered); `Enter` skips to next question; `ArrowRight`/`ArrowDown` or `+` moves to next question (no wrap); `ArrowLeft`/`ArrowUp` or `-` moves to previous question (no wrap).
       - **Additions Stage**:
         - Left/top 5×2 grid of 10 question cards showing the 10 numbers in compact tabular form and the student's typed answer; active card has thick border + badge + tinted background (not colour alone); clicking a card selects it.
         - Right/main active question panel showing the 10 ten-digit numbers in large tabular numerals with the active column(s) highlighted (`js/columnHighlight.js`) and 11 interactive digit slots (`js/answerSlots.js`) below.
         - Keyboard handling: digits `0..9` fill slots via `typeDigit`; `ArrowLeft`/`ArrowRight` move slot cursor; `Backspace` clears previous slot; `*`/`NumpadMultiply` (`'step'`) manually advances column highlight step; `/`/`NumpadDivide` (`'unstep'`) moves column highlight back one step; `+`/`NumpadAdd` (`'next'`) moves to next question; `-`/`NumpadSubtract` (`'previous'`) moves to previous question; `Enter` compacts gaps via `compact(state)` and advances to next question — or on the last question when all 10 questions have an answer, prompts `"Finish?"` confirmation to submit.
     - **Results State**:
       - Restores normal page chrome; displays large **SCORE**, used time in seconds with 2 decimals, number correct, and number attempted.
       - Full per-question table: `#`, Question summary, Correct answer, Your answer (`"Not answered"` when blank), and status badge (`✓ Correct` or `✗ Wrong`, not colour alone).
       - Displays `"Saved to your scores"` (or `"No questions were attempted, so no score was saved"` when `attempted === 0`).
       - Buttons: **Try again** and **Back to Memoriad**.
       - Network error resilience: if `fetch('/api/memoriad')` fails due to network error, keeps answers in memory and shows a **"Try sending again"** button; if the server rejects with a 4xx message, shows the server's friendly message.

3. **`js/memoriadCard.js` (NEW — Shared Dashboard Card)**
   - Exports `renderMemoriadCard({ studentId, containerId, isReadOnly, todayIST, preloadedResults })`.
   - Displays tries this week (last 7 days in IST) and best score per available module (`Mental Calendar Dates`, `Mental Additions`), with a `"Practice Memoriad →"` link to `/pages/memoriad.html` for students and **no link** when `isReadOnly === true` (admin student detail view).
   - Added to `/pages/student.html` (`js/student.js`) and `/pages/student-detail.html` (`js/studentDetail.js`).

4. **Navigation, Vite Config, To-Do & Demo Updates**
   - **`vite.config.ts`**: Add `memoriad: resolve(__dirname, 'pages/memoriad.html')` and `memoriadPlay: resolve(__dirname, 'pages/memoriad-play.html')` to `build.rollupOptions.input`.
   - **Student Navigation Bar**: Add `<a href="/pages/memoriad.html" class="nav-link">Memoriad</a>` to student nav across `pages/student.html`, `pages/round-scores.html`, `pages/basics.html`, `pages/basics-practice.html`, `pages/flash.html`, `pages/elements.html`, `pages/element-drill.html`, `pages/leaderboard.html`, `pages/monthly-report.html`, `pages/report.html`, plus a quick-action button on `pages/student.html`.
   - **Admin Daily To-Do (`pages/todos.html`, `js/todos.js`, `js/dashboardComponents.js`)**:
     - Add `<option value="memoriad">Memoriad (Competition Practice)</option>` in `pages/todos.html`.
     - Add `{ key: 'memoriad', label: '🧠 Memoriad Practice' }` in `js/todos.js` (when `memoriad` is selected, category filter shows `"Any category in this section"`).
     - In `js/dashboardComponents.js` (`renderTodoList`), include `'memoriad'` in `sectionOrder` / `sectionTitles` and route `t.task_section === 'memoriad'` to `/pages/memoriad.html`.
   - **Demo Mode (`js/demoDb.js`)**:
     - Add fixed demo fixtures `mockMemoriadStart(moduleKey, settings)` (one fixed Calendar date set and one fixed Additions set) and `mockMemoriadSubmit(sessionId, moduleKey, answers, studentId, settings)` returning a fixed fake evaluation and storing a sample `activity_type: 'memoriad'` row in demo storage (never generating or scoring in the browser). Seed 2 sample `memoriad` rows in initial demo `activity_results` so the Memoriad card and page immediately show sample history in Demo Mode.

---

### D. Unit Tests (`node --test`)

1. **`tests/competitionKeys.test.js` (MODIFY)**: Add tests for `'/'` and `NumpadDivide` returning `'unstep'`, and returning `null` with `Ctrl`/`Alt`/`Meta`.
2. **`tests/memoriadServer.test.js` (NEW)**:
   - Calendar generation: count (`25, 50, 75, 100, 125`), all dates distinct, all valid Gregorian dates in `1600..2099` (including leap day validation), weekday checks against known dates (`2000-01-01` = Saturday `5`, `1969-07-20` = Sunday `6`, `1600-01-01` = Saturday `5`).
   - Additions generation: 10 questions, 10 numbers per question, each 10 digits with first digit `1..9` (no leading zero), `expected` equals exact `BigInt` sum.
   - Evaluation: correct, wrong, blank (`null` / `''`) answers, leading zeros (`"000123"` matches `"123"`), plausibility rejection (`used_seconds < attempted * 3` for additions, `< attempted * 0.25` for calendar), and start payload stripping (`expected` never present).
3. **`tests/answerSlots.test.js` (NEW)**: `typeDigit`, `moveCursorLeft`, `moveCursorRight`, `backspace`, `compact`, `toAnswerString` in both `'rtl'` and `'ltr'` directions.
4. **`tests/columnHighlight.test.js` (NEW)**: `highlightedColumns` for both `'rtl'` and `'ltr'` directions, `1` and `2` columns per step, and clamping after the last column.
5. **`tests/calendarKeys.test.js` (NEW)**: `dayForKey` for default Saturday (`0 -> Sat, 1 -> Sun, 2 -> Mon, ..., 7 -> Sat`), custom Wednesday (`0 -> Wed, 1 -> Thu, 2 -> Fri, 3 -> Sat, 4 -> Sun, 5 -> Mon, 6 -> Tue, 7 -> Wed`), and non-matching keys returning `null`.
6. **`tests/memoriadFormat.test.js` (NEW)**: `formatCalendarDate` (`DD-MM-YYYY`, `MM-DD-YYYY`, `YYYY-MM-DD`), `formatDayLabel` (`MON-TUE-WED...`, `Mo-Tu-We...`, full names), and `getOrderedWeekdays`.
7. **`tests/memoriadStats.test.js` (NEW)**: best per module (highest `correct`, then higher accuracy, then shorter time), Calendar grouping by `dates`, tries this week in India time (`Asia/Kolkata`), and empty data handling.

---

### E. Documentation Updates (`/docs`)

- **`docs/HANDOVER.md`**: Add Phase 9b-1 5-line session summary, file inventory, and assumptions.
- **`docs/DECISIONS.md`**: Add ADR-035 explaining why Memoriad modules are separate from round categories and stored as `activity_type = 'memoriad'`, why generation and scoring happen exclusively on the server, why the original Memoriad visual look is not copied, and the `ltr` column highlight assumption.
- **`docs/DATA.md`**: Document `activity_type = 'memoriad'` in `drill_sessions` and `activity_results` (`correct` = correct answers, `total` = attempted, `settings` schema) and `section = 'memoriad'` in `todos` / `todo_for`.
- **`docs/THREAT.md`**: Record that a student could use an external script or calculator during practice, that the server rejects implausibly fast submissions (`< 0.25s/attempt` for Calendar, `< 3s/attempt` for Additions), and that results are practice data.
- **`docs/TESTING.md`**: Add step-by-step verification guides for `/pages/memoriad.html`, `/pages/memoriad-play.html?module=calendar`, `/pages/memoriad-play.html?module=additions`, keyboard shortcuts, viewport guard, Daily To-Do integration, and `node --test`.
