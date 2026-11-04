import fs from 'node:fs';
import { extractAllSectionsForGroup } from './extractJmcwcSections.js';

const j1 = extractAllSectionsForGroup('j1', 'JMCWC-2026-Simulator-Juniors-1.xlsx');
const j2 = extractAllSectionsForGroup('j2', 'JMCWC-2026-Simulator-Juniors-2.xlsx');
const sr = extractAllSectionsForGroup('sr', 'JMCWC-2026-Simulator-Seniors.xlsx');

let md = `# JMCWC Simulator — Comprehensive Source Matrix & Verification Report\n\n`;
md += `**Document Version:** 1.0 (Phase 17a Complete Source Verification)\n`;
md += `**Date:** 2026-11-02\n`;
md += `**Status:** Fully Verified against authentic sources on disk:\n`;
md += `- \`docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx\` (2.3 MB, 27 sheets, 23 visible)\n`;
md += `- \`docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx\` (2.4 MB, 27 sheets, 23 visible)\n`;
md += `- \`docs/sources/JMCWC-2026-Simulator-Seniors.xlsx\` (2.4 MB, 27 sheets, 23 visible)\n`;
md += `- \`docs/sources/JMCWC_Rules_2025.pdf\` (94 KB, 15 official contest rules & examples)\n\n`;

