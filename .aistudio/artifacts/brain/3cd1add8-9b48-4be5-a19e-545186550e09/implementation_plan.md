# Trendz Tracker — Phase 4c-2c: Import Validation Limits, Diagnostics & UI Polish

This plan closes the validation gap between the browser CSV preview and the PostgreSQL `admin_import_rounds` RPC limits, fixes three unreported diagnostics found on the real two-block student sheet, adds pre-flight payload validation and rich error diagnostics, and polishes the Import page layout and controls.

---

## Diagnostic Report: Why the 3 Sample Sheet Items Were Missing

> [!IMPORTANT]
> Below are the exact root causes found in the current code for the three items in Section 3 of your request:

1. **Two info lines: two rounds share a date in Block 2 (`25 Jul 2026` and `16 Aug 2026`) — MISSING from Needs Attention**
   - **Why**: In the parser's duplicate-date check (`byDate` loop), when multiple rounds in the same block shared an ISO date, the parser pushed the `duplicate_date` flag into `blk.dateInfos` and each round's `dateFlags`, **but omitted `needsAttention.push(...)`**. As a result, the info lines never reached the top Needs Attention list.
2. **Round 26 in Block 2 failing the Marks check (`sheet 177, calculated 178`) — MISSING (falsely marked OK)**
   - **Why**: In `evaluateMarksCrossCheck`, the check computed both `diff = computedMarks - sheetValue` (`178 - 177 = +1`) and `sheetDiff = (sheetTotalAttempt - sheetFinalScore) - sheetValue`, and marked the check `OK` if **either** `diff === 0 || sheetDiff === 0`. Because Round 26's sheet summary rows had `Total Attempt - Final Score = 177`, `sheetDiff === 0` masked the 1-mark discrepancy against the actual cell sum (`sum(total) - sum(correct) = 178`). Changing the check to compare strictly against `computedMarks` (`sum(total) - sum(correct)`) reports the mismatch (`sheet 177, calculated 178`).
