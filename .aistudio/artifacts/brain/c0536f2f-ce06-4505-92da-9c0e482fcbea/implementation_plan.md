# Trendz Tracker — Phase 9b-2: Mental Multiplications, Mental Square Roots & Exit Button Fix

Phase 9b-2 completes the four-module Memoriad competition practice suite by enabling **Mental Multiplications** (10 questions of $8\text{-digit} \times 8\text{-digit}$ numbers, 15-minute limit, 16-state cyclic step boxes, and 16 answer slots) and **Mental Square Roots** (10 six-digit non-square radicands, 15-minute limit, exact integer half-up rounding to 5 decimals, triangular $k(k+1)/2$ prefix-digit scoring up to 360 points, 6-box step markers, and `___ . _____` fixed-point answer slots), while fixing the competition stage **Exit** button modal.

## User Review & Critical Decisions

> [!IMPORTANT]
> **New Dependencies**: **None** (zero new npm packages; pure HTML, CSS, and vanilla JavaScript).
> Please review the plan and alternatives below and click **Proceed** to execute the implementation.

- **Exit Button Root-Cause Fix**: The stage confirmation modal used `.modal-backdrop.active`, whereas the shared stylesheet requires `.modal-backdrop.open` (`opacity: 1; visibility: visible; pointer-events: auto`). Adding `.open` to the inline stage modal and binding `Escape` / backdrop click ensures the **Exit** button (both during Concentration and during the Stage) immediately opens the confirmation dialog and cleanly returns to Settings when confirmed.
- **Exact Integer Square-Root Half-Up Rounding**: Uses pure `BigInt` integer square root ($m = n \times 10^{10}$, $r = \lfloor\sqrt{m}\rfloor$, rounded to $r + 1$ when $m - r^2 \ge r + 1$, else $r$) so floating-point precision drift can never affect the 5th decimal place.
- **Triangular Prefix-Digit Scoring for Square Roots**: Counts consecutive matching leading digits $k \in [0..8]$ from the left (stopping at the first wrong or blank slot) and awards $\text{points} = k(k+1)/2$ per question (maximum $36 \times 10 = 360$), stored in named constants with provenance comments explaining how the rule was inferred from published championship results and a simulator screenshot (`2` correct digits $= 3$ points, `6` $= 21$ points, `8` $= 36$ points).

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Mental Multiplications**: Generates 10 pairs of 8-digit numbers (`10000000`–`99999999`), grades exact `BigInt` products (15 or 16 digits) under a 15-minute (`900s`) limit, and provides a 5×2 overview grid, an 8-column cyclic step-box bar (`*` or sequential click cycles $s = 0..15$: steps `1..8` check `1..8` boxes from the right, steps `9..15` leave `7..1` boxes on the left, step `16` resets to `0`) that highlights the corresponding digit columns of both operands, and 16 answer slots (`rtl` or `ltr`, 1 digit per step).
  2. **Mental Square Roots**: Generates 10 six-digit non-square integers (`100000`–`999999`), computes 8-digit roots (`DDD.DDDDD`) rounded half-up via exact integer arithmetic, grades leading matching digits $k$ with triangular points $k(k+1)/2$, and provides a 5×2 overview grid, 6 left-to-right step boxes (`*` checks next from left, `/` unchecks rightmost checked, no wrap-around), and 8 left-to-right answer slots with a fixed decimal point after the 3rd slot (`___ . _____`).
  3. **Memoriad Hub, Shared Card & Demo Mode**: Activates all four modules on the Memoriad page and student/admin summary card, ranks Square Roots by highest `score` (then shorter time) and Multiplications by highest `correct` (then shorter time), and provides deterministic Demo Mode fixtures.
  4. **Exit Button Fix**: Fixes the stage modal visibility class so clicking **Exit** during Concentration or Stage reliably displays the discard confirmation dialog.
- **Target Audience**: Abacus and mental-arithmetic students and coaches training for championship-level multi-digit multiplication and square-root extraction.
- **Key Value**: Brings full parity across all four competition disciplines with zero floating-point rounding ambiguity and authentic cross-multiplication / root-extraction column markers.

---

## 2. User Experience & Visual Design

