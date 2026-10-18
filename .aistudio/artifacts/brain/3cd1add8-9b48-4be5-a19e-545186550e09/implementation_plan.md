# Phase 4c-1: Admin CSV Score Sheet Import (Part 1 — Read-Only Preview & Parser)

This phase introduces a read-only CSV score sheet parser and interactive preview console (`/pages/import.html`) for administrators, enabling them to inspect historical multi-block student competition sheets, verify automatic date/score/time cross-checks, and configure category mappings entirely in the browser before any database write logic is introduced in Part 2.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **Strict Read-Only Guarantee (Part 1 Scope)**
> - **Zero Database Mutations**: This step performs **no** `INSERT`, `UPDATE`, `DELETE`, or write RPC calls. It does not create categories or save rounds/results.
> - **Read-Only Queries Only**: The page reads only `profiles` (`role = 'student'`) for student selection, `categories` (`section = 'round'`, both active and inactive) for category matching, and `today_ist()` for Indian Standard Time future-date validation. It does **not** query existing `rounds` or `results`.
> - **Client-Side Parsing Only**: CSV files (up to 2 MB) are read via `FileReader` in the browser and never uploaded to a server.
> - **XSS Prevention via `textContent`**: Every string originating from the CSV file (student names, level labels, category names, round headers, cell text, notes, and stray values) is rendered strictly using `textContent` and DOM node construction—never `innerHTML`.

---

## 1. Overview & Core Concept

### What It Does
1. **Step 1 — Student & File Selection (`/pages/import.html`)**:
   - Searchable student picker (by student name or student code/ID).
   - `.csv` file selector enforcing a `.csv` extension/MIME check and a maximum file size of **2 MB** (`2,097,152` bytes), displaying the explicit notice: *"The file is read in your browser and is not uploaded."*
   - Date format selector: **Auto (default)**, **DD/MM**, or **MM/DD**.
   - In Demo Mode (`localhost` and `*.run.app` when Supabase is unconfigured), provides a one-click **"Load Sample Fixture Preview"** button using the synthetic multi-block test fixture.
2. **Hand-Written CSV & Multi-Block Sheet Parser (`js/importParser.js`)**:
   - Pure JavaScript module with zero DOM dependencies and zero `import.meta.env` references so it runs identically in browser ES modules and `node --test`.
   - Parses raw CSV text handling UTF-8 BOM, CRLF/LF line endings, quoted fields, escaped quotes (`""`), commas and newlines inside quotes, and ragged rows padded to the widest row plus spare columns.
   - Dynamically locates side-by-side blocks by scanning for the header row containing `Category` cells (case-insensitive) and `Round <N>` columns (`/^round\s*(\d+)$/i`), without hard-coding row or column indices.
3. **Step 2 — Interactive Diagnostic Preview**:
   - **"Needs Attention" Triage Panel**: Consolidated top-level alert list grouping every cross-check mismatch, date error/warning, stray cell value, and unreadable score/time cell by block and round, complete with spreadsheet coordinate badges (e.g., `O10`) and raw text.
   - **Overview Summary Cards**: Blocks detected, rounds per block, date range per block, total cells (`ok`, `empty`, `unreadable`, `stray`), file student name vs. selected student comparison (non-blocking warning if different), level labels seen, and resolved date format.
   - **Per-Block Inspector**:
     - Series name text input (defaults to `"Block 1 (left)"`, `"Block 2"`, etc.) and non-assigned block label hints (e.g., `"NEW SIMULATOR"`).
     - Interactive Category Mapping table for unmatched categories (*Map to existing round category*, *"Create as a new historical category" (inactive)*, or *"Skip this category"*) plus an informational list of database round categories absent from the block.
     - Round-by-round verification table displaying Round #, Date, Round Type, Time Taken (`h:mm:ss` or `—`), cells OK count, interactive Cross-Check Chips (*Final Score*, *Total Attempt*, *Marks*) that reveal sheet vs. computed sums and differences on tap/click, Date Flags, and expandable row details showing every cell's coordinate (`A1`–`EX99`), raw text, parsed values, and status reason.
   - **Action Bar**: Disabled **"Import"** button (`"Import is added in the next step"`) and an active **"Start over"** button to reset the workflow.

---

## 2. User Experience & Visual Design

