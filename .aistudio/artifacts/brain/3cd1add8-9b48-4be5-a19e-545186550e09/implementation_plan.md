# Phase 9a: Online Basics Practice (One Question at a Time)

Enable students to practice supported Basics categories (`<N>d<R>r` add/subtract rows, `<A>dx<B>d` multiplication, and `<A>d/<B>d` exact division) online one question at a time with server-side question generation and grading, saving verified results directly into `results` with `source = 'site'`.

### User Review & Critical Decisions

> [!IMPORTANT]
> Please review the following architectural choices, generator rules, and security boundaries before implementation begins:

- **Category-Name-Driven Generators (`api/_drills.js`)**: Online availability is derived purely from the active `basics` category's `name` (case-insensitive, spaces ignored; `*`, `x`, `X`, `×` accepted for multiplication; `/`, `÷` accepted for division):
  - **`<N>d<R>r`** (`N` in `1..4`, `R` in `2..10`): `R` vertical rows of `N`-digit numbers (`1..9` for `1d`, `10..99` for `2d`, etc.). Row 1 is always positive; each subsequent row is subtracted with `40%` probability provided the running total never drops below `0`; adjacent rows never have the same unsigned number (retried up to `20` times).
  - **`<A>dx<B>d`** (`A, B` in `1..4`): `A`-digit factor times `B`-digit factor (`1d` factors use `2..9` to avoid trivial `× 1`).
  - **`<A>d/<B>d`** (`A, B` in `1..4`): Exact division of an `A`-digit dividend by a `B`-digit divisor (`1d` divisors use `2..9`). Picks divisor first, then picks quotient uniformly from `[ceil(minDividend / divisor), floor(maxDividend / divisor)]` so `divisor * quotient` has `A` digits. If no valid quotient exists (e.g. `A < B`), the category is marked not available online.
  - Any other category name (e.g. `"weird"`, `"0d3r"`, `"9d9r"`) or inactive category is not available online and retains typed score entry only.
- **Skipped Questions Flow in `js/drillPlayer.js`**: During the initial pass through questions `1..N`, clicking **Skip** marks that question as skipped and advances to the next unseen question. Once the initial pass completes, if any questions were skipped, the player revisits the skipped questions in order so the student can either answer them or skip/finish the set; any question still left unanswered when the set finishes is recorded as `null` in the submitted `answers` array and graded as wrong.
- **Locked Site Results (`source = 'site'`)**: The server inserts online Basics sets into `results` using the service role with `source = 'site'`, `verified = true`, `verified_by = null`, `student_round_id = null`, and `entry_date = today_ist()`. Everywhere basics entries appear (`/pages/basics.html`, dashboard Basics card, `/pages/review.html`, `/pages/student-detail.html`), rows with `source = 'site'` display the chip **`Recorded by the site`** (never `"Verified by teacher"`) and are locked against student edit/delete.

---

### 1. Overview & Core Concept

