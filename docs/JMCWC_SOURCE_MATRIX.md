# JMCWC Simulator — Comprehensive Source Matrix & Verification Report

**Document Version:** 1.0 (Phase 17a Complete Source Verification)
**Date:** 2026-11-02
**Status:** Fully Verified against authentic sources on disk:
- `docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx` (2.3 MB, 27 sheets, 23 visible)
- `docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx` (2.4 MB, 27 sheets, 23 visible)
- `docs/sources/JMCWC-2026-Simulator-Seniors.xlsx` (2.4 MB, 27 sheets, 23 visible)
- `docs/sources/JMCWC_Rules_2025.pdf` (94 KB, 15 official contest rules & examples)

## 1. Executive Summary & Paper Topology

| Group | Source Workbook | Total Sheets | Visible Categories | Total Questions | Cached Snapshot Marks | Status |
|---|---|---|---|---|---|---|
| **Junior 1** (`junior1`) | `JMCWC-2026-Simulator-Juniors-1.xlsx` | 27 (4 hidden) | 23 | **440** | 2,310 | **Verified & Validated** |
| **Junior 2** (`junior2`) | `JMCWC-2026-Simulator-Juniors-2.xlsx` | 27 (4 hidden) | 23 | **445** | 2,469 | **Verified & Validated** |
| **Senior** (`senior`) | `JMCWC-2026-Simulator-Seniors.xlsx` | 27 (4 hidden) | 23 | **446** | 2,595 | **Verified & Validated** |

### 1.1. Fixed vs. Dynamic Scoring Analysis & Upstream Dependency Graph

Across all 23 categories in the three workbooks, an exhaustive trace of every mark formula and its upstream cell dependency tree reveals that:

1. **19 Categories are strictly FIXED (Type A):**
   - **Categories:** `addition`, `subtraction`, `mixed`, `division`, `brackets`, `hcf_lcm`, `fraction_add`, `fraction_sub`, `fraction_mul`, `fraction_div`, `remainder`, `ratio`, `square_root`, `inexact_square_root`, `next_square`, `cube_root`, `next_cube`, `calendar`, `elapsed_time`.
   - **Formula Proof:** In each of these 19 categories, mark formulas reference only fixed slot parameters (levels, digits, adjustments) or variables where random operands mathematically cancel out:
     - `subtraction`: `AH5 = INT(LOG(AB5+0.5))+1`. Since minuend `AB5` has exactly `AA5` digits by construction, `INT(LOG(AB5+0.5))+1` is identically equal to `AA5` for all random numbers. The mark is strictly fixed at `AA5 + M5`.
     - `remainder`: `AK6 = AI6 + AJ6 - 1 = Y6 + Z6 - 1`. Because `Z6 = V6 - Y6`, the random number `Y6` cancels out completely (`Y6 + (V6 - Y6) - 1 = V6 - 1`), yielding a constant mark equal to the level setting.
     - `next_square`: `AI8 = INT(LOG(AD8+0.05))`. Radicand `AD8` is in $[10^{V8}, 10^{V8+1}-1]$, so `LOG` is in $[V8, V8+1)$, evaluating identically to `V8` for all generated numbers.
     - `next_cube`: `AI7 = INT(LOG(AD7+0.05))` evaluates identically to fixed level `V7`.
     - All other 15 categories reference fixed table constants or slot adjustment cells.

2. **4 Categories are dynamically score-calculated (Type B):**
   - **`multiplication` (`04_Int_Mults`):** `BD8 = INT(BD7^0.75 + 0.35)` where `BD7 = d1 * d2` (`mark_rule: "multiplication_digits_product"`). When the total digit count can be partitioned unevenly (e.g., 7 digits into 4×3 digits vs 5×2 digits), the mark varies between 5 and 6 points based on the randomly chosen partition.
   - **`prime_factors` (`07_Primes`):** `G9 = INT(CA6 * 1.2)` where `CA6` looks up composite product `BZ6` in valuation table `$Q$16..$R$27` (`mark_rule: "prime_factors_target_scale"`, `mark_range: [3, 10]`).
   - **`approximation` (`15_Approximations`):** In slots 1..6 (`nearest_int_mul`, `BV{r} = (BU{r} + BU{r}^2)/2 + 1`) and slots 11..16 (`nearest_int_div`, `AV{r} = (AU{r} + AU{r}^2)/2 + 1`), marks depend on the digit count of the rounded integer answer (`mark_rule: "approximation_product_digits"`, `mark_range: [2, 16]`). Slots 7..10 (`sig_figs_4_mul`) and 17..20 (`sig_figs_4_div`) are strictly fixed at 11 marks.
   - **`sum_squares` (`25_Sums_of_Squares`):** In Junior 1, `G{r} = L{r} + M{r} - 2` (`mark_rule: "sum_squares_j1_decomposition"`, `mark_range: [2, 6]`). In Junior 2 and Senior, `G{r} = AJ{r} + J{r}` depends on the generated target magnitude (`mark_rule: "sum_squares_j2_target"` and `"sum_squares_sr_target"`, `mark_range: [2, 10]`).

### 1.2. Critical Terminology & Distinction

- **Cached Workbook Example Total:** The static sum recorded in the author's original Excel snapshot (Junior 1: **2,310**, Junior 2: **2,469**, Senior: **2,595**). These represent a single valid evaluation of the dynamic formulas saved in the workbook file at the time of authoring. They are preserved in `paper.spec.total_cached_marks` as historical reference.
- **Fixed Blueprint Slots:** Slots where `parameters.scoring_mode` is `"fixed"` (or omitted), with no `mark_rule` or `mark_range`, and where generated question `max_marks` must equal blueprint `max_marks`.
- **Dynamic Blueprint Slots:** Slots where `parameters.scoring_mode = "dynamic"`, `parameters.mark_rule` is a recognized rule name, and `parameters.mark_range = [min, max]`. Scoring metadata is placed strictly inside `slot.parameters`, never at the slot top level.
- **Maximum Marks for a Particular Generated Attempt:** In live generation, the trusted server generator computes each question's exact `max_marks` from the generated operands using registered pure scoring functions (`DYNAMIC_SCORING_RULES`), validates containment in `parameters.mark_range`, and freezes that integer mark into the persisted question payload at attempt creation. The attempt's maximum marks are derived by summing the persisted question `max_marks`.