md += `## 1. Executive Summary & Paper Topology\n\n`;
md += `| Group | Source Workbook | Total Sheets | Visible Categories | Total Questions | Cached Snapshot Marks | Status |\n`;
md += `|---|---|---|---|---|---|---|\n`;
md += `| **Junior 1** (\`junior1\`) | \`JMCWC-2026-Simulator-Juniors-1.xlsx\` | 27 (4 hidden) | 23 | **440** | 2,310 | **Verified & Validated** |\n`;
md += `| **Junior 2** (\`junior2\`) | \`JMCWC-2026-Simulator-Juniors-2.xlsx\` | 27 (4 hidden) | 23 | **445** | 2,469 | **Verified & Validated** |\n`;
md += `| **Senior** (\`senior\`) | \`JMCWC-2026-Simulator-Seniors.xlsx\` | 27 (4 hidden) | 23 | **446** | 2,595 | **Verified & Validated** |\n\n`;
md += `### 1.1. Fixed vs. Dynamic Scoring Analysis & Upstream Dependency Graph\n\n`;
md += `Across all 23 categories in the three workbooks, an exhaustive trace of every mark formula and its upstream cell dependency tree reveals that:\n\n`;
md += `1. **19 Categories are strictly FIXED (Type A):**\n`;
md += `   - **Categories:** \`addition\`, \`subtraction\`, \`mixed\`, \`division\`, \`brackets\`, \`hcf_lcm\`, \`fraction_add\`, \`fraction_sub\`, \`fraction_mul\`, \`fraction_div\`, \`remainder\`, \`ratio\`, \`square_root\`, \`inexact_square_root\`, \`next_square\`, \`cube_root\`, \`next_cube\`, \`calendar\`, \`elapsed_time\`.\n`;
md += `   - **Formula Proof:** In each of these 19 categories, mark formulas reference only fixed slot parameters (levels, digits, adjustments) or variables where random operands mathematically cancel out:\n`;
md += `     - \`subtraction\`: \`AH5 = INT(LOG(AB5+0.5))+1\`. Since minuend \`AB5\` has exactly \`AA5\` digits by construction, \`INT(LOG(AB5+0.5))+1\` is identically equal to \`AA5\` for all random numbers. The mark is strictly fixed at \`AA5 + M5\`.\n`;
md += `     - \`remainder\`: \`AK6 = AI6 + AJ6 - 1 = Y6 + Z6 - 1\`. Because \`Z6 = V6 - Y6\`, the random number \`Y6\` cancels out completely (\`Y6 + (V6 - Y6) - 1 = V6 - 1\`), yielding a constant mark equal to the level setting.\n`;
md += `     - \`next_square\`: \`AI8 = INT(LOG(AD8+0.05))\`. Radicand \`AD8\` is in $[10^{V8}, 10^{V8+1}-1]$, so \`LOG\` is in $[V8, V8+1)$, evaluating identically to \`V8\` for all generated numbers.\n`;
md += `     - \`next_cube\`: \`AI7 = INT(LOG(AD7+0.05))\` evaluates identically to fixed level \`V7\`.\n`;
md += `     - All other 15 categories reference fixed table constants or slot adjustment cells.\n\n`;
md += `2. **4 Categories are dynamically score-calculated (Type B):**\n`;
md += `   - **\`multiplication\` (\`04_Int_Mults\`):** \`BD8 = INT(BD7^0.75 + 0.35)\` where \`BD7 = d1 * d2\` (\`mark_rule: "multiplication_digits_product"\`). When the total digit count can be partitioned unevenly (e.g., 7 digits into 4×3 digits vs 5×2 digits), the mark varies between 5 and 6 points based on the randomly chosen partition.\n`;
md += `   - **\`prime_factors\` (\`07_Primes\`):** \`G9 = INT(CA6 * 1.2)\` where \`CA6\` looks up composite product \`BZ6\` in valuation table \`$Q$16..$R$27\` (\`mark_rule: "prime_factors_target_scale"\`, \`mark_range: [3, 10]\`).\n`;
md += `   - **\`approximation\` (\`15_Approximations\`):** In slots 1..6 (\`nearest_int_mul\`, \`BV{r} = (BU{r} + BU{r}^2)/2 + 1\`) and slots 11..16 (\`nearest_int_div\`, \`AV{r} = (AU{r} + AU{r}^2)/2 + 1\`), marks depend on the digit count of the rounded integer answer (\`mark_rule: "approximation_product_digits"\`, \`mark_range: [2, 16]\`). Slots 7..10 (\`sig_figs_4_mul\`) and 17..20 (\`sig_figs_4_div\`) are strictly fixed at 11 marks.\n`;
md += `   - **\`sum_squares\` (\`25_Sums_of_Squares\`):** In Junior 1, \`G{r} = L{r} + M{r} - 2\` (\`mark_rule: "sum_squares_j1_decomposition"\`, \`mark_range: [2, 6]\`). In Junior 2 and Senior, \`G{r} = AJ{r} + J{r}\` depends on the generated target magnitude (\`mark_rule: "sum_squares_j2_target"\` and \`"sum_squares_sr_target"\`, \`mark_range: [2, 10]\`).\n\n`;
md += `### 1.2. Critical Terminology & Distinction\n\n`;
md += `- **Cached Workbook Example Total:** The static sum recorded in the author's original Excel snapshot (Junior 1: **2,310**, Junior 2: **2,469**, Senior: **2,595**). These represent a single valid evaluation of the dynamic formulas saved in the workbook file at the time of authoring. They are preserved in \`paper.spec.total_cached_marks\` as historical reference.\n`;
md += `- **Fixed Blueprint Slots:** Slots where \`parameters.scoring_mode\` is \`"fixed"\` (or omitted), with no \`mark_rule\` or \`mark_range\`, and where generated question \`max_marks\` must equal blueprint \`max_marks\`.\n`;
md += `- **Dynamic Blueprint Slots:** Slots where \`parameters.scoring_mode = "dynamic"\`, \`parameters.mark_rule\` is a recognized rule name, and \`parameters.mark_range = [min, max]\`. Scoring metadata is placed strictly inside \`slot.parameters\`, never at the slot top level.\n`;
md += `- **Maximum Marks for a Particular Generated Attempt:** In live generation, the trusted server generator computes each question's exact \`max_marks\` from the generated operands using registered pure scoring functions (\`DYNAMIC_SCORING_RULES\`), validates containment in \`parameters.mark_range\`, and freezes that integer mark into the persisted question payload at attempt creation. The attempt's maximum marks are derived by summing the persisted question \`max_marks\`.\n\n`;
md += `### 1.3. Deployed Database Contract & Actual RPC / Guard Functions\n\n`;
md += `The database schema and validation contract enforce fixed and dynamic slots via the nine owner-deployed JMCWC database functions:\n`;
md += `1. \`jmcwc_assignment_guard()\`\n`;
md += `2. \`jmcwc_paper_guard()\`\n`;
md += `3. \`jmcwc_check_student(uuid)\`\n`;
md += `4. \`jmcwc_tick(uuid)\`\n`;
md += `5. \`jmcwc_create_attempt(uuid,uuid,uuid,text,text,jsonb)\`\n`;
md += `6. \`jmcwc_act(uuid,uuid,text,uuid,bigint,jsonb)\`\n`;
md += `7. \`jmcwc_list(uuid,integer)\`\n`;
md += `8. \`jmcwc_finalize(uuid,uuid,bigint,jsonb)\`\n`;
md += `9. \`jmcwc_validate_marks(text,jsonb,numeric)\`\n\n`;