### Layout & Visual Architecture
- **Aesthetic & Tokens**: Uses only the existing CSS custom properties in `/css/variables.css` and shared layout classes in `/css/style.css` (consistent with *Overview*, *Review*, *Targets*, and *Weekly Tests*).
- **Navigation Integration**: Adds `Import` to the **Setup** dropdown menu across all admin pages (`admin.html`, `review.html`, `students.html`, `attendance.html`, `weekly-tests.html`, `todos.html`, `resources.html`, `categories.html`, `rounds.html`, `targets.html`, `student-detail.html`, and `import.html`).
- **Tabular Alignment**: All spreadsheet coordinates (`O10`), round numbers, dates (`YYYY-MM-DD`), scores (`75/75`), times (`01:08:37`), and cross-check deltas use `tabular-nums` (`.num`) for vertical alignment.

### Preview Screen Structure
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top Bar: 🧮 Trendz Tracker │ Overview Review Students ... [Setup ▾ -> Import]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Step 1: Select Student, CSV File (Max 2 MB) & Date Format (Auto/DD-MM/MM-DD) │
│ 🔒 "The file is read in your browser and is not uploaded."                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⚠️ NEEDS ATTENTION (Grouped by Block & Round)                                │
│ • Block 2 · Round 1: Final Score MISMATCH (Sheet: 250, Sum: 255, Diff: +5)   │
│ • Block 2 · Stray value at O10: "94/231" (not in a category row — ignored)   │
│ • Block 1: Unmatched categories ("Calender" → matched via alias; etc.)       │
├──────────────────┬──────────────────┬───────────────────┬────────────────────┤
│ Blocks & Rounds  │ Date Ranges      │ Cell Status Breakdown│ Student & Format│
│ 2 Blocks (2, 3)  │ Aug 17 – Aug 21  │ 22 OK · 3 Empty · 1 Stray│ TEST STUDENT│
├──────────────────┴──────────────────┴───────────────────┴────────────────────┤
│ BLOCK 1                                                                      │
│ Series Name: [ Block 1 (left)      ]   Hints in header: (none)               │
│ Category Mapping: ADD ✓, SUB ✓, Calender → Calendar (alias) ✓, ...           │
│ Absent DB Categories (Info): Currency, Missing Figures, ...                  │
│ ┌─────────┬────────────┬────────────┬──────────┬────────┬──────────────────┐ │
│ │ Round # │ Date       │ Round Type │ Time     │ Cells  │ Cross-Checks     │ │
│ ├─────────┼────────────┼────────────┼──────────┼────────┼──────────────────┤ │
│ │ Round 2 │ 2026-08-21 │ Flat Round │ 01:08:37 │ 4 OK   │ [Score✓][Att✓]...│ │
│ │   └─ ▶ Expand 5 cells (D5: 75/75, D6: 89/89, D9: ...... empty, ...)      │ │
│ └─────────┴────────────┴────────────┴──────────┴────────┴──────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Start over]                     [Import (Import is added in the next step)] │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Separating the Read-Only Preview (4c-1) from Database Saving (4c-2)
- **Chosen Approach**: Build and verify the complete CSV parser, coordinate tracker, cross-check math, and category mapping UI as a strictly read-only preview first.
- **Why**: Historical competition spreadsheets contain human data-entry quirks—typos in category names (`"Calender"`), stray values below category rows (`94/231` at `O10`), hand-calculated `Final Score` arithmetic mistakes (`250` written instead of `255`), and mixed date formats. Separating preview from persistence lets admins inspect every anomaly and verify parser accuracy with zero risk of polluting production tables.
- **Alternatives Considered**: One-step upload-and-insert with rollback on error. Rejected because silent arithmetic mismatches or unmapped categories require human judgment before committing.

### Decision 2: Dynamic Header & Block Detection Instead of Fixed Column Indices
- **Chosen Approach**: Scan rows dynamically to locate the header row containing `Category` cells, partition the sheet horizontally into blocks bounded by each `Category` column (and its left-adjacent `INDEX` column), and discover `Round <N>` pairs (`scoreCol`, `timeCol = scoreCol + 1`) within each block.
- **Why**: Real student tracking sheets evolve over time—new simulator blocks are pasted side-by-side with varying column gaps, older blocks have different category rows than newer blocks, and extra blank columns or placeholder headers (`Round0`) appear unpredictably. Hard-coding column letters or row numbers would break on every variation.
- **Alternatives Considered**: Requiring admins to reformat sheets into a rigid single-table template before import. Rejected because reformatting hundreds of historical rounds manually is error-prone and defeats the purpose of importing existing sheets.

### Decision 3: Identifying Rounds by `(block, roundNumber)` Instead of `roundNumber` Alone
- **Chosen Approach**: Treat every round as scoped to its parent block `(blockIndex, roundNumber)`, paired with a user-editable block series name (e.g., `"Block 1 (left)"`, `"Block 2"`).
- **Why**: When a student transitions to a new simulator or sheet block, their round counter restarts at `Round 1`. Identifying rounds globally by number alone would cause `Round 1` and `Round 2` in Block 2 to collide with or overwrite `Round 1` and `Round 2` in Block 1.