### 1.3. Deployed Database Contract & Actual RPC / Guard Functions

The database schema and validation contract enforce fixed and dynamic slots via the nine owner-deployed JMCWC database functions:
1. `jmcwc_assignment_guard()`
2. `jmcwc_paper_guard()`
3. `jmcwc_check_student(uuid)`
4. `jmcwc_tick(uuid)`
5. `jmcwc_create_attempt(uuid,uuid,uuid,text,text,jsonb)`
6. `jmcwc_act(uuid,uuid,text,uuid,bigint,jsonb)`
7. `jmcwc_list(uuid,integer)`
8. `jmcwc_finalize(uuid,uuid,bigint,jsonb)`
9. `jmcwc_validate_marks(text,jsonb,numeric)`

## 2. Broken Formula Investigations & Forensic Repairs

Across all 81 worksheets (27 sheets × 3 workbooks), formula errors (`#REF!` and `#VALUE!`) were present in only 4 visible sheets. Each was forensically analyzed across adjacent cells and all three workbooks:

### 2.1. Integer Multiplications (`04_Int_Mults`): `G5..H52`, `H7/H12`, and `AF16..AF70`
- **Issue:** `H7` contains `#REF!`, `G7` contains `IF(H7=15,AV16,AK16)` = `#REF!`, and every third generator row (`AF16, AF22, AF28, ...`) evaluates to `#REF!`.
- **Forensic Investigation:** The active paper layout contains exactly **20 printed questions** organized in two columns: Left (cols `C:D`, labeled `A1..A10` in `Q5..Q41`, Seq 1..10) and Right (cols `K:L`, labeled `B1..B10` in `Q7..Q43`, Seq 11..20). The sequence table in `W5..AB43` defines exactly 20 parameter rows.
- **Evidence:** Cell `D54` sums only Column D (`=SUM(D7:D52)`), cell `L54` sums only Column L (`=SUM(L7:L52)`), and cell `L56` ("Total value:") is `=L54+D54`. Middle Column `G:H` is completely omitted from the score sum (`H54 = 0`). Columns `F:H` and helper rows `AF16, AF22, ...` are unprinted remnants from an older 30-question 3-column layout whose parameter rows in `W:AB` were deleted by the workbook author.
- **Resolution:** The 20 printed questions in columns `C:D` and `K:L` are 100% intact, mathematically valid, and fully verified. Columns `F:H` and the orphaned `AF` rows are pruned from the blueprint.

### 2.2. Brackets (`06_Brackets`): `B43` and `CZ44`
- **Issue:** Question cell `B43` (slot 20) contains an `IF` chain where the branches for `AC43=5` and `AC43=8` reference `#REF!`. Cell `CZ44` contains `="("&#REF!&" + "&#REF!&#REF!&#REF!&" + "&#REF!&")"`.
- **Forensic Investigation:** In all three workbooks (`j1`, `j2`, `sr`), cell `AC43` has the fixed value **6**. Thus, `B43` evaluates the `DW43` branch and answer cell `P43` evaluates `DV43`, which are 100% intact and valid. The `#REF!` error is strictly in dormant branches of the conditional tree.
- **Evidence:** In slots 1..19 (`B5..B41`), display strings for subtype 5 (`CZ`) and subtype 8 (`GE`) are placed on the even row below each odd question row. In row 44, `GE44` is intact (`=GE43&GF43&GG43&GH43&GI43&GJ43&GK43&GL43&" + "&GN43&")"`). In row 43, cells `DA43`, `DC43`, `DD43`, `DE43`, `DG43` are all intact.
- **Resolution:** Repair `CZ44 = "("&DA43&" + "&DC43&DD43&DE43&" + "&DG43&")"`, and update `B43` to reference `CZ44` for `AC43=5` and `GE44` for `AC43=8`. All 8 subtypes (2..9) are now mathematically sound across all 20 slots.

### 2.3. Fraction Multiplications (`11_Fraction_Multiplications`): `BD229..HT239`
- **Issue:** Cells `BD229:HT239` contain `#REF!` errors.
- **Forensic Investigation:** Each question in this sheet occupies a 13-row vertical block. Exactly 17 question blocks are printed and numbered: Q1 at row 9, Q2 at row 22, ..., Q17 at row 217 (`AH9=1 .. AH217=17`). Cell `Z241` ("Total value:") sums `=SUM(Z9:Z228)` in Junior 1, and `=SUM(Z9:Z240)` in Junior 2/Senior (where rows 229..240 contain no printed cells, questions, answers, or marks).
- **Evidence:** Columns `B:P` (the printed question grid) and Columns `T:X` (the answer grid) in rows 229..239 are completely empty. Rows 229..239 in hidden columns `BC:HT` are orphaned prime-factorization helper rows from a deleted 18th question slot.
- **Resolution:** Confirm that `11_Fraction_Multiplications` has exactly 17 questions across all 3 groups. The orphaned hidden rows are excluded from the simulator.

### 2.4. Cube Roots - Exact (`21_Cube_Roots_-_Exact`): `S51`
- **Issue:** Cell `S51` contains `=#REF!+1`.
- **Forensic Investigation:** Column S is the sequence counter (`S7=1`, `S9=S7+1=2`, ..., `S49=22`). Cell `S51` lost its upstream reference to `S49`.
- **Evidence:** In row 51 (slot 23), the question radicand `C51 = [AB51]`, the integer root answer `G51 = [AA51]`, the mark `I51 = [T51]`, and all generator cells `T51:AB51` are 100% intact and valid. The total marks formula in `I53` is `=SUM(I7:I51)`, which explicitly sums all 23 questions.
- **Resolution:** Repair `S51 = S49 + 1` (= 23). The question count for `21_Cube_Roots_-_Exact` is verified as 23 slots.