- **What It Does**: Adds an interactive online practice flow (`/pages/basics-practice.html?cat=<category_id>`) for Basics categories. Students pick `5`, `10`, or `20` questions (default `10`), solve one question at a time against a visible stopwatch, and receive immediate server-graded feedback (`correct / total`, accuracy, time, score colour tag, `Target met` / `Below target` chip from `results_with_target`, and a full question-by-question review table) while automatically recording the score in `results`.
- **Target Audience / Persona**: Students completing daily abacus/mental-math Basics speed drills online, and teachers reviewing student progress across typed worksheet entries (`source = 'typed'`) and site-graded online sets (`source = 'site'`).
- **Key Value**: Eliminates manual grading for online Basics practice while seamlessly feeding existing streaks, daily to-do ticks, target benchmarks, leaderboards, monthly reports, and backups without altering any of those downstream systems.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Basics Screen (`/pages/basics.html`)**:
     - Displays a **Practice Online** bar/list for all active Basics categories whose names match a supported generator, plus a **Practice online** button beside the category selector in the existing typed entry form whenever the selected category is supported online.
     - Existing manual typed entry form (`Record a Basics Drill`) and 7-day backdating remain completely unchanged.
     - In **Today's Sessions** and **Past 7 Days History**, rows with `source === 'site'` display a **`Recorded by the site`** chip instead of **`🔒 Verified`**, and hide Edit/Delete buttons (`Locked`).
  2. **Online Basics Setup (`/pages/basics-practice.html?cat=<category_id>`)**:
     - Shows the category title, a question-count selector (`5`, `10`, `20`, defaulting to `10`), the student's active target from `basics_thresholds` (level-specific rule overriding default rule, e.g., `"Target: 90% accuracy in 2:00 or less"`), and the student's **Personal Best** for this category and question count (highest accuracy, then shortest time, via `js/practiceStats.js`).
     - Clicking **Start** calls `POST /api/drill` with `{ action: 'start', kind: 'basics', category_id, questions }`.
  3. **One-Question-at-a-Time Player (`js/drillPlayer.js`)**:
     - Header shows question progress (`Question 3 of 10` or `Skipped review: 1 remaining`) and a live count-up stopwatch (`0:14`, tabular numerals, no per-question countdown limit).
     - **Display Formats**:
       - **Add/Subtract (`<N>d<R>r`)**: Vertical column of right-aligned numbers, each prefixed with its sign (`+ 42`, `- 15`, `+ 38`), a horizontal summation line below the last row, and the numeric answer input directly underneath.
       - **Multiplication (`<A>dx<B>d`)**: Large centered horizontal prompt (e.g., `47 × 8` / `47 x 8`) above the answer input.
       - **Division (`<A>d/<B>d`)**: Large centered horizontal prompt (e.g., `84 / 7`) above the answer input.
     - **Controls**: Pressing `Enter` or clicking **Next** records the typed answer (or treats an empty box as a skip if nothing was typed) and moves forward; clicking **Skip** explicitly skips the question (revisiting skipped questions at the end of the first pass, or allowing the student to finish immediately). No **Back** button is shown.
  4. **Results & Review Screen**:
     - Displays the confirmation banner: **"This set was saved to your scores."**
     - Summary cards show **Score** (`correct / total`), **Accuracy** (`%`), **Time** (`mm:ss`), the colour badge from `js/scoreColors.js` with `"n wrong"`, and the **`🎯 Target met`** or **`⚠️ Below target`** chip queried from `results_with_target` for the newly inserted `result_id`.
     - Renders a question-by-question review list (Question prompt, Your answer or *Skipped*, Correct answer, and `Correct` / `Wrong` status).
     - Action buttons: **Again** (starts a fresh set with the same category and question count) and **Back to basics** (`/pages/basics.html?cat=<category_id>`).

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Deriving Generators from the Category Name**
  - *Chosen Approach*: Parse `categories.name` dynamically on both server and client using a pure parser (`parseBasicsCategoryName`) that recognizes `<N>d<R>r`, `<A>dx<B>d`, and `<A>d/<B>d` without adding schema columns to `categories`.
  - *Why*: Teachers already name Basics categories using standard abacus notation (`1d4r`, `2d2r`, `2dx1d`, `3d/1d`). Deriving the generator from the name means any new category a teacher creates with standard notation automatically gains online practice with zero database migrations or admin configuration forms.
  - *Alternatives Considered*:
    - *Adding a `generator_config jsonb` column to `categories`*: Rejected because it requires schema changes and extra admin UI fields when the category name already encodes the exact digits, rows, and operation.

- **Decision 2: Locking Online Sets with `source = 'site'` Instead of `"Verified by teacher"`**
  - *Chosen Approach*: Server-graded Basics sets are inserted with `source = 'site'`, `verified = true`, and `verified_by = null`. The UI checks `row.source === 'site'` first and displays **`Recorded by the site`** instead of **`Verified`** / **`Verified by teacher`**.
  - *Why*: Setting `verified = true` reuses existing RLS and trigger protections so students cannot edit or delete server-graded scores, while `source = 'site'` accurately distinguishes automated site grading from a human teacher's review on `/pages/review.html` and student history lists.
  - *Alternatives Considered*:
    - *Leaving `verified = false`*: Rejected because students would be able to edit or delete their online scores after completion.

- **Decision 3: Separating Pure Player State (`js/drillPlayer.js`) from DOM Rendering**
  - *Chosen Approach*: Keep all question sequencing, skip queue management, answer array assembly (`null` for unanswered), and idempotent completion guards inside a pure state machine in `js/drillPlayer.js`, while `js/basicsPractice.js` handles DOM updates, stopwatch ticks, and network calls.
  - *Why*: Enables fast, deterministic `node --test` unit testing of every edge case (skipping, revisiting skipped items, finishing twice) without a browser DOM, while leaving the existing Elements all-on-one-page worksheet (`js/elementDrill.js`) completely untouched.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Data Flow Diagram**:
```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Student Browser (SPA/MPA)                        │
│                                                                            │
│  ┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────┐  │
│  │ /pages/basics.html  │──▶│ basics-practice.html │──▶│ js/drillPlayer  │  │
│  │ • Typed Entry       │   │ • 5 / 10 / 20 Qs     │   │ • 1-at-a-time   │  │
│  │ • "Practice online" │   │ • Target & Best Stat │   │ • Skip Queue    │  │
│  │ • "Recorded by site"│   │ • Stopwatch & Review │   │ • No Back Btn   │  │
│  └─────────────────────┘   └──────────┬───────────┘   └─────────────────┘  │
└───────────────────────────────────────┼────────────────────────────────────┘
                                        │ POST /api/drill
                                        │ { action:'start', kind:'basics', ... }
                                        │ { action:'submit', session_id, answers }
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     Vercel Serverless API (/api/drill.js)                  │
│  • verifyStudentCaller(req) -> active student JWT check                    │
│  • api/_drills.js -> parseBasicsCategoryName, generateBasicsQuestions,     │
│                      checkSubmission(session, answers, now)                │
│  • Rate limit: 60 sets/hr in drill_sessions                                │
│  • Minimum speed gate: elapsed >= questions * 0.6s                         │
│  • Expiry gate: started_at + 30 minutes                                    │
│  • Calls rpc('today_ist'), inserts results (source='site', verified=true), │
│    updates drill_sessions (status='submitted', result_row_id)              │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Pure Generator & Submission Verification (`api/_drills.js`)**:
  - Constants at top of file:
    - `BASICS_QUESTION_COUNTS = [5, 10, 20]`, `BASICS_DEFAULT_QUESTIONS = 10`
    - `BASICS_ADD_SUB_DIGITS_MIN = 1`, `BASICS_ADD_SUB_DIGITS_MAX = 4`, `BASICS_ADD_SUB_ROWS_MIN = 2`, `BASICS_ADD_SUB_ROWS_MAX = 10`, `BASICS_SUB_PROBABILITY = 0.4`, `BASICS_ROW_RETRY_LIMIT = 20`
    - `BASICS_SESSION_TTL_SECONDS = 1800` (30 minutes), `BASICS_MIN_SECONDS_PER_QUESTION = 0.6`, `BASICS_MAX_ANSWER_LENGTH = 20`, `BASICS_MAX_TIME_SECONDS = 14400`
  - `parseBasicsCategoryName(name)`:
    - Normalizes case and strips whitespace.
    - Matches `^([1-4])d([2-9]|10)r$` → `{ type: 'add_sub', digits: N, rows: R }`.
    - Matches `^([1-4])d[xX*×]([1-4])d$` → `{ type: 'mul', digitsA: A, digitsB: B }`.
    - Matches `^([1-4])d[/÷]([1-4])d$` → `{ type: 'div', digitsA: A, digitsB: B }`, verifying that at least one divisor in the `B`-digit range (`2..9` for `1d`, `10^(B-1)..10^B-1` for `B >= 2`) yields a valid integer quotient whose product has `A` digits (`A >= B`). Returns `null` if no valid quotient exists or if the pattern does not match.
  - `generateBasicsQuestions(categoryName, count = 10, rng = defaultRng)`:
    - Returns array of `{ display, text, expected }` where `display` contains `{ kind: 'rows', rows: [signed ints] }` for `add_sub`, `{ kind: 'mul', a, b, text: "a x b" }` for multiplication, and `{ kind: 'div', dividend, divisor, text: "dividend / divisor" }` for division (never exposing `expected` to the client on `start`).
  - `checkSubmission(session, answers, now)`:
    - Pure function validating session status (`'open'`), expiry (`now <= expires_at`), answer list length (`answers.length === questions.length`), per-answer type/length (`null` or string `<= 20` chars), and minimum elapsed time (`elapsed >= questions.length * 0.6`).
    - Grades each answer using integer parsing (`parseIntegerAnswer`: strips spaces/commas, accepts leading zeros; blank/`null`/non-integer is wrong, never throws), returning `{ ok: true, correct, total, accuracy, seconds, detail }` or `{ ok: false, statusCode, error }`.

- **Player & Stats Modules**:
  - `js/drillPlayer.js`: Pure `createDrillPlayer(questions)` state machine managing current question index, first-pass vs. skipped-review queue, `answerCurrent(val)`, `skipCurrent()`, `finish()`, `isFinished()`, and `getAnswers()` (idempotent on repeated `finish()` calls).
  - `js/practiceStats.js`: Pure helpers `bestResultForCategory(rows, categoryId, questionCount)` (filtering `category_id` and `total === questionCount`, sorting by higher `correct / total` then lower `time_seconds`) and `setsThisWeek(rows, categories, nowOrTodayIST)` (Monday–Sunday in `Asia/Kolkata`).

- **Build, Demo Mode & Documentation**:
  - Register `basicsPractice: path.resolve(__dirname, 'pages/basics-practice.html')` in `vite.config.ts`.
  - Add fixed sample online Basics session & result in `js/demoDb.js` (restricted to `localhost` and `*.run.app` with visible Demo Mode banner; zero browser-side question generation or grading).
  - Update `/docs/HANDOVER.md`, `/docs/DECISIONS.md`, `/docs/DATA.md`, `/docs/THREAT.md`, and `/docs/TESTING.md`.
