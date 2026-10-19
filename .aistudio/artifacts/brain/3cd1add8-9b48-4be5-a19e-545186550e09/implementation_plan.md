# Phase 8: Elements Timed Worksheet Drills

Deliver 18 server-generated, server-graded timed worksheet drills ("Elements") for Trendz Tracker students, with deterministic math verification, atomic session handling, responsive worksheet entry, and student/teacher dashboard summaries.

### User Review & Critical Decisions

> [!IMPORTANT]
> Please review the following architectural choices and drill rule details before implementation begins:

- **Modulo Calculation Drill (`modulo`) Disabled by Default**: Enabled flag is set to `false` (controlled by a single boolean constant) and displayed as "Coming soon" in the student catalog until a teacher confirms the formula. Both the generator-intent formula (`t = n3 - (d1*d3*2 + d2*d2)`) and the legacy desktop program's formula (`n3 - d1*d3*2 + d2*d2`) are documented in code comments, with the generator-intent formula active for testing and future enablement.
- **Days to Seconds Time Limit**: Uses `300` seconds (5 minutes) as stated on the original desktop screen rather than the 60-second timer cutoff bug in the legacy code.
- **Zero-Attempt Submissions**: If a student submits a worksheet with 0 attempted (non-blank) answers, the server does not write a row to `activity_results` and returns a clear message explaining that nothing was saved because no questions were answered.

---

### 1. Overview & Core Concept

- **What It Does**: Provides students with 18 structured mental-math and calendar/time conversion worksheet drills. When a student starts a drill, the server generates all questions and expected canonical answers, stores them in a protected session, and sends only the question texts to the browser. When the student submits (or time expires), the server grades the answers, enforces rate limits, expiry, and minimum plausible completion speed, and records valid sets in `activity_results`.
- **Target Audience / Persona**: Abacus and mental-arithmetic students practicing speed and accuracy on mobile phones, tablets, or desktop computers, and teachers/admins monitoring weekly practice volume and personal bests.
- **Key Value**: Eliminates client-side answer exposure and floating-point rounding bugs while providing fast keyboard/touch worksheet navigation, clear post-drill review with colour + text indicators, and automatic integration with daily to-do tasks and practice streaks.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Elements Catalog**: Students open the Elements page from the main navigation, dashboard card, or daily to-do list. Drills are organized into 5 clear groups (*Codes*, *Squares and cubes*, *Division*, *Time*, *Other*). Each card shows the drill title, question count and time limit (e.g., `56 questions · 1 minute`), the student's personal best score/time (or `No attempts yet`), and a `Start` button (`Coming soon` and disabled for `modulo`).
  2. **Drill Intro & Timed Worksheet**: Selecting a drill opens the worksheet view in an intro state showing the title, question count, time limit, answer-format hint, and a prominent `Start` button. Clicking `Start` fetches the server-generated questions and renders the full numbered worksheet in a responsive grid (1 column on phones, 2–3 columns on tablet/desktop) below a sticky timer bar (`mm:ss`, progress bar, and `Submit now`).
  3. **Keyboard & Touch Navigation**: Numeric drills use `inputmode="numeric"` while prime factors, ratio, and modulo use `inputmode="text"`. Pressing `Enter`, `Tab`, or `ArrowDown` moves focus smoothly to the next question input.
  4. **Countdown & Network-Resilient Submission**: The timer computes remaining time from a monotonic `performance.now()` deadline every 250 ms. Reaching `00:00` disables inputs and triggers automatic single-flight submission. If a network error occurs during submission, typed answers remain intact on screen with a `Try sending again` action until the session expiry window passes.
  5. **Result & Review Screen**: Displays `correct / attempted`, blank count, accuracy percentage, elapsed time, a "New personal best" callout when earned, and the shared mistake badge (`n wrong` paired with semantic colour). Below the summary, a full question-by-question review table shows the prompt, the student's answer, the canonical expected answer, and explicit `Correct` or `Wrong` text labels, alongside `Same drill again` and `All drills` buttons.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Consistent with Trendz Tracker's clean, high-contrast academic utility aesthetic.
  - *Color Palette & Mood*: Neutral slate canvas (`--bg-body: #f8fafc`, `--bg-card: #ffffff`), primary indigo actions (`--color-primary: #2563eb`), and semantic mistake-tier badges (`0 wrong` green, `1–3 wrong` yellow, `4–6 wrong` orange, `7+ wrong` red) always paired with explicit text.
  - *Typography & Hierarchy*: Tabular numerals (`font-variant-numeric: tabular-nums`) on all timers, question prompts, inputs, and score summaries so columns align cleanly without layout jitter.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Server-Authoritative Generation and Grading via Vercel Function**
  - *Chosen Approach*: Generate questions and canonical answers in a pure server module and persist them in `drill_sessions` using the Supabase service-role client inside a serverless API endpoint; strip expected answers before responding to the client.
  - *Why*: Prevents students from inspecting network payloads or client state to see answers, and ensures streaks and `activity_results` are only written after server-side validation of expiry (`time_limit + 30s`) and minimum human speed (`attempted * 0.25s`).
  - *Alternatives Considered*:
    - *Client-side generation with server signature*: Rejected because the question-to-answer mapping for deterministic math drills is trivial to compute in a browser script if questions are not bound to a server-timed session.
    - *Postgres PL/pgSQL generation for all 18 drills*: Rejected because maintaining 18 distinct random generators, GCD/ratio reduction, prime factorization, and exact integer square-root ceiling logic in pure JS with injectable RNG makes deterministic unit testing (`node --test` over 200 seeded runs per drill) straightforward and fast without requiring new SQL migrations.