## 3. Comprehensive Category Matrix (All 23 Categories)

### 1. Int Adds (`addition`)

- **Workbook Sheet:** `Int Adds`
- **Question Counts:** Junior 1: **18** slots | Junior 2: **18** slots | Senior: **18** slots
- **Total Cached Marks:** Junior 1: **75** | Junior 2: **95** | Senior: **123**
- **Generator:** `addition`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..18 | Q1: {subtype:standard,terms:3,level:0,adjustment:0,total_digits:2,d1_range:[0,0],scoring_mode:fixed}<br/>Q18: {subtype:standard,terms:3,level:0,adjustment:0,total_digits:2,d1_range:[0,0],scoring_mode:fixed} | Marks: [1, 1, 1, 2, 2 ... 7, 8, 9] (Total: 75) | Q1: E9:E11 → Q18: O54:O56 |
| **Junior 2** | 1..18 | Q1: {subtype:standard,terms:3,level:0,adjustment:0,total_digits:2,d1_range:[0,0],scoring_mode:fixed}<br/>Q18: {subtype:standard,terms:3,level:0,adjustment:0,total_digits:2,d1_range:[0,0],scoring_mode:fixed} | Marks: [1, 1, 2, 2, 3 ... 9, 10, 10] (Total: 95) | Q1: E9:E11 → Q18: O54:O56 |
| **Senior** | 1..18 | Q1: {subtype:standard,terms:3,level:3,adjustment:0,total_digits:5,d1_range:[4824,0],scoring_mode:fixed}<br/>Q18: {subtype:standard,terms:3,level:10,adjustment:0,total_digits:12,d1_range:[1471743,0],scoring_mode:fixed} | Marks: [3, 3, 4, 4, 5 ... 10, 11, 11] (Total: 123) | Q1: E9:E11 → Q18: O54:O56 |

### 2. Int Subs (`subtraction`)

- **Workbook Sheet:** `Int Subs`
- **Question Counts:** Junior 1: **18** slots | Junior 2: **18** slots | Senior: **18** slots
- **Total Cached Marks:** Junior 1: **89** | Junior 2: **82** | Senior: **117**
- **Generator:** `subtraction`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..18 | Q1: {subtype:standard,minuend_digits:[2,2],subtrahend_max_ratio:0.8,adjustment:0,scoring_mode:fixed}<br/>Q18: {subtype:standard,minuend_digits:[7,7],subtrahend_max_ratio:0.8,adjustment:0,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 3 ... 6, 7, 7] (Total: 89) | Q1: B5:D5 → Q18: B39:D39 |
| **Junior 2** | 1..18 | Q1: {subtype:standard,minuend_digits:[2,2],subtrahend_max_ratio:0.8,adjustment:-1,scoring_mode:fixed}<br/>Q18: {subtype:standard,minuend_digits:[10,10],subtrahend_max_ratio:0.8,adjustment:-2,scoring_mode:fixed} | Marks: [1, 1, 2, 2, 3 ... 7, 8, 8] (Total: 82) | Q1: B5:D5 → Q18: B39:D39 |
| **Senior** | 1..18 | Q1: {subtype:standard,minuend_digits:[3,3],subtrahend_max_ratio:0.8,adjustment:0,scoring_mode:fixed}<br/>Q18: {subtype:standard,minuend_digits:[10,10],subtrahend_max_ratio:0.8,adjustment:0,scoring_mode:fixed} | Marks: [3, 3, 4, 4, 5 ... 9, 10, 10] (Total: 117) | Q1: B5:D5 → Q18: B39:D39 |

### 3. Mixed adds+subs (`mixed`)

- **Workbook Sheet:** `Mixed adds+subs`
- **Question Counts:** Junior 1: **14** slots | Junior 2: **14** slots | Senior: **14** slots
- **Total Cached Marks:** Junior 1: **81** | Junior 2: **101** | Senior: **102**
- **Generator:** `mixed`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..14 | Q1: {terms:4,level:2,adjustment:0,total_digits:4,allow_negative:false,scoring_mode:fixed}<br/>Q14: {terms:4,level:8,adjustment:1,total_digits:10,allow_negative:false,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 4 ... 9, 10, 10] (Total: 81) | Q1: E7:E10 → Q14: J43:J46 |
| **Junior 2** | 1..14 | Q1: {terms:4,level:1,adjustment:1,total_digits:3,allow_negative:false,scoring_mode:fixed}<br/>Q14: {terms:4,level:8,adjustment:2,total_digits:10,allow_negative:false,scoring_mode:fixed} | Marks: [2, 3, 3, 4, 6 ... 10, 12, 12] (Total: 101) | Q1: E7:E10 → Q14: J43:J46 |
| **Senior** | 1..14 | Q1: {terms:4,level:2,adjustment:0,total_digits:4,allow_negative:false,scoring_mode:fixed}<br/>Q14: {terms:4,level:10,adjustment:1,total_digits:12,allow_negative:false,scoring_mode:fixed} | Marks: [2, 3, 3, 4, 4 ... 12, 12, 13] (Total: 102) | Q1: E7:E10 → Q14: J43:J46 |

### 4. Int Mults (`multiplication`)