- **1280×800 Desktop Stage Architecture (Two-Zone Split)**:
  - **Left Zone (5×2 Overview Grid)**: 10 compact question cards showing either the two stacked 8-digit factors (`×`) or the square-root radical (`√NNNNNN`) plus the student's current typed answer (formatted as `DDD.DDDDD` for roots) and an active card highlight using both background tint (`--color-primary-subtle`) and a `2px` border + `5px` top accent bar.
  - **Right Zone (Active Question Workbench)**:
    - **Multiplications Workbench**: Displays a row of 8 interactive step boxes aligned directly above the 8 digit columns of the two stacked 8-digit numbers. Checked step boxes show a check mark (`✓`) and apply a high-contrast column highlight (tinted background + bold outline, not colour alone) to the corresponding digit column of both factors. Below the horizontal product rule sits a row of 16 digit slots supporting `rtl` (default) or `ltr` entry.
    - **Square Roots Workbench**: Displays a row of 6 interactive step boxes aligned above the 6 digits of the radicand inside a clean radical frame (`√`). Below sits the 8-slot answer row formatted as `___ . _____` with a fixed, non-editable decimal point separator after slot 3, left-to-right typing, arrow key navigation, and `Backspace`.
- **Results Screen**:
  - Shows **SCORE** (large headline metric), **Used Time** (2 decimals), **# of Fully Correct Answers**, and **Attempted** count.
  - For **Square Roots**, the breakdown table displays **Question**, **Correct Answer**, **Your Answer** (with per-digit visual comparison ticks `✓` and crosses `✗` plus text summary), **Correct Digits ($k$)**, and **Points**.
  - For **Multiplications**, the breakdown table displays **Question**, **Correct Answer**, **Your Answer**, and **Correct** / **Wrong** / **Not answered**.

---

## 3. Key Product Decisions & Trade-Offs (With Alternatives)

- **Decision 1: Exact Integer Arithmetic vs. Floating-Point `Math.sqrt` for Square Roots**:
  - *Chosen Approach*: Scale the 6-digit integer $n$ by $10^{10}$ in `BigInt` ($m = \text{BigInt}(n) \times 10^{10}\text{n}$), compute the exact integer floor square root $r = \text{isqrt}(m)$ via Newton's method, and round half-up using the exact remainder identity:
    $$(r + 0.5)^2 = r^2 + r + 0.25 \implies \sqrt{m} \ge r + 0.5 \iff m - r^2 \ge r + 1$$
    When $m - r^2 \ge r + 1$, the 8-digit integer is $r + 1$; otherwise $r$, formatted as `DDD.DDDDD`.
  - *Why*: IEEE-754 double-precision floats (`Math.sqrt(n).toFixed(5)`) suffer from binary representation rounding errors near half-way boundaries and can truncate instead of rounding half-up (e.g., `850772` must yield `922.37303`).
  - *Alternatives Considered*: `Math.sqrt(n * 1e10)` in `Number` (rejected: `999999 * 1e10` is $10^{16}$, exceeding `Number.MAX_SAFE_INTEGER` $= 9.007 \times 10^{15}$, causing low-bit corruption).
- **Decision 2: Triangular Prefix-Digit Scoring ($k(k+1)/2$, Stopping at First Mistake)**:
  - *Chosen Approach*: Compare the student's 8 answer slots from left to right (`0..7`) against the 8 expected digits (`DDD` + `DDDDD`). Count $k$, the number of contiguous matching digits from index `0`, stopping immediately at the first wrong or blank slot. Compute $\text{points} = k(k+1)/2$ (`0 -> 0, 1 -> 1, 2 -> 3, 3 -> 6, 4 -> 10, 5 -> 15, 6 -> 21, 7 -> 28, 8 -> 36`).
  - *Why*: Subsequent digits in a square root represent progressively smaller place values that depend on earlier digits; published Memoriad results and simulator screenshots confirm that `2` leading digits award `3` points, `6` award `21` points, and all `8` award `36` points (up to `360` for 10 roots), while any mistake halts credit for later decimal places.
  - *Alternatives Considered*: Flat 1 point per matching digit anywhere in the string (rejected: contradicts competition scoring where random trailing digits after an error earn zero credit).