- **Decision 2: Exact Integer / BigInt Arithmetic and Canonical Answer Comparison**
  - *Chosen Approach*: Use exact integer and `BigInt` operations for all calculations (squares, cubes, integer ceiling square roots via binary search/Newton step, greatest common divisor for lowest-terms ratios) and normalize student inputs into canonical structures (integer, sorted prime pair, unreduced pair vs reduced expected pair, or `[quotient, remainder]`).
  - *Why*: Eliminates IEEE-754 floating-point precision issues and guarantees that unreduced ratios (e.g., `8/14` instead of `4/7`) are rejected while formatting differences (`86,400`, `0086400`, `97x13` vs `13 * 97`) are accepted gracefully.
  - *Alternatives Considered*:
    - *`Math.sqrt` / `Number` parsing*: Rejected because floating-point rounding or `Number()` coercion accepts scientific notation, decimals, or loses precision on large values.

- **Decision 3: Shared Catalog Metadata Verification**
  - *Chosen Approach*: Maintain a lightweight browser-safe catalog module for UI rendering and enforce 1:1 parity with the server drill definitions via an automated unit test.
  - *Why*: Allows the browser to render the 18 drill cards, groups, and intro hints immediately without importing Node's `crypto` module in client code, while guaranteeing zero drift between client metadata and server rules.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:
```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Student / Admin Browser                         │
│                                                                         │
│  ┌──────────────────────┐   ┌──────────────────────┐   ┌─────────────┐  │
│  │   Elements Catalog   │   │   Timed Worksheet    │   │  Dashboard  │  │
│  │  (18 Grouped Cards   │──▶│  (Grid Inputs, 250ms │   │  Elements   │  │
│  │   + Best Scores)     │   │   Timer, Review UI)  │   │  Summary    │  │
│  └──────────┬───────────┘   └──────────┬───────────┘   └──────┬──────┘  │
└─────────────┼──────────────────────────┼──────────────────────┼─────────┘
              │ Read own                 │ POST start / submit  │ Read
              │ activity_results         │ (Bearer JWT)         │ results
              ▼                          ▼                      ▼
┌─────────────────────────┐   ┌───────────────────────────────────────────┐
│   Supabase PostgREST    │   │        Serverless Drill Endpoint          │
│     (RLS Protected)     │   │  • Verifies active student caller         │
│  • activity_results     │   │  • Pure 18-Drill Generator & Parser       │
│    (Student SELECT)     │   │    (Injectable RNG, BigInt exact math)    │
└─────────────────────────┘   └─────────────────────┬─────────────────────┘
                                                    │ Service Role
                                                    ▼
                              ┌───────────────────────────────────────────┐
                              │         Supabase Database Tables          │
                              │  • drill_sessions (open -> submitted,     │
                              │    60/hr rate limit, min_seconds, expiry) │
                              │  • activity_results (activity_type =      │
                              │    'element', correct, total = attempted) │
                              └───────────────────────────────────────────┘
```

- **Data Model & State**:
  - **`drill_sessions`**: Stores `student_id`, `activity_type = 'element'`, `activity_name` (drill title), `settings` (`{drill, questions, time_limit_seconds}`), `questions` (array of prompt strings), `expected` (array of canonical answers), `min_seconds`, `started_at`, `expires_at` (`started_at + time_limit_seconds + 30s`), `status` (`'open' | 'submitted'`), `submitted_at`, and `result_id`.
  - **`activity_results`**: Stores completed sets with `activity_type = 'element'`, `activity_name` (drill title), `correct`, `total` (number of attempted questions), `time_seconds` (`min(round(elapsed), time_limit_seconds)`), and `settings` (`{drill, questions, time_limit_seconds, attempted, session_id}`).
  - **Personal Best Ranking (`bestForDrill`)**: Ranks completed sets for a given drill by: (1) highest `correct`, (2) fewest wrong answers (`total - correct`), and (3) shortest `time_seconds`.

- **Interactive Component & State Mapping**:
  - **Catalog View**: Queries `activity_results` (`activity_type = 'element'`) for the logged-in student, computes per-drill bests via `summaryByDrill`, and renders grouped drill cards.
  - **Worksheet Lifecycle**: `intro` state $\to$ `starting` (disables button, calls `start` action) $\to$ `active` (renders grid, starts `performance.now()` 250 ms interval, binds `Enter`/`Tab`/`ArrowDown` focus navigation) $\to$ `submitting` (locks inputs, sends answers array with blank inputs mapped to `null`) $\to$ `review` (renders score badge, personal best banner, and per-question breakdown) or `retry_submit` (preserves inputs on network error until `expires_at`).
  - **Demo Mode Fallback**: On `localhost` and `*.run.app` when Supabase is unconfigured, provides a fixed sample drill session and fixed sample result in `DemoDB` without duplicating generation or grading logic.