- **Workbook Sheet:** `Int Mults`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **94** | Junior 2: **103** | Senior: **119**
- **Generator:** `multiplication`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:standard,grid_label:A1,x_level:2,total_digits:3,d2_range:[1,2],mark_range:[2,2],scoring_mode:dynamic,mark_rule:multiplication_digits_product}<br/>Q20: {subtype:standard,grid_label:B10,x_level:8,total_digits:9,d2_range:[5,7],mark_range:[7,9],scoring_mode:dynamic,mark_rule:multiplication_digits_product} | Marks: [2, 2, 3, 3, 3 ... 8, 7, 9] (Total: 94) | Q1: C5:C6 → Q20: K50:K51 |
| **Junior 2** | 1..20 | Q1: {subtype:standard,grid_label:A1,x_level:2,total_digits:3,d2_range:[1,2],mark_range:[2,2],scoring_mode:dynamic,mark_rule:multiplication_digits_product}<br/>Q20: {subtype:standard,grid_label:B10,x_level:9,total_digits:10,d2_range:[5,8],mark_range:[8,11],scoring_mode:dynamic,mark_rule:multiplication_digits_product} | Marks: [2, 2, 3, 3, 3 ... 9, 9, 11] (Total: 103) | Q1: C5:C6 → Q20: K50:K51 |
| **Senior** | 1..20 | Q1: {subtype:standard,grid_label:A1,x_level:3,total_digits:4,d2_range:[2,2],mark_range:[3,3],scoring_mode:dynamic,mark_rule:multiplication_digits_product}<br/>Q20: {subtype:standard,grid_label:B10,x_level:10,total_digits:11,d2_range:[6,8],mark_range:[11,13],scoring_mode:dynamic,mark_rule:multiplication_digits_product} | Marks: [3, 3, 3, 3, 4 ... 9, 10, 13] (Total: 119) | Q1: C5:C6 → Q20: K50:K51 |

### 5. Int Divs (`division`)

- **Workbook Sheet:** `Int Divs`
- **Question Counts:** Junior 1: **17** slots | Junior 2: **17** slots | Senior: **17** slots
- **Total Cached Marks:** Junior 1: **90** | Junior 2: **74** | Senior: **103**
- **Generator:** `division`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..17 | Q1: {subtype:exact,v_level:3,adjustment:-1,divisor_digits:[0,2],scoring_mode:fixed}<br/>Q17: {subtype:exact,v_level:7,adjustment:0,divisor_digits:[0,2],scoring_mode:fixed} | Marks: [2, 2, 4, 4, 4 ... 6, 7, 7] (Total: 90) | Q1: B4:D4 → Q17: B36:D36 |
| **Junior 2** | 1..17 | Q1: {subtype:exact,v_level:2,adjustment:0,divisor_digits:[0,1],scoring_mode:fixed}<br/>Q17: {subtype:exact,v_level:8,adjustment:-1,divisor_digits:[0,2],scoring_mode:fixed} | Marks: [2, 2, 3, 3, 4 ... 6, 7, 7] (Total: 74) | Q1: B4:D4 → Q17: B36:D36 |
| **Senior** | 1..17 | Q1: {subtype:exact,v_level:3,adjustment:0,divisor_digits:[0,2],scoring_mode:fixed}<br/>Q17: {subtype:exact,v_level:8,adjustment:0,divisor_digits:[0,2],scoring_mode:fixed} | Marks: [3, 3, 4, 5, 5 ... 7, 8, 8] (Total: 103) | Q1: B4:D4 → Q17: B36:D36 |

### 6. Brackets (`brackets`)

- **Workbook Sheet:** `Brackets`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **112** | Junior 2: **96** | Senior: **90**
- **Generator:** `brackets`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:ac_2,ac_level:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:ac_6,ac_level:6,adjustment:2,scoring_mode:fixed} | Marks: [2, 2, 2, 5, 5 ... 8, 8, 8] (Total: 112) | Q1: B5 → Q20: B43 |
| **Junior 2** | 1..20 | Q1: {subtype:ac_2,ac_level:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:ac_6,ac_level:6,adjustment:1,scoring_mode:fixed} | Marks: [2, 2, 2, 5, 5 ... 7, 7, 7] (Total: 96) | Q1: B5 → Q20: B43 |
| **Senior** | 1..20 | Q1: {subtype:ac_2,ac_level:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:ac_6,ac_level:6,adjustment:1,scoring_mode:fixed} | Marks: [2, 2, 2, 3, 3 ... 7, 7, 7] (Total: 90) | Q1: B5 → Q20: B43 |

### 7. Primes (`prime_factors`)