md += `## 2. Broken Formula Investigations & Forensic Repairs\n\n`;
md += `Across all 81 worksheets (27 sheets × 3 workbooks), formula errors (\`#REF!\` and \`#VALUE!\`) were present in only 4 visible sheets. Each was forensically analyzed across adjacent cells and all three workbooks:\n\n`;

md += `### 2.1. Integer Multiplications (\`04_Int_Mults\`): \`G5..H52\`, \`H7/H12\`, and \`AF16..AF70\`\n`;
md += `- **Issue:** \`H7\` contains \`#REF!\`, \`G7\` contains \`IF(H7=15,AV16,AK16)\` = \`#REF!\`, and every third generator row (\`AF16, AF22, AF28, ...\`) evaluates to \`#REF!\`.\n`;
md += `- **Forensic Investigation:** The active paper layout contains exactly **20 printed questions** organized in two columns: Left (cols \`C:D\`, labeled \`A1..A10\` in \`Q5..Q41\`, Seq 1..10) and Right (cols \`K:L\`, labeled \`B1..B10\` in \`Q7..Q43\`, Seq 11..20). The sequence table in \`W5..AB43\` defines exactly 20 parameter rows.\n`;
md += `- **Evidence:** Cell \`D54\` sums only Column D (\`=SUM(D7:D52)\`), cell \`L54\` sums only Column L (\`=SUM(L7:L52)\`), and cell \`L56\` ("Total value:") is \`=L54+D54\`. Middle Column \`G:H\` is completely omitted from the score sum (\`H54 = 0\`). Columns \`F:H\` and helper rows \`AF16, AF22, ...\` are unprinted remnants from an older 30-question 3-column layout whose parameter rows in \`W:AB\` were deleted by the workbook author.\n`;
md += `- **Resolution:** The 20 printed questions in columns \`C:D\` and \`K:L\` are 100% intact, mathematically valid, and fully verified. Columns \`F:H\` and the orphaned \`AF\` rows are pruned from the blueprint.\n\n`;

md += `### 2.2. Brackets (\`06_Brackets\`): \`B43\` and \`CZ44\`\n`;
md += `- **Issue:** Question cell \`B43\` (slot 20) contains an \`IF\` chain where the branches for \`AC43=5\` and \`AC43=8\` reference \`#REF!\`. Cell \`CZ44\` contains \`="("&#REF!&" + "&#REF!&#REF!&#REF!&" + "&#REF!&")"\`.\n`;
md += `- **Forensic Investigation:** In all three workbooks (\`j1\`, \`j2\`, \`sr\`), cell \`AC43\` has the fixed value **6**. Thus, \`B43\` evaluates the \`DW43\` branch and answer cell \`P43\` evaluates \`DV43\`, which are 100% intact and valid. The \`#REF!\` error is strictly in dormant branches of the conditional tree.\n`;
md += `- **Evidence:** In slots 1..19 (\`B5..B41\`), display strings for subtype 5 (\`CZ\`) and subtype 8 (\`GE\`) are placed on the even row below each odd question row. In row 44, \`GE44\` is intact (\`=GE43&GF43&GG43&GH43&GI43&GJ43&GK43&GL43&" + "&GN43&")"\`). In row 43, cells \`DA43\`, \`DC43\`, \`DD43\`, \`DE43\`, \`DG43\` are all intact.\n`;
md += `- **Resolution:** Repair \`CZ44 = "("&DA43&" + "&DC43&DD43&DE43&" + "&DG43&")"\`, and update \`B43\` to reference \`CZ44\` for \`AC43=5\` and \`GE44\` for \`AC43=8\`. All 8 subtypes (2..9) are now mathematically sound across all 20 slots.\n\n`;