- **Decision 3: Unified Pure Step-Box Module (`js/stepBoxes.js`) for Both Cyclic (Multiplication) and Bounded (Square Root) Modes**:
  - *Chosen Approach*: Implement a pure, DOM-free state module supporting both:
    - **Multiplication mode (`n = 8`, cyclic `0 .. 2n - 1`)**: state $s \in [0..15]$; for $0 \le s \le n$, the rightmost $s$ boxes (`[n - s .. n - 1]`) are checked; for $n < s < 2n$, the leftmost $2n - s$ boxes (`[0 .. 2n - s - 1]`) are checked. `*` advances $s = (s + 1) \bmod 2n$; `/` is a no-op; clicking box `idx` advances only if `idx` is the exact next box to change in the sequence (`n - 1 - s` while growing $0 \le s < n$, or `2n - s - 1` while shrinking $n \le s < 2n - 1$, or `0` at $s = 2n - 1$).
    - **Square Root mode (`n = 6`, bounded `0 .. n`)**: state $c \in [0..6]$ representing how many leftmost boxes (`[0 .. c - 1]`) are checked. `*` (or clicking box $c$) increments $c$ up to $n$; `/` (or clicking box $c - 1$) decrements $c$ down to $0$; no wrap-around.
  - *Alternatives Considered*: Mixing step-box index math directly into DOM click handlers (rejected: harder to unit-test all 16 cyclic steps and click-target guards).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     SHARED CONFIG & SERVER ENGINE                        │
│  • Time Limits: calendar=60s, additions=600s, mult=900s, roots=900s      │
│  • Plausibility: mult & roots require used_seconds >= attempted * 5      │
│  • Multiplications: 10 × (8d × 8d), BigInt product (15–16d), score=corr  │
│  • Square Roots: 10 × 6d non-squares, BigInt isqrt half-up (DDD.DDDDD),  │
│    prefix k in 0..8 -> points = k(k+1)/2, settings.{score, digits_total} │
└───────────────────┬──────────────────────────────────────┬───────────────┘
                    │                                      │
                    ▼                                      ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────┐