- **Workbook Sheet:** `Primes`
- **Question Counts:** Junior 1: **19** slots | Junior 2: **19** slots | Senior: **19** slots
- **Total Cached Marks:** Junior 1: **113** | Junior 2: **98** | Senior: **112**
- **Generator:** `prime_factors`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..19 | Q1: {u_level:1,factor_ranges:[[12,49],[6,16],[1,1]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale}<br/>Q19: {u_level:7,factor_ranges:[[102,199],[18,37],[18,37]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale} | Marks: [3, 4, 3, 3, 6 ... 10, 10, 8] (Total: 113) | Q1: B9 → Q19: B45 |
| **Junior 2** | 1..19 | Q1: {u_level:1,factor_ranges:[[12,49],[6,16],[1,1]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale}<br/>Q19: {u_level:7,factor_ranges:[[102,199],[18,37],[18,37]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale} | Marks: [3, 3, 3, 3, 3 ... 10, 8, 7] (Total: 98) | Q1: B9 → Q19: B45 |
| **Senior** | 1..19 | Q1: {u_level:1,factor_ranges:[[12,49],[6,16],[1,1]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale}<br/>Q19: {u_level:7,factor_ranges:[[102,199],[18,37],[18,37]],mark_range:[3,10],scoring_mode:dynamic,mark_rule:prime_factors_target_scale} | Marks: [3, 3, 6, 3, 6 ... 10, 8, 10] (Total: 112) | Q1: B9 → Q19: B45 |

### 8. HCF LCM (`hcf_lcm`)

- **Workbook Sheet:** `HCF LCM`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **123** | Junior 2: **135** | Senior: **144**
- **Generator:** `hcf_lcm`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:hcf_2,u_level:5,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:lcm_2,u_level:261,adjustment:0,scoring_mode:fixed} | Marks: [3, 3, 4, 4, 5 ... 9, 9, 10] (Total: 123) | Q1: B11:D11 → Q20: B54:D54 |
| **Junior 2** | 1..20 | Q1: {subtype:hcf_2,u_level:14,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:lcm_2,u_level:291,adjustment:0,scoring_mode:fixed} | Marks: [4, 4, 4, 5, 5 ... 9, 10, 10] (Total: 135) | Q1: B11:D11 → Q20: B54:D54 |
| **Senior** | 1..20 | Q1: {subtype:hcf_2,u_level:15,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:lcm_2,u_level:288,adjustment:0,scoring_mode:fixed} | Marks: [4, 4, 5, 5, 6 ... 9, 10, 12] (Total: 144) | Q1: B11:D11 → Q20: B54:D54 |

### 9. Fraction Additions (`fraction_add`)

- **Workbook Sheet:** `Fraction Additions`
- **Question Counts:** Junior 1: **18** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **105** | Junior 2: **100** | Senior: **100**
- **Generator:** `fraction_add`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..18 | Q1: {ak_level:3,adjustment:0,scoring_mode:fixed}<br/>Q18: {ak_level:7,adjustment:2,scoring_mode:fixed} | Marks: [3, 3, 3, 4, 4 ... 9, 9, 9] (Total: 105) | Q1: B13:E13 → Q18: B302:E302 |
| **Junior 2** | 1..20 | Q1: {ak_level:3,adjustment:0,scoring_mode:fixed}<br/>Q20: {ak_level:7,adjustment:0,scoring_mode:fixed} | Marks: [3, 3, 3, 4, 4 ... 7, 7, 7] (Total: 100) | Q1: B13:E13 → Q20: B336:E336 |
| **Senior** | 1..20 | Q1: {ak_level:2,adjustment:1,scoring_mode:fixed}<br/>Q20: {ak_level:6,adjustment:1,scoring_mode:fixed} | Marks: [3, 3, 4, 4, 4 ... 6, 7, 7] (Total: 100) | Q1: B13:E13 → Q20: B336:E336 |

### 10. Fraction Subtractions (`fraction_sub`)

- **Workbook Sheet:** `Fraction Subtractions`
- **Question Counts:** Junior 1: **18** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **133** | Junior 2: **120** | Senior: **119**
- **Generator:** `fraction_sub`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..18 | Q1: {r_level:2,adjustment:1,allow_negative:false,scoring_mode:fixed}<br/>Q18: {r_level:7,adjustment:2,allow_negative:false,scoring_mode:fixed} | Marks: [3, 3, 5, 5, 5 ... 10, 11, 11] (Total: 133) | Q1: B9:D9 → Q18: B230:D230 |
| **Junior 2** | 1..20 | Q1: {r_level:2,adjustment:0,allow_negative:false,scoring_mode:fixed}<br/>Q20: {r_level:8,adjustment:0,allow_negative:false,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 3 ... 9, 10, 10] (Total: 120) | Q1: B9:D9 → Q20: B256:D256 |
| **Senior** | 1..20 | Q1: {r_level:2,adjustment:0,allow_negative:false,scoring_mode:fixed}<br/>Q20: {r_level:7,adjustment:1,allow_negative:false,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 3 ... 9, 10, 10] (Total: 119) | Q1: B9:D9 → Q20: B256:D256 |

### 11. Fraction Multiplications (`fraction_mul`)

- **Workbook Sheet:** `Fraction Multiplications`
- **Question Counts:** Junior 1: **17** slots | Junior 2: **17** slots | Senior: **17** slots
- **Total Cached Marks:** Junior 1: **128** | Junior 2: **137** | Senior: **137**
- **Generator:** `fraction_mul`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..17 | Q1: {ai_level:2,adjustment:1,scoring_mode:fixed}<br/>Q17: {ai_level:6,adjustment:1,scoring_mode:fixed} | Marks: [5, 5, 6, 6, 6 ... 10, 10, 10] (Total: 128) | Q1: B9:P9 → Q17: B217:P217 |
| **Junior 2** | 1..17 | Q1: {ai_level:3,adjustment:1,scoring_mode:fixed}<br/>Q17: {ai_level:6,adjustment:1,scoring_mode:fixed} | Marks: [6, 6, 6, 7, 7 ... 10, 10, 10] (Total: 137) | Q1: B9:P9 → Q17: B217:P217 |
| **Senior** | 1..17 | Q1: {ai_level:3,adjustment:1,scoring_mode:fixed}<br/>Q17: {ai_level:6,adjustment:1,scoring_mode:fixed} | Marks: [6, 6, 6, 7, 7 ... 10, 10, 10] (Total: 137) | Q1: B9:P9 → Q17: B217:P217 |

### 12. Fraction Divisions (`fraction_div`)

- **Workbook Sheet:** `Fraction Divisions`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **121** | Junior 2: **107** | Senior: **109**
- **Generator:** `fraction_div`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {ai_level:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {ai_level:6,adjustment:2,scoring_mode:fixed} | Marks: [2, 2, 4, 4, 4 ... 8, 8, 8] (Total: 121) | Q1: B10:P10 → Q20: B257:P257 |
| **Junior 2** | 1..20 | Q1: {ai_level:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {ai_level:6,adjustment:3,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 4 ... 9, 9, 9] (Total: 107) | Q1: B10:P10 → Q20: B257:P257 |
| **Senior** | 1..20 | Q1: {ai_level:3,adjustment:0,scoring_mode:fixed}<br/>Q20: {ai_level:8,adjustment:2,scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 9, 10, 10] (Total: 109) | Q1: B10:P10 → Q20: B257:P257 |

### 13. Approximations (`approximation`)

- **Workbook Sheet:** `Approximations`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **156** | Junior 2: **169** | Senior: **173**
- **Generator:** `approximation`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:nearest_int_mul,strength:3,shift_w:2,mark_range:[2,16],scoring_mode:dynamic,mark_rule:approximation_product_digits}<br/>Q20: {subtype:sig_figs_4_div,strength:6,sig_figs:4,scoring_mode:fixed} | Marks: [2, 4, 7, 7, 7 ... 11, 11, 11] (Total: 156) | Q1: D8 → Q20: D59 |
| **Junior 2** | 1..20 | Q1: {subtype:nearest_int_mul,strength:3,shift_w:2,mark_range:[2,16],scoring_mode:dynamic,mark_rule:approximation_product_digits}<br/>Q20: {subtype:sig_figs_4_div,strength:7,sig_figs:4,scoring_mode:fixed} | Marks: [4, 4, 7, 7, 7 ... 11, 11, 11] (Total: 169) | Q1: D8 → Q20: D59 |
| **Senior** | 1..20 | Q1: {subtype:nearest_int_mul,strength:3,shift_w:2,mark_range:[2,16],scoring_mode:dynamic,mark_rule:approximation_product_digits}<br/>Q20: {subtype:sig_figs_4_div,strength:7,sig_figs:4,scoring_mode:fixed} | Marks: [4, 4, 7, 7, 11 ... 11, 11, 11] (Total: 173) | Q1: D8 → Q20: D59 |

### 14. Remainders (`remainder`)

- **Workbook Sheet:** `Remainders`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **68** | Junior 2: **80** | Senior: **112**
- **Generator:** `remainder`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {v_level:3,u_base:2,adjustment:0,divisor_digits_range:[2,2],scoring_mode:fixed}<br/>Q20: {v_level:5,u_base:4,adjustment:0,divisor_digits_range:[3,3],scoring_mode:fixed} | Marks: [2, 2, 3, 3, 3 ... 4, 4, 4] (Total: 68) | Q1: B6:D6 → Q20: B44:D44 |
| **Junior 2** | 1..20 | Q1: {v_level:4,u_base:3,adjustment:0,divisor_digits_range:[3,3],scoring_mode:fixed}<br/>Q20: {v_level:6,u_base:5,adjustment:0,divisor_digits_range:[4,4],scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 5, 5, 5] (Total: 80) | Q1: B6:D6 → Q20: B44:D44 |
| **Senior** | 1..20 | Q1: {v_level:4,u_base:3,adjustment:0,divisor_digits_range:[3,3],scoring_mode:fixed}<br/>Q20: {v_level:10,u_base:9,adjustment:0,divisor_digits_range:[6,8],scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 8, 9, 9] (Total: 112) | Q1: B6:D6 → Q20: B44:D44 |

### 15. Ratios (`ratio`)

- **Workbook Sheet:** `Ratios`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **98** | Junior 2: **90** | Senior: **100**
- **Generator:** `ratio`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:proportion_missing_x,aa_level:4,adjustment:0,a_range:[20,49],r1_range:[5,20],r2_range:[2,10],scoring_mode:fixed}<br/>Q20: {subtype:proportion_missing_x,aa_level:9,adjustment:0,a_range:[651,1500],r1_range:[53,87],r2_range:[5,20],scoring_mode:fixed} | Marks: [3, 3, 4, 4, 3 ... 7, 8, 8] (Total: 98) | Q1: B7:J7 → Q20: B45:J45 |
| **Junior 2** | 1..20 | Q1: {subtype:proportion_missing_x,aa_level:4,adjustment:0,a_range:[20,49],r1_range:[5,20],r2_range:[2,10],scoring_mode:fixed}<br/>Q20: {subtype:proportion_missing_x,aa_level:7,adjustment:0,a_range:[101,316],r1_range:[21,49],r2_range:[4,15],scoring_mode:fixed} | Marks: [3, 3, 3, 3, 4 ... 6, 6, 6] (Total: 90) | Q1: B7:J7 → Q20: B45:J45 |
| **Senior** | 1..20 | Q1: {subtype:proportion_missing_x,aa_level:4,adjustment:0,a_range:[20,49],r1_range:[5,20],r2_range:[2,10],scoring_mode:fixed}<br/>Q20: {subtype:proportion_missing_x,aa_level:8,adjustment:0,a_range:[317,650],r1_range:[41,64],r2_range:[4,15],scoring_mode:fixed} | Marks: [3, 3, 3, 4, 4 ... 7, 7, 7] (Total: 100) | Q1: B7:J7 → Q20: B45:J45 |

### 16. Perfect Square Roots (`square_root`)

- **Workbook Sheet:** `Perfect Square Roots`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **105** | Junior 2: **120** | Senior: **150**
- **Generator:** `square_root`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {square_digits:2,adjustment:0,scoring_mode:fixed}<br/>Q20: {square_digits:8,adjustment:1,scoring_mode:fixed} | Marks: [2, 2, 3, 3, 3 ... 8, 9, 9] (Total: 105) | Q1: C6 → Q20: C44 |
| **Junior 2** | 1..20 | Q1: {square_digits:3,adjustment:0,scoring_mode:fixed}<br/>Q20: {square_digits:9,adjustment:0,scoring_mode:fixed} | Marks: [3, 3, 4, 4, 4 ... 8, 9, 9] (Total: 120) | Q1: C6 → Q20: C44 |
| **Senior** | 1..20 | Q1: {square_digits:4,adjustment:0,scoring_mode:fixed}<br/>Q20: {square_digits:11,adjustment:0,scoring_mode:fixed} | Marks: [4, 4, 5, 5, 5 ... 10, 11, 11] (Total: 150) | Q1: C6 → Q20: C44 |

### 17. Irrational Square Roots (`inexact_square_root`)

- **Workbook Sheet:** `Irrational Square Roots`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **106** | Junior 2: **120** | Senior: **110**
- **Generator:** `inexact_square_root`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {w_level:4,adjustment:1,target_decimals:1,min_radicand:26,max_radicand:48,scoring_mode:fixed}<br/>Q20: {w_level:6,adjustment:0,target_decimals:1,min_radicand:101,max_radicand:316.22776601683825,scoring_mode:fixed} | Marks: [5, 5, 5, 5, 5 ... 6, 6, 6] (Total: 106) | Q1: C6:H6 → Q20: C44:H44 |
| **Junior 2** | 1..20 | Q1: {w_level:4,adjustment:0,target_decimals:1,min_radicand:26,max_radicand:48,scoring_mode:fixed}<br/>Q20: {w_level:8,adjustment:0,target_decimals:2,min_radicand:317.22776601683825,max_radicand:1000,scoring_mode:fixed} | Marks: [4, 4, 4, 5, 5 ... 8, 8, 8] (Total: 120) | Q1: C6:H6 → Q20: C44:H44 |
| **Senior** | 1..20 | Q1: {w_level:4,adjustment:0,target_decimals:1,min_radicand:26,max_radicand:48,scoring_mode:fixed}<br/>Q20: {w_level:7,adjustment:0,target_decimals:2,min_radicand:101,max_radicand:316.22776601683825,scoring_mode:fixed} | Marks: [4, 4, 4, 4, 5 ... 7, 7, 7] (Total: 110) | Q1: C6:H6 → Q20: C44:H44 |

### 18. Next Squares (`next_square`)

- **Workbook Sheet:** `Next Squares`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **70** | Junior 2: **103** | Senior: **88**
- **Generator:** `next_square`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:next_square_value,v_power:2,n_digits:3,adjustment:1,scoring_mode:fixed}<br/>Q20: {subtype:next_square_value,v_power:3,n_digits:4,adjustment:1,scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 4, 4, 4] (Total: 70) | Q1: B8:G8 → Q20: B46:G46 |
| **Junior 2** | 1..20 | Q1: {subtype:next_square_value,v_power:2,n_digits:3,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:next_square_value,v_power:5,n_digits:6,adjustment:2,scoring_mode:fixed} | Marks: [2, 2, 2, 2, 3 ... 8, 8, 8] (Total: 103) | Q1: B8:G8 → Q20: B46:G46 |
| **Senior** | 1..20 | Q1: {subtype:next_square_value,v_power:2,n_digits:3,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:next_square_value,v_power:6,n_digits:7,adjustment:0,scoring_mode:fixed} | Marks: [2, 2, 2, 3, 3 ... 7, 7, 7] (Total: 88) | Q1: B8:G8 → Q20: B46:G46 |

### 19. Cube Roots - Exact (`cube_root`)

- **Workbook Sheet:** `Cube Roots - Exact`
- **Question Counts:** Junior 1: **23** slots | Junior 2: **23** slots | Senior: **23** slots
- **Total Cached Marks:** Junior 1: **119** | Junior 2: **142** | Senior: **143**
- **Generator:** `cube_root`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..23 | Q1: {t_power:3,cube_digits:4,scoring_mode:fixed}<br/>Q23: {t_power:10,cube_digits:11,scoring_mode:fixed} | Marks: [3, 3, 3, 3, 4 ... 8, 9, 10] (Total: 119) | Q1: C7 → Q23: C51 |
| **Junior 2** | 1..23 | Q1: {t_power:3,cube_digits:4,scoring_mode:fixed}<br/>Q23: {t_power:11,cube_digits:12,scoring_mode:fixed} | Marks: [3, 3, 3, 4, 4 ... 9, 10, 11] (Total: 142) | Q1: C7 → Q23: C51 |
| **Senior** | 1..23 | Q1: {t_power:3,cube_digits:4,scoring_mode:fixed}<br/>Q23: {t_power:11,cube_digits:12,scoring_mode:fixed} | Marks: [3, 3, 3, 4, 4 ... 10, 11, 11] (Total: 143) | Q1: C7 → Q23: C51 |

### 20. Next Cubes (`next_cube`)

- **Workbook Sheet:** `Next Cubes`
- **Question Counts:** Junior 1: **19** slots | Junior 2: **19** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **62** | Junior 2: **86** | Senior: **80**
- **Generator:** `next_cube`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..19 | Q1: {subtype:next_cube_value,v_power:2,n_digits:3,adjustment:0,scoring_mode:fixed}<br/>Q19: {subtype:next_cube_value,v_power:4,n_digits:5,adjustment:0,scoring_mode:fixed} | Marks: [2, 2, 2, 2, 2 ... 4, 6, 6] (Total: 62) | Q1: B7:G7 → Q19: B43:G43 |
| **Junior 2** | 1..19 | Q1: {subtype:next_cube_value,v_power:2,n_digits:3,adjustment:0,scoring_mode:fixed}<br/>Q19: {subtype:next_cube_value,v_power:5,n_digits:6,adjustment:2,scoring_mode:fixed} | Marks: [2, 2, 2, 2, 2 ... 7, 7, 7] (Total: 86) | Q1: B7:G7 → Q19: B43:G43 |
| **Senior** | 1..20 | Q1: {subtype:next_cube_value,v_power:3,n_digits:4,adjustment:0,scoring_mode:fixed}<br/>Q20: {subtype:next_cube_value,v_power:5,n_digits:6,adjustment:0,scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 5, 5, 5] (Total: 80) | Q1: B7:G7 → Q20: B45:G45 |

### 21. Calendars (`calendar`)

- **Workbook Sheet:** `Calendars`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **90** | Junior 2: **90** | Senior: **77**
- **Generator:** `calendar`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {subtype:weekday,year_min:1969,year_max:2069,scoring_mode:fixed}<br/>Q20: {subtype:month,year_min:1969,year_max:2069,scoring_mode:fixed} | Marks: [4, 4, 4, 4, 4 ... 6, 6, 6] (Total: 90) | Q1: C9:G9 → Q20: B52:F52 |
| **Junior 2** | 1..20 | Q1: {subtype:weekday,year_min:1901,year_max:2099,scoring_mode:fixed}<br/>Q20: {subtype:month,year_min:1901,year_max:2099,scoring_mode:fixed} | Marks: [4, 4, 4, 4, 4 ... 6, 6, 6] (Total: 90) | Q1: C9:G9 → Q20: B52:F52 |
| **Senior** | 1..20 | Q1: {subtype:weekday,year_min:1901,year_max:2099,scoring_mode:fixed}<br/>Q20: {subtype:year,year_min:1901,year_max:2078,window_years:20,scoring_mode:fixed} | Marks: [3, 3, 3, 3, 3 ... 6, 7, 7] (Total: 77) | Q1: C9:G9 → Q20: C56:H56 |

### 22. Times Elapsed (`elapsed_time`)

- **Workbook Sheet:** `Times Elapsed`
- **Question Counts:** Junior 1: **19** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **76** | Junior 2: **127** | Senior: **98**
- **Generator:** `elapsed_time`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..19 | Q1: {format:seconds,aa_level:3,min_seconds:4000,max_seconds:17999,scoring_mode:fixed}<br/>Q19: {format:seconds,aa_level:3,min_seconds:4000,max_seconds:17999,scoring_mode:fixed} | Marks: [4, 4, 4, 4, 4 ... 4, 4, 4] (Total: 76) | Q1: C7:J7 → Q19: C43:J43 |
| **Junior 2** | 1..20 | Q1: {format:seconds,aa_level:3,scoring_mode:fixed}<br/>Q20: {format:seconds,aa_level:6,scoring_mode:fixed} | Marks: [5, 5, 5, 5, 5 ... 10, 10, 10] (Total: 127) | Q1: C7:J7 → Q20: C45:J45 |
| **Senior** | 1..20 | Q1: {format:seconds,aa_level:3,scoring_mode:fixed}<br/>Q20: {format:seconds,aa_level:6,scoring_mode:fixed} | Marks: [4, 4, 4, 4, 4 ... 7, 7, 7] (Total: 98) | Q1: C7:J7 → Q20: C45:J45 |

### 23. Sums of Squares (`sum_squares`)

- **Workbook Sheet:** `Sums of Squares`
- **Question Counts:** Junior 1: **20** slots | Junior 2: **20** slots | Senior: **20** slots
- **Total Cached Marks:** Junior 1: **96** | Junior 2: **94** | Senior: **89**
- **Generator:** `sum_squares`

| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |
|---|---|---|---|---|
| **Junior 1** | 1..20 | Q1: {min_count:2,max_count:4,min_target:30,max_target:75,mark_range:[2,6],scoring_mode:dynamic,mark_rule:sum_squares_j1_decomposition}<br/>Q20: {min_count:2,max_count:4,min_target:1001,max_target:2500,mark_range:[2,6],scoring_mode:dynamic,mark_rule:sum_squares_j1_decomposition} | Marks: [4, 5, 3, 5, 5 ... 5, 6, 6] (Total: 96) | Q1: C16 → Q20: C54 |
| **Junior 2** | 1..20 | Q1: {min_count:2,max_count:4,min_target:50,max_target:99,scoring_mode:dynamic,mark_rule:sum_squares_j2_target,mark_range:[2,10]}<br/>Q20: {min_count:2,max_count:4,min_target:2001,max_target:4999,scoring_mode:dynamic,mark_rule:sum_squares_j2_target,mark_range:[2,10]} | Marks: [2, 2, 3, 3, 4 ... 6, 6, 6] (Total: 94) | Q1: C16 → Q20: C54 |
| **Senior** | 1..20 | Q1: {min_count:2,max_count:4,min_target:50,max_target:99,scoring_mode:dynamic,mark_rule:sum_squares_sr_target,mark_range:[2,10]}<br/>Q20: {min_count:2,max_count:4,min_target:10001,max_target:49999,scoring_mode:dynamic,mark_rule:sum_squares_sr_target,mark_range:[2,10]} | Marks: [2, 2, 3, 3, 3 ... 6, 6, 10] (Total: 89) | Q1: C16 → Q20: C54 |

## 4. JMCWC Rules 2025 PDF Compliance Matrix

The 15 official contest rules from `docs/sources/JMCWC_Rules_2025.pdf` are implemented in the simulator architecture:

1. **Rule 1–3 (Contest Environment):** Simulated digitally via focus retention, missing-heartbeat detection, and full-screen test mode.
2. **Rule 4–6 (No Rough Work / Direct Entry):** Single direct answer inputs per task; no rough scratchpads permitted.
3. **Rule 7 (Task Navigation):** Students may answer tasks in any order, switch freely between categories, or skip questions.
4. **Rule 8 (Digit Counting Notation):** Student numeric inputs accept plain digits (`12345678`), comma-separated thousands (`12,345,678`), and digit-counting pipe separators (`1234|56|78`).
5. **Rule 9 (Answer Modification):** Digital inputs support standard text editing and replacement before final paper submission.
6. **Rule 10 (Decimal Rounding Policy):**
   - Precise answer at requested precision (e.g. `23.8` for $\sqrt{567}$ to 1 d.p.) $\rightarrow$ **Full marks**.
   - Wrong-way rounding at requested precision (e.g. `23.9`) $\rightarrow$ **Half marks** (provided true value is not exact at target precision).
   - Valid excess precision (e.g. `23.81`) $\rightarrow$ **Half marks**.
   - Incorrect values (e.g. `23.7`, `23.79`) $\rightarrow$ **0 marks**.
7. **Rule 11 (Fraction Format):** Strict simplest mixed fraction form required ($1\frac{3}{7}$ is correct; improper $\frac{10}{7}$ and unreduced $1\frac{30}{70}$ receive 0 marks).
8. **Rule 12 (Calendar Format):** Full names or 3-letter abbreviations accepted in both English and German (e.g. `Thursday`, `Thu`, `Donnerstag`, `Don`). Single month names required.
9. **Rule 13 (Prime Factorisation):** Factors accepted in any order, with repeated factors or exponent/superscript notation (`2^3 × 5`, `5, 2, 2, 2`, `2³, 5`). Composite factors and 1 are strictly rejected.
10. **Rule 14 (Sums of Squares):** Bases of 2 to 4 strictly positive nonzero integers required (`10, 5, 5` or `12² + 2² + 1² + 1²` = 150). Pre-squared numbers (`100, 25, 25`) and zero-padding (`+ 0²`) are strictly rejected with 0 marks.
11. **Rule 15 (Missing Digit Subtypes):** Accept either the missing digit alone (`8`) or the full reconstructed number (`487`).