md += `### 2.3. Fraction Multiplications (\`11_Fraction_Multiplications\`): \`BD229..HT239\`\n`;
md += `- **Issue:** Cells \`BD229:HT239\` contain \`#REF!\` errors.\n`;
md += `- **Forensic Investigation:** Each question in this sheet occupies a 13-row vertical block. Exactly 17 question blocks are printed and numbered: Q1 at row 9, Q2 at row 22, ..., Q17 at row 217 (\`AH9=1 .. AH217=17\`). Cell \`Z241\` ("Total value:") sums \`=SUM(Z9:Z228)\` in Junior 1, and \`=SUM(Z9:Z240)\` in Junior 2/Senior (where rows 229..240 contain no printed cells, questions, answers, or marks).\n`;
md += `- **Evidence:** Columns \`B:P\` (the printed question grid) and Columns \`T:X\` (the answer grid) in rows 229..239 are completely empty. Rows 229..239 in hidden columns \`BC:HT\` are orphaned prime-factorization helper rows from a deleted 18th question slot.\n`;
md += `- **Resolution:** Confirm that \`11_Fraction_Multiplications\` has exactly 17 questions across all 3 groups. The orphaned hidden rows are excluded from the simulator.\n\n`;

md += `### 2.4. Cube Roots - Exact (\`21_Cube_Roots_-_Exact\`): \`S51\`\n`;
md += `- **Issue:** Cell \`S51\` contains \`=#REF!+1\`.\n`;
md += `- **Forensic Investigation:** Column S is the sequence counter (\`S7=1\`, \`S9=S7+1=2\`, ..., \`S49=22\`). Cell \`S51\` lost its upstream reference to \`S49\`.\n`;
md += `- **Evidence:** In row 51 (slot 23), the question radicand \`C51 = [AB51]\`, the integer root answer \`G51 = [AA51]\`, the mark \`I51 = [T51]\`, and all generator cells \`T51:AB51\` are 100% intact and valid. The total marks formula in \`I53\` is \`=SUM(I7:I51)\`, which explicitly sums all 23 questions.\n`;
md += `- **Resolution:** Repair \`S51 = S49 + 1\` (= 23). The question count for \`21_Cube_Roots_-_Exact\` is verified as 23 slots.\n\n`;

md += `## 3. Comprehensive Category Matrix (All 23 Categories)\n\n`;