---

## 4. Technical Architecture & Data Strategy

### System & Data Flow Diagram
```
┌─────────────────────────────────────────────────────────────────────────┐
│                         /pages/import.html                              │
│   Step 1: Student Picker + .csv Input (≤2MB) + Date Format Selector     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ FileReader.readAsText()
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       js/import.js (UI Controller)                      │
│  • Reads profiles (role='student'), categories (section='round'),       │
│    and today_ist() via Supabase (or js/demoDb.js in Demo Mode)          │
│  • Invokes parseScoreSheetCsv(csvText, { roundCategories, ... })        │
│  • Renders DOM nodes strictly via document.createElement & textContent  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Pure Data Call
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 js/importParser.js (Pure Node/Browser ES)               │
│  1. parseCsvGrid(text)        -> Ragged-padded 2D array, BOM/quote-safe │
│  2. colLabel(colIdx)          -> 0='A', 25='Z', 26='AA', 153='EX'       │
│  3. Detect Header & Blocks    -> Split by 'Category' cols; find Round N │
│  4. Resolve Dates             -> Auto DD/MM vs MM/DD, mixed check       │
│  5. Parse Category & Summary  -> Score ratios, m:ss / h:mm:ss, stray    │
│  6. Run Per-Round CrossChecks -> Sum(correct) vs Final, Sum(total) vs   │
│                                  Attempt, (Attempt - Final) vs Marks    │
│  7. Run Per-Block Date Checks -> Chronology, duplicates, >today_ist,    │
│                                  <2020-01-01, missing/unreadable        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Parser Specification & Edge-Case Rules (`js/importParser.js`)

1. **Spreadsheet Coordinates (`colLabel(index)`)**:
   - Converts 0-based column index to base-26 spreadsheet letters (`0 → A`, `25 → Z`, `26 → AA`, `153 → EX`). Combined with 1-based row index (`rowIdx + 1`) to form cell references like `O10`.

2. **Header, Block & Metadata Discovery**:
   - **Header Row**: The row containing one or more cells whose trimmed text equals `"Category"` (case-insensitive). If none exists, returns `{ error: 'Layout not recognised: no "Category" header found.' }`.
   - **Block Boundaries**: Each `"Category"` cell at column $c$ starts a block. Its `indexCol` is $c - 1$ (if $c > 0$). The block spans from column $c$ up to `nextBlock.categoryColumn - 2` (just before the next block's `INDEX` column) or the right edge of the grid.
   - **Top Metadata Rows (above Header Row)**:
     - Cells starting with `"Name"` (case-insensitive): strip leading `"Name"`, dashes (`-`, `—`), colons (`:`), and whitespace. If multiple name cells exist and differ (case-insensitive), emit a global warning with both names and their cell references.
     - Cells matching `/^junior/i`: recorded in `levelLabels`.
     - Other non-empty cells in the top rows (not starting with `"Name"`, not matching `/^junior/i`, e.g., `"NEW SIMULATOR"`): collected as `labelHints` with their cell reference, never auto-assigned as the block's series name.
   - **Round Columns**: Within each block's header row, cells matching `/^round\s*(\d+)$/i` define a round column pair (`scoreCol = col`, `timeCol = col + 1`).
     - Placeholder rounds like `Round0` (or any round header that has **no date** and **no scores/times** in any row below) are ignored and reported as an informational message in `warnings` / `globalWarnings` (with cell reference).
     - If no valid round headers exist in any block, returns `{ error: 'Layout not recognised: no round headers found.' }`.

3. **Date Detection & Block Chronology**:
   - Scans rows between the header row and the Score-label row / first category row in each round's `scoreCol` using `/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/` (allowing prefixes like `"Date-"` or `"Date -"`). Two-digit years map to `2000 + yy`.
   - **Auto Format Resolution**: Inspects all raw date triples across the sheet:
     - Any first number $> 12 \implies$ `DD/MM`.
     - Any second number $> 12 \implies$ `MM/DD`.
     - If both occur across the file $\implies$ global error `"dates are mixed"` (with offending cell references).
     - If neither $> 12$ (ambiguous) $\implies$ defaults to `DD/MM` with a global warning.
     - Admin explicit override (`DD/MM` or `MM/DD`) supersedes Auto; any date whose resulting month is outside `1..12` or day is invalid for that month/year is marked unreadable for that round.
   - **Per-Block Date Checks** (sorted ascending by `roundNumber`):
     - **Blocked (Error)**: Missing date, unreadable date, or `dateISO > todayIST`.
     - **Warning**: Later `roundNumber` has an earlier `dateISO` than a preceding round (lists the conflicting rounds and dates).
     - **Warning**: `dateISO < '2020-01-01'`.
     - **Info**: Two or more rounds in the same block share the exact same `dateISO`.

4. **Category Matching, Cell Reading & Stray Detection**:
   - **Summary Row Recognition**: A row below the Score-label row is a summary row for a block if its `Category` cell (`c`) or `INDEX` cell (`c - 1`) matches `/round\s*type|time\s*taken|final\s*score|total\s*attempt|marks\s*to\s*be\s*corrected/i`.
   - **Category Rows**: Rows below the Score-label row where the block's `Category` cell is non-empty and not a summary label. If no category rows exist, returns `{ error: 'Layout not recognised: no category rows found.' }`.
   - **Category Matching (Per Block)**: Normalized key = `name.toLowerCase().replace(/\s+/g, '')`. Built-in aliases map `"calender" → "calendar"` and `"timeelapse" → "timeelapsed"`. Matched against the passed database `round` categories by normalized key.
   - **Stray Values**: In any row below the Score-label row that is neither a category row nor a summary row for that block (for example, row 10 below `Surprise Task` in Block 2), any non-empty cell in a round's `scoreCol` or `timeCol` (that isn't purely dots/dashes/spaces) is reported as a `"stray value"` warning with its exact sheet reference (e.g., `O10` with `"94/231"`) and excluded from round totals.
   - **Score & Time Cells**:
     - Empty or only dots/dashes/spaces (`/^[.\-\s]*$/`) $\implies$ `status: 'empty'` (skipped silently; if `timeCol` has a value while `scoreCol` is empty, emit a warning `"Time without a score"` at `timeRef`).
     - Ratio `/^(\d+)\s*\/\s*(\d+)$/` $\implies$ parse `correct` and `total`. If `total === 0` or `correct > total`, mark `status: 'unreadable'` with reason.
     - **Surprise Task (`/^surprise\s*task$/i`)**: If it matches a ratio (`379/384`), treat as a normal `status: 'ok'` score and include in cross-check sums. If it contains other non-empty text (not just dots/dashes/spaces), store as `status: 'note'` with `note: rawText` and no numbers.
     - **Time Cell (`timeCol`)**:
       - `m:ss` or `mm:ss` (`/^\d{1,2}:\d{2}$/` with seconds $< 60$) $\implies$ `minutes * 60 + seconds`.
       - `h:mm:ss` (`/^\d{1,2}:\d{2}:\d{2}$/` with minutes $< 60$, seconds $< 60$) $\implies$ `hours * 3600 + minutes * 60 + seconds`.
       - Plain numbers (e.g., `"75"`) or any other non-empty text $\implies$ unreadable time warning with sheet reference (never guessed).

5. **Summary Rows & Cross-Checks**:
   - **Round Type**: Stored as trimmed text.
   - **Time Taken**: Parsed from `h:mm:ss` or `m:ss` into seconds; text matching `/without\s*time/i` sets `timeTakenSeconds = null` (`withoutTime: true`) with no warning; any other non-empty text emits an unreadable summary warning.
   - **Final Score, Total Attempt, Marks TO BE CORRECTED**: Parsed as integers (unreadable non-integer text emits a warning).
   - **Three Cross-Checks per Round** (summing across all categories in the block, including numeric Surprise Task ratios):
     1. `sum(correct)` vs `Final Score`
     2. `sum(total)` vs `Total Attempt`
     3. `(Total Attempt - Final Score)` vs `Marks TO BE CORRECTED` (evaluated against the sheet's Final Score & Total Attempt when present, or computed sums if sheet values are absent).
     - If the round has any `unreadable` cell (or unreadable summary integer for that check), the check status is `INCOMPLETE`.
     - Otherwise, if the summary value is missing, status is `NOT PRESENT`; if equal, `OK`; if different, `MISMATCH` recording `sheetValue`, `computedValue`, and `diff`.

### Automated Unit Testing (`tests/importParser.test.js`)
- Executed via `node --test tests/importParser.test.js`.
- Verifies the exact synthetic 2-block fixture from the specification plus all required edge cases (`"75"` time unreadable, `"95/90"` score unreadable, quoted fields with commas/newlines, missing round headers error, out-of-order round dates warning, duplicate dates info, mixed `21/8/26` + `8/21/26` error, and `colLabel(0) = 'A'`, `colLabel(26) = 'AA'`, `colLabel(153) = 'EX'`).