│     PURE CLIENT STATE MACHINES        │  │  PLAY STAGE & HUB CONTROLLERS │
│ • Step Boxes (mult cyclic s=0..15     │  │ • Exit Modal Fix (.open class)│
│   & roots bounded c=0..6)             │  │ • Multiplications Stage:      │
│ • Answer Slots:                       │  │   8 step boxes + 16 slots     │
│   - Mult: 16 slots (rtl/ltr, g=1)     │  │ • Square Roots Stage:         │
│   - Roots: 8 slots (ltr, fixed dot    │  │   6 step boxes + 3.5 slots    │
│     after 3rd slot, raw slots kept)   │  │ • Hub & Card: all 4 modules   │
└───────────────────────────────────────┘  └───────────────────────────────┘
```

### Interactive Component & State Mapping
1. **Server Generator, Grader & Plausibility**:
   - **Multiplications**: Generates 10 questions of `[factorA, factorB]` where each factor is an 8-digit string (`first digit 1..9`, `7 digits 0..9`), with `expected = (BigInt(factorA) * BigInt(factorB)).toString()`. Evaluates by stripping leading zeros and comparing `BigInt` values; `score = correct`; plausibility `minSecondsPerAttempt = 5`.
   - **Square Roots**: Generates 10 distinct 6-digit integers in `100000..999999`, rejecting any perfect square ($\lfloor\sqrt{n}\rfloor^2 = n$). Computes `expected` as `"DDD.DDDDD"` using exact `BigInt` `isqrt` on $m = n \times 10^{10}$ with half-up rounding ($m - r^2 \ge r + 1 \implies r + 1$). Evaluates student answers (accepting an 8-character slot string with `_` or spaces for blank positions, or a digit/decimal string up to 20 chars) by aligning typed digits to the 8 slots (`3` integer + `5` decimal), counting leading matching digits $k$ from slot `0` until the first mismatch or blank slot, and computing `points = (k * (k + 1)) / 2`. Returns per-question `{ expected_display, given_display, correct_digits, points }` plus `{ score, correct, attempted, digits_total }`. Saves `correct` (count of questions with $k = 8$), `total = attempted`, `settings.score = score`, `settings.digits_total = sum(k)`, `settings.wrong = attempted - correct`, and `settings.finished_by`.
2. **Step Boxes & Answer Slots on the Play Stage**:
   - **Multiplications**: Settings include Typing direction (`rtl` default or `ltr`), Question format (`Stacked` active; `Side by side (coming later)` disabled), Show timer, Concentration time, and fixed `"Time limit: 15 minutes"`. Stage renders 8 step boxes above the two stacked 8-digit numbers (highlighting checked columns across both numbers with background + outline) and 16 answer slots.
   - **Square Roots**: Settings include Show timer, Concentration time, and fixed `"Time limit: 15 minutes"`. Stage renders 6 step boxes above the 6-digit radicand and 8 answer slots rendered as `___ . _____` (`ltr` only; typing fills left to right, `ArrowLeft`/`ArrowRight` moves cursor, `Backspace` clears previous slot and moves cursor there, `Enter` moves to next question or prompts `"Finish?"` on Q10 when all 10 have answers). To preserve exact slot positions when a student moves the cursor with `ArrowRight` and leaves a leading or middle slot blank, Square Roots submits the 8-slot positional string (using `_` for empty slots if any slot is filled, or `null` if all 8 slots are empty) while also accepting plain digit/decimal strings (`"675"` $\to$ `"675_____"`) on the server.
3. **Memoriad Hub, Shared Card & Stats**:
   - Enable `multiplications` and `square_roots` in `MEMORIAD_MODULE_CATALOG`.
   - Update `compareMemoriadAttempts`:
     - For `square_roots`: highest `score`, then shorter `used_seconds` (then highest `correct`).
     - For `multiplications`: highest `correct`, then shorter `used_seconds` (then higher `accuracy`).
   - Update hub cards, Last 5 Tries table, and dashboard card to format Square Roots attempts cleanly (e.g. `Score 215 · 7/9 attempted · 12:30` / `750.00s`) and include Demo Mode fixtures for all 4 modules.

---

## 5. Five-Line Session Summary & Beginner Test Guide

### 5-Line Session Summary
1. Enabled **Mental Multiplications** ($8\text{d} \times 8\text{d}$, 15-min limit, `BigInt` product grading, cyclic 8-box column markers) and **Mental Square Roots** (6-digit non-square radicands, 15-min limit, exact `BigInt` half-up rounding to 5 decimals, triangular $k(k+1)/2$ prefix scoring).
2. Added a pure step-box state machine (`js/stepBoxes.js`) supporting the 16-step cyclic cross-multiplication pattern (`*` cycles right-to-left growth then right-to-left removal; `/` ignored) and the 6-step bounded root pattern (`*` checks left-to-right, `/` unchecks right-to-left).
3. Fixed the competition stage **Exit** button by applying the `.open` visibility class to the stage confirmation modal and wiring keyboard/backdrop dismissal.
4. Enabled all four modules on `/pages/memoriad.html` and the shared dashboard card, updating `js/memoriadStats.js` ranking rules and Demo Mode fixtures.
5. Expanded unit tests for non-square generation, half-up rounding, triangular points, `BigInt` products, and step-box state transitions, and updated `HANDOVER.md`, `DECISIONS.md`, `THREAT.md`, and `TESTING.md`.

### Beginner Test Guide
1. **Run Automated Tests**: Run `node --test tests/*.test.js` in the terminal and confirm every suite passes (`0 fail`), including the known square-root roundings (`258524 -> 508.45255`, `850772 -> 922.37303`, `115456 -> 339.78817`, `457832 -> 676.63284`, `453077 -> 673.10995`), triangular points (`k=2 -> 3`, `k=6 -> 21`, `k=8 -> 36`), and multiplication product (`39951857 * 81044514 = 3237878833962498`).
2. **Verify the Exit Button Fix**: Open `/pages/memoriad.html`, start any module, click **Exit** during the Concentration countdown or on the Stage, confirm the `"Discard This Practice Try?"` modal appears immediately, and click **Discard & Exit** to return to Settings.
3. **Test Mental Multiplications**: Open `/pages/memoriad-play.html?module=multiplications`, verify `"Time limit: 15 minutes"` and the disabled `"Side by side (coming later)"` option, start the stage, press `*` repeatedly (1 to 16 times) to watch the 8 step boxes and operand columns fill from right to left and then clear from right to left, type digits into the 16 answer slots, and click **FINISH**.
4. **Test Mental Square Roots**: Open `/pages/memoriad-play.html?module=square_roots`, start the stage, press `*` and `/` to check and uncheck the 6 step boxes from left to right, type digits into the `___ . _____` answer slots, and click **FINISH** to inspect the per-question **Correct Digits** and **Points** breakdown table.
5. **Check Memoriad Hub & Dashboard Card**: Return to `/pages/memoriad.html` and `/pages/student.html` to verify that Personal Bests and Last 5 Tries update for both new modules.