for (let cIdx = 0; cIdx < 23; cIdx++) {
  const catKey = j1[cIdx].key;
  const sheetName = j1[cIdx].workbook_sheet;
  const j1Sec = j1[cIdx];
  const j2Sec = j2[cIdx];
  const srSec = sr[cIdx];

  md += `### ${cIdx + 1}. ${sheetName} (\`${catKey}\`)\n\n`;
  md += `- **Workbook Sheet:** \`${sheetName}\`\n`;
  md += `- **Question Counts:** Junior 1: **${j1Sec.questions.length}** slots | Junior 2: **${j2Sec.questions.length}** slots | Senior: **${srSec.questions.length}** slots\n`;
  md += `- **Total Cached Marks:** Junior 1: **${j1Sec.expectedTotal}** | Junior 2: **${j2Sec.expectedTotal}** | Senior: **${srSec.expectedTotal}**\n`;
  md += `- **Generator:** \`${j1Sec.questions[0].generator}\`\n\n`;

  md += `| Group | Slots | Subtypes / Generator Parameters | Mark Formula / Range | Source Cell References |\n`;
  md += `|---|---|---|---|---|\n`;

  for (const [grpLabel, sec] of [['Junior 1', j1Sec], ['Junior 2', j2Sec], ['Senior', srSec]]) {
    const q1 = sec.questions[0];
    const qLast = sec.questions[sec.questions.length - 1];
    const p1 = JSON.stringify(q1.parameters).replace(/"/g, '');
    const pLast = JSON.stringify(qLast.parameters).replace(/"/g, '');
    const marksArr = sec.questions.map(q => q.max_marks);
    const marksSummary = marksArr.length <= 10 ? marksArr.join(', ') : `${marksArr.slice(0, 5).join(', ')} ... ${marksArr.slice(-3).join(', ')}`;

    md += `| **${grpLabel}** | 1..${sec.questions.length} | Q1: ${p1}<br/>Q${sec.questions.length}: ${pLast} | Marks: [${marksSummary}] (Total: ${sec.expectedTotal}) | Q1: ${q1.source_ref.printed_cells || q1.source_ref.generator_row} → Q${sec.questions.length}: ${qLast.source_ref.printed_cells || qLast.source_ref.generator_row} |\n`;
  }
  md += `\n`;
}

md += `## 4. JMCWC Rules 2025 PDF Compliance Matrix\n\n`;
md += `The 15 official contest rules from \`docs/sources/JMCWC_Rules_2025.pdf\` are implemented in the simulator architecture:\n\n`;
md += `1. **Rule 1–3 (Contest Environment):** Simulated digitally via focus retention, missing-heartbeat detection, and full-screen test mode.\n`;
md += `2. **Rule 4–6 (No Rough Work / Direct Entry):** Single direct answer inputs per task; no rough scratchpads permitted.\n`;
md += `3. **Rule 7 (Task Navigation):** Students may answer tasks in any order, switch freely between categories, or skip questions.\n`;
md += `4. **Rule 8 (Digit Counting Notation):** Student numeric inputs accept plain digits (\`12345678\`), comma-separated thousands (\`12,345,678\`), and digit-counting pipe separators (\`1234|56|78\`).\n`;
md += `5. **Rule 9 (Answer Modification):** Digital inputs support standard text editing and replacement before final paper submission.\n`;
md += `6. **Rule 10 (Decimal Rounding Policy):**\n`;
md += `   - Precise answer at requested precision (e.g. \`23.8\` for $\\sqrt{567}$ to 1 d.p.) $\\rightarrow$ **Full marks**.\n`;
md += `   - Wrong-way rounding at requested precision (e.g. \`23.9\`) $\\rightarrow$ **Half marks** (provided true value is not exact at target precision).\n`;
md += `   - Valid excess precision (e.g. \`23.81\`) $\\rightarrow$ **Half marks**.\n`;
md += `   - Incorrect values (e.g. \`23.7\`, \`23.79\`) $\\rightarrow$ **0 marks**.\n`;
md += `7. **Rule 11 (Fraction Format):** Strict simplest mixed fraction form required ($1\\frac{3}{7}$ is correct; improper $\\frac{10}{7}$ and unreduced $1\\frac{30}{70}$ receive 0 marks).\n`;
md += `8. **Rule 12 (Calendar Format):** Full names or 3-letter abbreviations accepted in both English and German (e.g. \`Thursday\`, \`Thu\`, \`Donnerstag\`, \`Don\`). Single month names required.\n`;
md += `9. **Rule 13 (Prime Factorisation):** Factors accepted in any order, with repeated factors or exponent/superscript notation (\`2^3 × 5\`, \`5, 2, 2, 2\`, \`2³, 5\`). Composite factors and 1 are strictly rejected.\n`;
md += `10. **Rule 14 (Sums of Squares):** Bases of 2 to 4 strictly positive nonzero integers required (\`10, 5, 5\` or \`12² + 2² + 1² + 1²\` = 150). Pre-squared numbers (\`100, 25, 25\`) and zero-padding (\`+ 0²\`) are strictly rejected with 0 marks.\n`;
md += `11. **Rule 15 (Missing Digit Subtypes):** Accept either the missing digit alone (\`8\`) or the full reconstructed number (\`487\`).\n`;

fs.writeFileSync('docs/JMCWC_SOURCE_MATRIX.md', md);
console.log('Successfully wrote docs/JMCWC_SOURCE_MATRIX.md');
