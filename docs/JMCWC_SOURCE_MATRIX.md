# JMCWC Simulator — Phase 17a Source Matrix, Extracted 2025 Rules & Verification Report

## 1. Source File Inspection Status

| Source File | Workspace Status | Action Taken |
| :--- | :--- | :--- |
| `JMCWC Rules 2025.pdf` | **Read & Verified** (uploaded to `/public/assets/aistudio/JMCWC_Rules_2025_058f3e39.pdf`) | Extracted all 15 official rules (Section 2 below) and **moved out of `/public/` to `/docs/sources/JMCWC_Rules_2025.pdf`** so it is excluded from browser bundles and public deployment assets. |
| `JMCWC-2026-Simulator-Juniors-1.xlsx` | **Not present in workspace** (dropped by AI Studio's `.xlsx` file filter) | Configured Google Drive & Sheets OAuth (`SCOPES`) + `/api/jmcwc-drive-sync` on `/pages/import.html` so the `.xlsx` files can be imported directly from Google Drive or uploaded into `/docs/sources/`. |
| `JMCWC-2026-Simulator-Juniors-2.xlsx` | **Not present in workspace** (dropped by AI Studio's `.xlsx` file filter) | Configured Google Drive & Sheets OAuth (`SCOPES`) + `/api/jmcwc-drive-sync` on `/pages/import.html`. |
| `JMCWC-2026-Simulator-Seniors.xlsx` | **Not present in workspace** (dropped by AI Studio's `.xlsx` file filter) | Configured Google Drive & Sheets OAuth (`SCOPES`) + `/api/jmcwc-drive-sync` on `/pages/import.html`. |

### Folders & Paths Checked in Container
- `/` (workspace root `/app/applet`)
- `/docs/` and `/docs/sources/`
- `/public/` and `/public/assets/aistudio/`
- `/.aistudio/` and `/.aistudio/artifacts/brain/3cd1add8-9b48-4be5-a19e-545186550e09/.tempmediaStorage/`
- `/api/`, `/js/`, `/pages/`, `/shared/`, `/supabase/`, `/tests/`

Because the three `.xlsx` files were filtered out by the AI Studio file tree uploader and have not yet been synced via the new Google Drive / `.xlsx` importer on `/pages/import.html`, **all three group blueprints (`junior1`, `junior2`, `senior`) remain `published: false` (`source_verified: false`)** in accordance with your strict governance rule (*"If files are still inaccessible, report the exact filenames and folders you checked. Do not guess question counts, marks or generator parameters"*).

---

## 2. Extracted Rules from `JMCWC Rules 2025.pdf` (Verified Source Rules)

Extracted directly from `JMCWC Rules 2025.pdf` (`https://www.juniormentalcalculators.com/`):

1. **General Conduct & Answer Clarity (Rules 1–7, 9)**:
   - Tasks may be answered in any order; tasks may be skipped (`verdict: 'skipped'`, `award: 0`).
   - Unclear or malformed answers are marked wrong (`verdict: 'wrong'`, `award: 0`).
2. **Digit-Counting Marks (Rule 8)**:
   - Small digit-counting marks or commas in integer answers are permitted.
   - Official PDF examples for `12345678` (all three must be accepted as full marks):
     - `1234|56|78`
     - `12345678`
     - `12,345,678`
   - *Generator/Grader Verification*: `parseStrictBigInt` in `/api/_jmcwcGrade.js` and `parseStudentDecimal` in `/api/_jmcwcMath.js` accept plain digits, comma-grouped thousands, and `|` digit-counting bars.
3. **Decimal Places & Rounding Policy (Rule 10)**:
   - Tasks such as currency and inexact square roots require the answer to a specific number of decimal places (`d.p.`).
   - Writing extra decimal places (when the extra decimal places accurately round the true value) or rounding the last digit the wrong way awards **half marks** (`verdict: 'partial'`, `award: max_marks / 2`).
   - Official PDF example — $\sqrt{567}$ to 1 d.p. (precise answer `23.8117618...`):
     - `23.8` $\rightarrow$ **full marks** (`correct`)
     - `23.81` $\rightarrow$ **only half marks** (`partial` — too precise)
     - `23.9` $\rightarrow$ **only half marks** (`partial` — incorrect rounding)
     - `23.7` or `23.79` $\rightarrow$ **no marks** (`wrong`)
4. **Fractions (Rule 11)**:
   - Fractions must be written as **mixed fractions in their simplest form**.
   - Official PDF example:
     - `1 3/7` ($1\frac{3}{7}$) $\rightarrow$ **correct**
     - `10/7` ($\frac{10}{7}$, improper) $\rightarrow$ **wrong**
     - `1 30/70` ($1\frac{30}{70}$, unreduced) $\rightarrow$ **wrong**
5. **Calendar Tasks (Rule 12)**:
   - Write either the **full name** of the day/month or a **three-letter abbreviation**, in **German or in English**.
   - If several months could be a correct answer to a task, write **only one** of these months.
   - *Grader Verification*: `parseWeekdayInput` and `parseSingleMonthInput` in `/api/_jmcwcMath.js` strictly enforce full names or 3-letter abbreviations in English (`Sunday..Saturday`, `Sun..Sat`, `January..December`, `Jan..Dec`) and German (`Sonntag..Samstag`, `Son/Mon/Die/Mit/Don/Fre/Sam`, `Januar..Dezember`, `Jan/Feb/Mär/Mar/Apr/Mai/Jun/Jul/Aug/Sep/Okt/Nov/Dez`) and reject 2-letter/4-letter non-standard forms or multi-month answers.
6. **Prime Factors Tasks (Rule 13)**:
   - Write each prime factor the required number of times, in any order.
   - Official PDF examples for $40 = 2^3 \times 5$ (all three must be accepted):
     - `5, 2, 2, 2`
     - `5 × 2 × 2²`
     - `2³, 5`
7. **Sums of Squares Tasks (Rule 14)**:
   - Write the **2, 3, or 4 integers** whose squares have the correct sum. Do not write the squared numbers, otherwise zero marks are awarded.
   - Official PDF examples for sum of squares to `150`:
     - Correct answers: `10, 5, 5` or `12² + 2² + 1² + 1²`
     - Too many squares (zero marks): `10, 4, 4, 3, 3` (5 squares)
     - Unacceptable formats (zero marks): `100, 25, 25` or `144 + 4 + 1 + 1` (pre-squared numbers)
8. **Missing Information Tasks (Rule 15)**:
   - Students may record either the **full answer** or **only the missing figure(s)**.

---

## 3. Canonical 23-Category Matrix (Awaiting `.xlsx` Workbook Cell Extraction)

| # | Database `category_key` | Title | Visible Workbook Sheet | Verified 2025 PDF Rule Applied | Workbook Slot Parameters & Broken Refs Status |
| :- | :--- | :--- | :--- | :--- | :--- |
| 1 | `addition` | Integer addition | `Int Adds` | Rules 8, 15 | Awaiting `.xlsx` via Google Drive / server sync |
| 2 | `subtraction` | Integer subtraction | `Int Subs` | Rules 8, 15 | Awaiting `.xlsx` via Google Drive / server sync |
| 3 | `mixed` | Mixed addition and subtraction | `Mixed adds+subs` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 4 | `multiplication` | Integer multiplication | `Int Mults` | Rules 8, 15 | **Broken refs `H7`, `H12` & upstream cells** — awaiting `.xlsx` |
| 5 | `division` | Integer division | `Int Divs` | Rules 8, 15 | Awaiting `.xlsx` via Google Drive / server sync |
| 6 | `brackets` | Brackets | `Brackets` | Rule 8 | **Broken ref `B43`** — awaiting `.xlsx` |
| 7 | `prime_factors` | Prime factorisation | `Primes` | Rule 13 (`5, 2, 2, 2`, `5 × 2 × 2²`, `2³, 5`) | Awaiting `.xlsx` via Google Drive / server sync |
| 8 | `hcf_lcm` | HCF and LCM | `HCF LCM` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 9 | `fraction_add` | Fraction addition | `Fraction Additions` | Rule 11 (`1 3/7` valid; `10/7`, `1 30/70` rejected) | Awaiting `.xlsx` via Google Drive / server sync |
| 10 | `fraction_sub` | Fraction subtraction | `Fraction Subtractions` | Rule 11 | Awaiting `.xlsx` via Google Drive / server sync |
| 11 | `fraction_mul` | Fraction multiplication | `Fraction Multiplications` | Rule 11 | **Broken ref `BD229` & dependencies** — awaiting `.xlsx` |
| 12 | `fraction_div` | Fraction division | `Fraction Divisions` | Rule 11 | Awaiting `.xlsx` via Google Drive / server sync |
| 13 | `approximation` | Approximations | `Approximations` | Rules 8, 10 | Awaiting `.xlsx` via Google Drive / server sync |
| 14 | `remainder` | Remainders | `Remainders` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 15 | `ratio` | Ratios | `Ratios` | Rules 8, 15 | Awaiting `.xlsx` via Google Drive / server sync |
| 16 | `square_root` | Perfect square roots | `Perfect Square Roots` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 17 | `inexact_square_root` | Inexact square roots | `Irrational Square Roots` | Rule 10 (`sqrt(567)` to 1 d.p.) | Awaiting `.xlsx` via Google Drive / server sync |
| 18 | `next_square` | Next squares | `Next Squares` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 19 | `cube_root` | Exact cube roots | `Cube Roots - Exact` | Rule 8 | **Broken ref `S51`** — awaiting `.xlsx` |
| 20 | `next_cube` | Next cubes | `Next Cubes` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 21 | `calendar` | Calendars | `Calendars` | Rule 12 (EN/DE full or 3-letter, single month) | Awaiting `.xlsx` via Google Drive / server sync |
| 22 | `elapsed_time` | Elapsed time | `Times Elapsed` | Rule 8 | Awaiting `.xlsx` via Google Drive / server sync |
| 23 | `sum_squares` | Sums of squares | `Sums of Squares` | Rule 14 (`150`: `10, 5, 5`, `12² + 2² + 1² + 1²`) | Awaiting `.xlsx` via Google Drive / server sync |