3. **Time Taken warning for Block 2 Round 14 (cell `DV31`, `"59:23:00"`) — MISSING**
   - **Why**: `parseTimeCell("59:23:00")` accepted any non-negative `h:mm:ss` (`213,780` seconds) without checking the database's `0..28800` second (8-hour) limit on `student_rounds.time_taken_seconds`. It passed through as a normal number and caused `admin_import_rounds` to abort the entire batch.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. Mirrors every PostgreSQL limit of `admin_import_rounds` inside the pure parser and planner so invalid or out-of-range values are caught, sanitized, or excluded during preview—before any database call is made.
  2. Runs a pure pre-flight `validatePayload(payload)` check before calling the database; if any rule is violated, the database is not called and the exact list of `(round_number, field, value)` problems is displayed.
  3. Provides actionable failure recovery if a database RPC ever fails: displays the exact database message, plain-language reassurance (nothing from the failing call was saved, an `"Open"` batch with `0` rows may appear in history and can be undone with a reason, and re-running is safe), and an expandable **Technical details** panel (failing step, series, round numbers in that call, and the first 3 rounds' metadata without any secrets or keys).
  4. Polishes the Import page UI using the existing design tokens and shared components so scannability, number formatting, chip alignment, student selection, and mobile responsiveness are clean.

---

## 2. User Experience & Visual Design

### UI Polish & Layout Improvements (Section 4)

- **Top Nav Spacing**:
  - Add standard vertical spacing (`margin-top: var(--space-6)`) between the top navigation bar and the first card / banner on the Import page so the card is never flush or clipped against the sticky header.
- **Single-Control Searchable Student Picker**:
  - Replace the stacked separate `<input>` + `<select>` pair in Step 1 with a single unified combobox picker: a button/input control that clearly displays the currently selected student (`Name (CODE) · Level`) with a "Change / Clear" affordance, and opens a searchable dropdown list filtering by student name or ID in real time.
- **Summary Cards**:
  - Prevent awkward line breaks like `"2 Blocks · 72 / Rounds"` by structuring each stat card with a top label, a prominent tabular numeral (`font-variant-numeric: tabular-nums`, `white-space: nowrap`), and a concise unit subtitle beneath.
  - Format all large integer counts with thousands separators (`1,677` via `toLocaleString('en-IN')`).
  - Format all dates with consistent 3-letter month abbreviations (`Jan`, `Feb`, `Mar`, `Apr`, `May`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec`—never `Sept`).
- **"Needs Attention" Triage Panel**:
  - **Left-Aligned Row Layout**: Place the severity badge, the `Block X · Round Y` chip, and the cell coordinate chip (`DV31`) on the left, followed immediately by left-aligned message text (wrapping cleanly below the chips on narrow screens instead of right-aligning against the far edge).
  - **No Redundant Cell Reference**: Strip duplicate cell coordinates from the sentence text when the cell coordinate chip is already shown on the row.
  - **Exact Heading Counts & Severity Grouping**: Group items in order of severity (`Blocking Errors`, `Warnings`, `Info`) and make the section heading state the exact breakdown (e.g., `"Needs attention (5 warnings, 2 info)"`).
  - **Show Info Lines Toggle**: Add an interactive `"Show info lines (N)"` toggle button so admins can show or hide informational items cleanly.
  - **Acknowledgment Summary List**: Group and count warnings that alter or exclude data on import (such as rounds whose `Time Taken > 8 hours` will be imported with `time_taken_seconds = null`, truncated `round_type` or `note` values, or excluded rounds) so the admin sees the exact count before importing.
- **Additional Page-Wide Polish (Series Bar, Category Mapping, Round Table, Modal, History)**:
  - **Series-per-Block Control Bar**: Keep the block metadata chips (`Rounds 1–50`, date range, file hint) left-aligned with `white-space: nowrap` on ranges, and keep the series dropdown + Confirm button aligned with consistent `gap: var(--space-3)`.
  - **Category Mapping Table**: Prevent category resolution dropdowns from cramping on narrow screens (`min-width: 220px`) and keep status badges single-line (`white-space: nowrap`).
  - **Round Summary Table & Expandable Cell Drawer**: Wrap tables in horizontal scroll containers (`overflow-x: auto; -webkit-overflow-scrolling: touch`), right-align numeric score/attempt/marks columns with `tabular-nums`, and prevent button crowding in the action column.
  - **Confirm Import Modal & Import History Table**: Format all counts with thousands separators, use consistent 3-letter month dates (`Sep`), add spacing between action buttons, and handle `"Open"` batches with `0` rows clearly in the history status column (allowing Undo with a reason).

---

## 3. Key Product Decisions & Alternatives Considered

### Decision 1: Mirroring Database Constraints in Pure Preview & Planner Functions
- **Chosen Approach**: Enforce all PostgreSQL `admin_import_rounds` rules inside `parseScoreSheetCsv` (`js/importParser.js`) and `buildImportExecutionPlan` / `validatePayload` (`js/importPlan.js`):
  - **Time Taken > 28,800s (8h)**: Emit warning `"Total time <text> at <cell> is more than 8 hours: the round will be imported WITHOUT a total time"`, include in the acknowledgment summary with its count, and set `time_taken_seconds = null` in the planned payload (8:00:00 = `28800` is accepted; 8:00:01 = `28801` triggers the warning and nullification).
  - **Cell Time > 14,400s (4h)**: Mark the cell `unreadable` (`"Cell time <text> exceeds 4 hours (14,400s)"`) so it is not imported (4:00:00 = `14400` is accepted; 4:00:01 = `14401` is unreadable).
  - **Round Type > 40 chars**: Truncate to 40 characters with a warning.
  - **Surprise Task / Cell Note > 500 chars**: Truncate to 500 characters with a warning.
  - **Other Round Limit Violations** (`round_number` outside `1..100000`, `round_date` missing or outside `2020-01-01..today_ist()`, or duplicate category within a round): Exclude that specific round from the import payload and list it as **Excluded** in the preview and acknowledgment list rather than aborting the entire sheet.
- **Why**: PostgreSQL rejects the entire `admin_import_rounds` call if even one round or cell violates a check constraint. Catching and handling these in pure JS lets the admin see every adjustment upfront and import valid rounds safely.
- **Alternatives Considered**:
  - *Alternative A — Let the database fail and parse the SQL error string*: Rejected because PostgreSQL constraint errors do not identify which spreadsheet cell (e.g., `DV31`) or round number caused the failure, and abort the entire 100-round chunk.
  - *Alternative B — Silently drop out-of-range values without warning*: Rejected because admins must know when a round's total time is cleared to `null` or when a round is excluded.

### Decision 2: Pre-Flight `validatePayload(payload)` Gate Before Any Database Call
- **Chosen Approach**: Before calling `admin_start_import` or `admin_import_rounds`, run `validatePayload(payload, { todayIST })` on every planned chunk. It verifies chunk size (`1..100` rounds, `<= 3000` cells), round fields (`round_number`, `round_date`, `round_type`, `time_taken_seconds`), and cell fields (`correct`/`total`/`note`, `time_seconds`, unique `category_id` per round), returning `{ valid, problems: [{ blockNumber, chunkIndex, round_number, field, value, message }] }`. If `problems.length > 0`, block the database call and render the problem list.
- **Why**: Acts as a defense-in-depth contract test in the browser so no malformed JSON payload can ever create an orphan open batch in the database.
- **Alternatives Considered**:
  - *Relying only on parser checks*: Rejected because category mapping or chunk assembly happens after initial CSV parsing; a final pre-flight check on the exact RPC payload guarantees zero drift.

### Decision 3: Single Unified Combobox for Student Selection
- **Chosen Approach**: A single custom searchable picker component (button trigger showing the selected student + dropdown panel with a search input and keyboard/click selectable student rows) backed by the hidden student ID value.
- **Why**: Eliminates the confusing UX of an empty search input sitting above a separate native `<select>` where typing filters the `<select>` without opening it.
- **Alternatives Considered**:
  - *HTML `<input list="...">` datalist*: Rejected because browser `<datalist>` styling is inconsistent, cannot cleanly separate `student_id` UUID values from display labels, and behaves poorly on mobile Safari/Chrome.

---

## 4. Technical Architecture & Data Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        1. CSV PARSER (js/importParser.js)                  │
│  • Detects blocks, headers, categories, rounds, dates, cells & summaries   │
│  • Enforces cell time <= 14,400s (4:00:01 -> unreadable cell)              │
│  • Flags Time Taken > 28,800s (8:00:01 -> warning + null on import)        │
│  • Truncates round_type > 40 chars & note > 500 chars with warnings        │
│  • Emits duplicate-date info lines & strict Marks TO BE CORRECTED check    │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                   2. PLANNER & VALIDATOR (js/importPlan.js)                │
│  • Resolves series per block, category mappings, and DB comparison         │
│  • Excludes rounds outside date range [2020-01-01 .. today_ist()]          │
│    or round_number outside [1 .. 100000] (listed as Excluded)              │
│  • Nullifies time_taken_seconds > 28,800 in planned payload                │
│  • Chunks into <= 100 rounds & <= 3,000 cells per RPC call                 │
│  • Runs validatePayload(payload) returning { round_number, field, value }  │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     3. IMPORT UI & RPC RUNNER (js/import.js)               │
│  • Unified Student Picker, formatted stat cards (1,677 · Sep),             │
│    grouped Needs Attention with left-aligned text & "Show info lines"      │
│  • Pre-flight check: if validatePayload finds issues, halts before DB      │
│  • On DB RPC error: shows exact DB error, plain-English safety note,       │
│    and expandable "Technical details" (step, series, rounds, first 3)      │
└────────────────────────────────────────────────────────────────────────────┘
```

### Verification & Test Plan (`node:test`)
- `59:23:00` Time Taken produces a warning, sets `time_taken_seconds = null` in the planned payload, and does not block the round.
- `8:00:00` (`28,800s`) Time Taken is accepted as `28800`; `8:00:01` (`28,801s`) triggers the >8h warning and nullifies `time_taken_seconds`.
- Cell time `4:00:00` (`14,400s`) is accepted; `4:00:01` (`14,401s`) is marked `unreadable`.
- Round dates after `today_ist()` and before `2020-01-01` are excluded from the import payload and listed as excluded.
- A `round_type` of 41 characters is truncated to 40 characters with a warning; a `note` of 501 characters is truncated to 500 characters with a warning.
- `validatePayload` catches and names the exact `round_number`, `field`, and `value` for every broken rule.
- A 101-round block is split into 2 valid chunks (`100` rounds + `1` round).
- Duplicate dates in a block emit `info` items in `needsAttention`, and `evaluateMarksCrossCheck` reports `MISMATCH` when `sheetValue (177) !== sum(total) - sum(correct) (178)`.
