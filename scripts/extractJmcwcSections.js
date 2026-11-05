/**
 * Trendz Tracker — Phase 17a: JMCWC Source Matrix & Blueprint Finalizer (scripts/extractJmcwcSections.js)
 *
 * Reads directly from authentic workbooks via inspectJmcwcWorkbooks.js (zero-dependency .xlsx parser),
 * extracting faithful parameters, source references, and verified mark formulas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const workbookFileMap = {
  j1: 'docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx',
  junior1: 'docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx',
  j2: 'docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx',
  junior2: 'docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx',
  sr: 'docs/sources/JMCWC-2026-Simulator-Seniors.xlsx',
  senior: 'docs/sources/JMCWC-2026-Simulator-Seniors.xlsx',
};

const parsedWbCache = new Map();

function getCachedWb(g) {
  if (!parsedWbCache.has(g)) {
    const file = workbookFileMap[g];
    parsedWbCache.set(g, inspectWorkbookFile(file));
  }
  return parsedWbCache.get(g);
}

function parseSheet(g, fname, sheetName) {
  const wb = getCachedWb(g);
  const targetName = sheetName || fname.replace(/^\d+_/, '').replace(/_/g, ' ');
  let sheet = wb.sheets.find((s) => s.name === targetName || s.name === sheetName);
  if (!sheet) {
    sheet = wb.sheets.find((s) => s.name.toLowerCase().includes(targetName.toLowerCase()));
  }
  return sheet;
}

const val = (sheet, r, c) => sheet?.cells?.[`${c}${r}`]?.value ?? null;
const num = (sheet, r, c, def = 0) => {
  const v = val(sheet, r, c);
  return v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : def;
};

const workbooks = [
  { group: 'junior1', file: 'JMCWC-2026-Simulator-Juniors-1.xlsx', code: 'j1' },
  { group: 'junior2', file: 'JMCWC-2026-Simulator-Juniors-2.xlsx', code: 'j2' },
  { group: 'senior',  file: 'JMCWC-2026-Simulator-Seniors.xlsx',   code: 'sr' },
];

export function extractAllSectionsForGroup(g, wbName) {
  const sections = [];
  const cols3 = ['E', 'J', 'O'];

  // 1. addition (01_Int_Adds) — 18 slots
  {
    const rows = parseSheet(g, '01_Int_Adds', 'Int Adds');
    const questions = [];
    const cols3Data = ['C', 'H', 'M'];
    const cols3Mark = ['E', 'J', 'O'];
    for (let s = 1; s <= 18; s++) {
      const genR = 4 + 2 * s;
      const colIdx = (s - 1) % 3;
      const rowIdx = Math.floor((s - 1) / 3);
      const cData = cols3Data[colIdx];
      const cMark = cols3Mark[colIdx];
      const ansR = 12 + rowIdx * 9;

      const isSenior = g === 'sr' || g === 'senior';
      const level = isSenior ? num(rows, genR, 'AO') : num(rows, genR, 'AT');
      const terms = isSenior ? num(rows, genR, 'BV') : num(rows, genR, 'CA');
      const digits = isSenior ? num(rows, genR, 'BU') : num(rows, genR, 'BZ');
      const adj = num(rows, genR, 'AF', 0);
      const m = num(rows, ansR, cMark);

      questions.push({
        slot: s,
        max_marks: m,
        generator: 'addition',
        parameters: {
          subtype: 'standard',
          terms,
          digits,
          level,
          adjustment: adj,
          total_digits: terms * digits,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Int Adds',
          printed_cells: `${cData}${ansR - terms}:${cData}${ansR - 1}`,
          answer_cell: `${cData}${ansR}`,
          mark_cell: `${cMark}${ansR}`,
          generator_row: `R${genR}`,
        },
      });
    }
    sections.push({ key: 'addition', workbook_sheet: 'Int Adds', questions, expectedTotal: num(rows, 61, 'O') });
  }

  // 2. subtraction (02_Int_Subs) — 18 slots
  {
    const rows = parseSheet(g, '02_Int_Subs', 'Int Subs');
    const questions = [];
    for (let s = 1; s <= 18; s++) {
      const r = 3 + 2 * s;
      const d1 = num(rows, r, 'AA');
      const adj = num(rows, r, 'M', 0);
      const m = num(rows, r, 'K');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'subtraction',
        parameters: {
          subtype: 'standard',
          minuend_digits: [d1, d1],
          subtrahend_max_ratio: 0.8,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Int Subs',
          printed_cells: `B${r}:D${r}`,
          answer_cell: `I${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'subtraction', workbook_sheet: 'Int Subs', questions, expectedTotal: num(rows, 41, 'K') });
  }

  // 3. mixed (03_Mixed_adds_subs) — 14 slots
  {
    const rows = parseSheet(g, '03_Mixed_adds_subs', 'Mixed adds+subs');
    const genRows = (g === 'j1' || g === 'junior1')
      ? [8,10,12,14,16,18,20,22,24,26,28,30,32,34]
      : (g === 'j2' || g === 'junior2')
      ? [5,8,10,12,14,16,18,20,22,24,26,28,30,32]
      : [5,7,9,11,13,15,17,19,21,23,25,27,29,31];
    const cols3Data = ['C', 'H', 'M'];
    const cols3Mark = ['E', 'J', 'O'];
    const questions = [];
    for (let s = 1; s <= 14; s++) {
      const genR = genRows[s - 1];
      const colIdx = (s - 1) % 3;
      const rowIdx = Math.floor((s - 1) / 3);
      const cData = cols3Data[colIdx];
      const cMark = cols3Mark[colIdx];
      const ansR = 13 + rowIdx * 9;

      const isSenior = g === 'sr' || g === 'senior';
      const isJunior2 = g === 'j2' || g === 'junior2';
      const level = isSenior ? num(rows, genR, 'AQ') : isJunior2 ? num(rows, genR, 'AP') : num(rows, genR, 'AN');
      const terms = isSenior ? num(rows, genR, 'BX') : isJunior2 ? num(rows, genR, 'BW') : num(rows, genR, 'BU');
      const digits = isSenior ? num(rows, genR, 'BW') : isJunior2 ? num(rows, genR, 'BV') : num(rows, genR, 'BT');
      const adj = isSenior ? num(rows, genR, 'AH', 0) : isJunior2 ? num(rows, genR, 'AG', 0) : num(rows, genR, 'AE', 0);
      const m = num(rows, ansR, cMark);

      questions.push({
        slot: s,
        max_marks: m,
        generator: 'mixed',
        parameters: {
          terms,
          digits,
          level,
          adjustment: adj,
          total_digits: terms * digits,
          allow_negative: false,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Mixed adds+subs',
          printed_cells: `${cData}${(isSenior && s === 1) ? 9 : (8 + rowIdx * 9)}:${cData}${((isSenior && s === 1) ? 9 : (8 + rowIdx * 9)) + terms - 1}`,
          answer_cell: `${cData}${ansR}`,
          mark_cell: `${cMark}${ansR}`,
          generator_row: `R${genR}`,
        },
      });
    }
    const totR = (g === 'j1' || g === 'junior1') ? 54 : 53;
    sections.push({ key: 'mixed', workbook_sheet: 'Mixed adds+subs', questions, expectedTotal: num(rows, totR, 'O') });
  }

  // 4. multiplication (04_Int_Mults) — 20 slots
  {
    const rows = parseSheet(g, '04_Int_Mults');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const paramR = 3 + 2 * s;
      const isLeft = s % 2 === 1;
      const idx = Math.floor((s - 1) / 2);
      const dispR = 5 + idx * 5;
      const markR = dispR + 2;
      const cVal = isLeft ? 'C' : 'K';
      const cMark = isLeft ? 'D' : 'L';
      const genR = s === 1 ? 5 : 12 + 3 * s;
      const xLevel = num(rows, paramR, 'X');
      const yMin = num(rows, paramR, 'Y');
      const zMax = num(rows, paramR, 'Z');
      const lo = Math.min(yMin, zMax);
      const hi = Math.max(yMin, zMax);
      const m = num(rows, markR, cMark);
      let minM = Infinity, maxM = -Infinity;
      if (zMax + 1 - yMin <= 0) {
        const d1 = xLevel + 1 - yMin;
        const mk = Math.floor(Math.pow(d1 * yMin, 0.75) + 0.35);
        minM = mk;
        maxM = mk;
      } else {
        for (let d2 = lo; d2 <= hi; d2++) {
          const d1 = xLevel + 1 - d2;
          const mk = Math.floor(Math.pow(d1 * d2, 0.75) + 0.35);
          if (mk < minM) minM = mk;
          if (mk > maxM) maxM = mk;
        }
      }
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'multiplication',
        parameters: {
          subtype: 'standard',
          grid_label: val(rows, paramR, 'Q'),
          x_level: xLevel,
          total_digits: xLevel + 1,
          d2_range: [yMin, zMax],
          mark_formula: 'INT((d1*d2)^0.75+0.35)',
          mark_range: [minM, maxM],
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Int Mults',
          printed_cells: `${cVal}${dispR}:${cVal}${dispR + 1}`,
          answer_cell: `${cVal}${markR}`,
          mark_cell: `${cMark}${markR}`,
          param_row: `R${paramR}`,
          generator_row: `R${genR}`,
          repair_note: 'Active 20-question layout uses cols C:D (A1..A10) and K:L (B1..B10) summed in L56=L54+D54; middle col G:H (H7/H12) is an unreferenced remnant from a deleted 30-question layout.',
        },
      });
    }
    sections.push({ key: 'multiplication', workbook_sheet: 'Int Mults', questions, expectedTotal: num(rows, 56, 'L') });
  }

  // 5. division (05_Int_Divs) — 17 slots
  {
    const rows = parseSheet(g, '05_Int_Divs', 'Int Divs');
    const questions = [];
    for (let s = 1; s <= 17; s++) {
      const r = 2 + 2 * s;
      const vLevel = num(rows, r, 'V');
      const adj = num(rows, r, 'M', 0);
      const m = num(rows, r, 'K');
      const d2Min = num(rows, r, 'X');
      const d2Max = num(rows, r, 'Y');
      const dividendDigits = num(rows, r, 'AB');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'division',
        parameters: {
          subtype: 'exact',
          v_level: vLevel,
          adjustment: adj,
          divisor_digits: [d2Min, d2Max],
          dividend_digits: dividendDigits,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Int Divs',
          printed_cells: `B${r}:D${r}`,
          answer_cell: `I${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'division', workbook_sheet: 'Int Divs', questions, expectedTotal: num(rows, 38, 'K') });
  }

  // 6. brackets (06_Brackets) — 20 slots
  {
    const rows = parseSheet(g, '06_Brackets');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 3 + 2 * s;
      const ac = num(rows, r, 'AC');
      const adj = num(rows, r, 'T', 0);
      const m = num(rows, r, 'R');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'brackets',
        parameters: {
          subtype: `ac_${ac}`,
          ac_level: ac,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Brackets',
          printed_cells: `B${r}`,
          answer_cell: `P${r}`,
          mark_cell: `R${r}`,
          generator_row: `R${r}`,
          ...(r === 43 ? {
            repair_note: 'B43 has AC43=6 (active branch DW43, answer DV43, 100% intact); dormant AC43=5 and AC43=8 branches in B43 had #REF! from deleted CZ44 reference and are repaired to CZ44 and GE44 matching R5..R41.',
          } : {}),
        },
      });
    }
    sections.push({ key: 'brackets', workbook_sheet: 'Brackets', questions, expectedTotal: num(rows, 45, 'R') });
  }

  // 7. prime_factors (07_Primes) — 19 slots
  {
    const rows = parseSheet(g, '07_Primes');
    const questions = [];
    const levelRanges = {
      1: [[6, 49], [2, 16], [1, 1]],
      2: [[6, 49], [3, 16], [1, 9]],
      3: [[6, 97], [3, 16], [1, 9]],
      4: [[18, 97], [2, 37], [1, 1]],
      5: [[22, 97], [3, 49], [1, 9]],
      6: [[22, 97], [3, 97], [1, 9]],
      7: [[18, 199], [18, 37], [1, 37]],
    };
    for (let s = 1; s <= 19; s++) {
      const dispR = 7 + 2 * s;
      const genR = 2 + 4 * s;
      const uLevel = num(rows, 15 + s, 'N');
      const m = num(rows, dispR, 'G');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'prime_factors',
        parameters: {
          u_level: uLevel,
          factor_ranges: levelRanges[uLevel],
          mark_formula: 'INT(CA*1.2)',
          mark_range: [3, 10],
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Primes',
          printed_cells: `B${dispR}`,
          answer_cell: `E${dispR}`,
          mark_cell: `G${dispR}`,
          generator_rows: `R${genR}:R${genR + 2}`,
        },
      });
    }
    sections.push({ key: 'prime_factors', workbook_sheet: 'Primes', questions, expectedTotal: num(rows, 47, 'G') });
  }

  // 8. hcf_lcm (08_HCF_LCM) — 20 slots
  {
    const rows = parseSheet(g, '08_HCF_LCM');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const isHcf = s <= 10;
      const r = isHcf ? 9 + 2 * s : 14 + 2 * s;
      const mLevel = num(rows, r, 'M');
      const uLevel = num(rows, r, 'U');
      const adj = isHcf ? num(rows, r, 'J', 0) : num(rows, r, 'K', 0);
      const m = num(rows, r, 'H');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'hcf_lcm',
        parameters: {
          subtype: isHcf ? 'hcf_2' : 'lcm_2',
          m_level: mLevel,
          u_level: uLevel,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'HCF LCM',
          printed_cells: `B${r}:D${r}`,
          answer_cell: `F${r}`,
          mark_cell: `H${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'hcf_lcm', workbook_sheet: 'HCF LCM', questions, expectedTotal: num(rows, 57, 'H') });
  }

  // 9. fraction_add (09_Fraction_Additions) — 18 in j1, 20 in j2/sr
  {
    const rows = parseSheet(g, '09_Fraction_Additions', 'Fraction Additions');
    const count = g === 'j1' ? 18 : 20;
    const questions = [];
    for (let s = 1; s <= count; s++) {
      const r = 13 + 17 * (s - 1);
      const akLevel = num(rows, r, 'AK');
      const adj = num(rows, r, 'L', 0);
      const m = num(rows, r, 'J');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'fraction_add',
        parameters: {
          ak_level: akLevel,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Fraction Additions',
          printed_cells: `B${r}:E${r}`,
          answer_cell: `F${r}`,
          mark_cell: `J${r}`,
          generator_rows: `R${r}:R${r + 15}`,
        },
      });
    }
    const totR = g === 'j1' ? 320 : 354;
    sections.push({ key: 'fraction_add', workbook_sheet: 'Fraction Additions', questions, expectedTotal: num(rows, totR, 'J') });
  }

  // 10. fraction_sub (10_Fraction_Subtractions) — 18 in j1, 20 in j2/sr
  {
    const rows = parseSheet(g, '10_Fraction_Subtractions', 'Fraction Subtractions');
    const count = g === 'j1' ? 18 : 20;
    const questions = [];
    for (let s = 1; s <= count; s++) {
      const r = 9 + 13 * (s - 1);
      const rLevel = num(rows, r, 'R');
      const adj = num(rows, r, 'K', 0);
      const m = num(rows, r, 'I');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'fraction_sub',
        parameters: {
          r_level: rLevel,
          adjustment: adj,
          allow_negative: false,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Fraction Subtractions',
          printed_cells: `B${r}:D${r}`,
          answer_cell: `F${r}`,
          mark_cell: `I${r}`,
          generator_rows: `R${r}:R${r + 11}`,
        },
      });
    }
    const totR = g === 'j1' ? 243 : 269;
    sections.push({ key: 'fraction_sub', workbook_sheet: 'Fraction Subtractions', questions, expectedTotal: num(rows, totR, 'I') });
  }

  // 11. fraction_mul (11_Fraction_Multiplications) — 17 slots
  {
    const rows = parseSheet(g, '11_Fraction_Multiplications', 'Fraction Multiplications');
    const questions = [];
    for (let s = 1; s <= 17; s++) {
      const r = 9 + 13 * (s - 1);
      const aiLevel = num(rows, r, 'AI');
      const adj = num(rows, r, 'AB', 0);
      const m = num(rows, r, 'Z');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'fraction_mul',
        parameters: {
          ai_level: aiLevel,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Fraction Multiplications',
          printed_cells: `B${r}:P${r}`,
          answer_cell: `T${r}`,
          mark_cell: `Z${r}`,
          generator_rows: `R${r}:R${r + 10}`,
          ...(s === 17 ? {
            repair_note: 'Sheet has 17 printed slots (R9..R217, step 13) summed in Z241; rows R229..R239 (BD229..HT239) are orphaned prime-factorization helper rows from a deleted 18th block with no printed cells.',
          } : {}),
        },
      });
    }
    sections.push({ key: 'fraction_mul', workbook_sheet: 'Fraction Multiplications', questions, expectedTotal: num(rows, 241, 'Z') });
  }

  // 12. fraction_div (12_Fraction_Divisions) — 20 slots
  {
    const rows = parseSheet(g, '12_Fraction_Divisions', 'Fraction Divisions');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 10 + 13 * (s - 1);
      const aiLevel = num(rows, r, 'AI');
      const adj = num(rows, r, 'AB', 0);
      const m = num(rows, r, 'Z');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'fraction_div',
        parameters: {
          ai_level: aiLevel,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Fraction Divisions',
          printed_cells: `B${r}:P${r}`,
          answer_cell: `W${r}`,
          mark_cell: `Z${r}`,
          generator_rows: `R${r}:R${r + 10}`,
        },
      });
    }
    sections.push({ key: 'fraction_div', workbook_sheet: 'Fraction Divisions', questions, expectedTotal: num(rows, 270, 'Z') });
  }

  // 13. approximation (15_Approximations) — 20 slots
  {
    const rows = parseSheet(g, '15_Approximations');
    const appRows = [8,10,12,14,16,18, 25,27,29,31, 38,40,42,44,46,48, 53,55,57,59];
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = appRows[s - 1];
      const strength = num(rows, r, 'P');
      const m = num(rows, r, 'M');
      let subtype = 'nearest_int_mul';
      if (s >= 7 && s <= 10) subtype = 'sig_figs_4_mul';
      else if (s >= 11 && s <= 16) subtype = 'nearest_int_div';
      else if (s >= 17) subtype = 'sig_figs_4_div';
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'approximation',
        parameters: {
          subtype,
          strength,
          ...(s <= 6 ? { shift_w: num(rows, r, 'W', 0), mark_formula: '(BU+BU^2)/2+1', mark_range: [2, 16] } : {}),
          ...(s >= 7 && s <= 10 ? { sig_figs: 4 } : {}),
          ...(s >= 11 && s <= 16 ? { mark_formula: '(AU+AU^2)/2+1', mark_range: [2, 16] } : {}),
          ...(s >= 17 ? { sig_figs: 4 } : {}),
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Approximations',
          printed_cells: `D${r}`,
          answer_cell: `K${r}`,
          mark_cell: `M${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'approximation', workbook_sheet: 'Approximations', questions, expectedTotal: num(rows, 62, 'M') });
  }

  // 14. remainder (16_Remainders) — 20 slots
  {
    const rows = parseSheet(g, '16_Remainders');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 4 + 2 * s;
      const vLevel = num(rows, r, 'V');
      const uMarks = num(rows, r, 'U');
      const adj = num(rows, r, 'M', 0);
      const m = num(rows, r, 'K');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'remainder',
        parameters: {
          v_level: vLevel,
          u_base: uMarks,
          adjustment: adj,
          divisor_digits_range: [num(rows, r, 'W'), num(rows, r, 'X')],
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Remainders',
          printed_cells: `B${r}:D${r}`,
          answer_cell: `I${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'remainder', workbook_sheet: 'Remainders', questions, expectedTotal: num(rows, 46, 'K') });
  }

  // 15. ratio (17_Ratios) — 20 slots
  {
    const rows = parseSheet(g, '17_Ratios');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 5 + 2 * s;
      const aaLevel = num(rows, r, 'AA');
      const adj = num(rows, r, 'R', 0);
      const m = num(rows, r, 'P');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'ratio',
        parameters: {
          subtype: 'proportion_missing_x',
          aa_level: aaLevel,
          adjustment: adj,
          a_range: [num(rows, r, 'AR'), num(rows, r, 'AS')],
          r1_range: [num(rows, r, 'AT'), num(rows, r, 'AU')],
          r2_range: [num(rows, r, 'AV'), num(rows, r, 'AW')],
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Ratios',
          printed_cells: `B${r}:J${r}`,
          answer_cell: `M${r}`,
          mark_cell: `P${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'ratio', workbook_sheet: 'Ratios', questions, expectedTotal: num(rows, 47, 'P') });
  }

  // 16. square_root (18_Perfect_Square_Roots) — 20 slots
  {
    const rows = parseSheet(g, '18_Perfect_Square_Roots');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 4 + 2 * s;
      const tDigits = num(rows, r, 'T');
      const adj = num(rows, r, 'K', 0);
      const m = num(rows, r, 'I');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'square_root',
        parameters: {
          square_digits: tDigits,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Perfect Square Roots',
          printed_cells: `C${r}`,
          answer_cell: `G${r}`,
          mark_cell: `I${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'square_root', workbook_sheet: 'Perfect Square Roots', questions, expectedTotal: num(rows, 46, 'I') });
  }

  // 17. inexact_square_root (19_Irrational_Square_Roots) — 20 slots
  {
    const rows = parseSheet(g, '19_Irrational_Square_Roots');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 4 + 2 * s;
      const wLevel = num(rows, r, 'W');
      const adj = num(rows, r, 'N', 0);
      const dp = num(rows, r, 'G');
      const minRad = num(rows, r, 'AC');
      const maxRad = num(rows, r, 'AD');
      const m = num(rows, r, 'L');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'inexact_square_root',
        parameters: {
          w_level: wLevel,
          adjustment: adj,
          target_decimals: dp,
          min_radicand: minRad,
          max_radicand: maxRad,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Irrational Square Roots',
          printed_cells: `C${r}:H${r}`,
          answer_cell: `J${r}`,
          mark_cell: `L${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'inexact_square_root', workbook_sheet: 'Irrational Square Roots', questions, expectedTotal: num(rows, 46, 'L') });
  }

  // 18. next_square (20_Next_Squares) — 20 slots
  {
    const rows = parseSheet(g, '20_Next_Squares');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 6 + 2 * s;
      const vPow = num(rows, r, 'V');
      const adj = num(rows, r, 'M', 0);
      const m = num(rows, r, 'K');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'next_square',
        parameters: {
          subtype: 'next_square_value',
          v_power: vPow,
          n_digits: vPow + 1,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Next Squares',
          printed_cells: `B${r}:G${r}`,
          answer_cell: `J${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'next_square', workbook_sheet: 'Next Squares', questions, expectedTotal: num(rows, 48, 'K') });
  }

  // 19. cube_root (21_Cube_Roots_-_Exact) — 23 slots
  {
    const rows = parseSheet(g, '21_Cube_Roots_-_Exact');
    const questions = [];
    for (let s = 1; s <= 23; s++) {
      const r = 5 + 2 * s;
      const tPow = num(rows, r, 'T');
      const m = num(rows, r, 'I');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'cube_root',
        parameters: {
          t_power: tPow,
          cube_digits: tPow + 1,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Cube Roots - Exact',
          printed_cells: `C${r}`,
          answer_cell: `G${r}`,
          mark_cell: `I${r}`,
          generator_row: `R${r}`,
          ...(r === 51 ? {
            repair_note: 'S51 in hidden Seq column had #REF!+1 (repaired to =S49+1 = 23); printed radicand C51=[AB51], answer G51=[AA51], and mark I51=[T51] are 100% intact.',
          } : {}),
        },
      });
    }
    sections.push({ key: 'cube_root', workbook_sheet: 'Cube Roots - Exact', questions, expectedTotal: num(rows, 53, 'I') });
  }

  // 20. next_cube (22_Next_Cubes) — 19 in j1/j2, 20 in sr
  {
    const rows = parseSheet(g, '22_Next_Cubes');
    const count = g === 'sr' ? 20 : 19;
    const questions = [];
    for (let s = 1; s <= count; s++) {
      const r = 5 + 2 * s;
      const vPow = num(rows, r, 'V');
      const adj = num(rows, r, 'M', 0);
      const m = num(rows, r, 'K');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'next_cube',
        parameters: {
          subtype: 'next_cube_value',
          v_power: vPow,
          n_digits: vPow + 1,
          adjustment: adj,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Next Cubes',
          printed_cells: `B${r}:G${r}`,
          answer_cell: `J${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    const totR = g === 'sr' ? 47 : 45;
    sections.push({ key: 'next_cube', workbook_sheet: 'Next Cubes', questions, expectedTotal: num(rows, totR, 'K') });
  }

  // 21. calendar (23_Calendars) — 20 slots
  {
    const rows = parseSheet(g, '23_Calendars');
    const yMin = num(rows, 2, 'P');
    const yMax = num(rows, 2, 'R');
    const questions = [];
    for (let s = 1; s <= 15; s++) {
      const r = 7 + 2 * s;
      const m = num(rows, r, 'K');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'calendar',
        parameters: {
          subtype: 'weekday',
          year_min: yMin,
          year_max: yMax,
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Calendars',
          printed_cells: `C${r}:G${r}`,
          answer_cell: `I${r}`,
          mark_cell: `K${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    if (g === 'sr') {
      for (let s = 16; s <= 18; s++) {
        const r = 44 + 2 * (s - 16);
        const m = num(rows, r, 'K');
        questions.push({
          slot: s,
          max_marks: m,
          generator: 'calendar',
          parameters: {
            subtype: 'month',
            year_min: yMin,
            year_max: yMax,
          },
          source_ref: {
            workbook: wbName,
            sheet: 'Calendars',
            printed_cells: `B${r}:F${r}`,
            answer_cell: `C${r}`,
            mark_cell: `K${r}`,
            generator_row: `R${r}`,
          },
        });
      }
      for (let s = 19; s <= 20; s++) {
        const r = 54 + 2 * (s - 19);
        const m = num(rows, r, 'K');
        questions.push({
          slot: s,
          max_marks: m,
          generator: 'calendar',
          parameters: {
            subtype: 'year',
            year_min: yMin,
            year_max: yMax - 21,
            window_years: 20,
          },
          source_ref: {
            workbook: wbName,
            sheet: 'Calendars',
            printed_cells: `C${r}:H${r}`,
            answer_cell: `F${r}`,
            mark_cell: `K${r}`,
            generator_row: `R${r}`,
          },
        });
      }
    } else {
      for (let s = 16; s <= 20; s++) {
        const r = 44 + 2 * (s - 16);
        const m = num(rows, r, 'K');
        questions.push({
          slot: s,
          max_marks: m,
          generator: 'calendar',
          parameters: {
            subtype: 'month',
            year_min: yMin,
            year_max: yMax,
          },
          source_ref: {
            workbook: wbName,
            sheet: 'Calendars',
            printed_cells: `B${r}:F${r}`,
            answer_cell: `C${r}`,
            mark_cell: `K${r}`,
            generator_row: `R${r}`,
          },
        });
      }
    }
    const totR = g === 'sr' ? 59 : 55;
    sections.push({ key: 'calendar', workbook_sheet: 'Calendars', questions, expectedTotal: num(rows, totR, 'K') });
  }

  // 22. elapsed_time (24_Times_Elapsed) — 19 in j1, 20 in j2/sr
  {
    const rows = parseSheet(g, '24_Times_Elapsed');
    const count = g === 'j1' ? 19 : 20;
    const questions = [];
    for (let s = 1; s <= count; s++) {
      const r = 5 + 2 * s;
      const aa = num(rows, r, 'AA');
      const m = num(rows, r, 'N');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'elapsed_time',
        parameters: {
          format: 'seconds',
          aa_level: aa,
          show_dates: g === 'j1' ? false : (m > 3 || aa > 3),
          ...(g === 'j1' ? { min_seconds: 4000, max_seconds: 17999 } : {}),
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Times Elapsed',
          printed_cells: `C${r}:J${r}`,
          answer_cell: `L${r}`,
          mark_cell: `N${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    const totR = g === 'j1' ? 44 : 46;
    sections.push({ key: 'elapsed_time', workbook_sheet: 'Times Elapsed', questions, expectedTotal: num(rows, totR, 'N') });
  }

  // 23. sum_squares (25_Sums_of_Squares) — 20 slots
  {
    const rows = parseSheet(g, '25_Sums_of_Squares');
    const questions = [];
    for (let s = 1; s <= 20; s++) {
      const r = 14 + 2 * s;
      const qMin = num(rows, r, 'Q');
      const rMax = num(rows, r, 'R');
      const m = num(rows, r, 'G');
      questions.push({
        slot: s,
        max_marks: m,
        generator: 'sum_squares',
        parameters: {
          min_count: 2,
          max_count: 4,
          min_target: qMin,
          max_target: rMax,
          ...(g === 'j1' ? { mark_formula: 'L+M-2', mark_range: [2, 6] } : { mark_formula: 'AJ+J' }),
        },
        source_ref: {
          workbook: wbName,
          sheet: 'Sums of Squares',
          printed_cells: `C${r}`,
          answer_cell: `E${r}`,
          mark_cell: `G${r}`,
          generator_row: `R${r}`,
        },
      });
    }
    sections.push({ key: 'sum_squares', workbook_sheet: 'Sums of Squares', questions, expectedTotal: num(rows, 57, 'G') });
  }

  // Align every slot strictly with the database contract:
  // - Scoring metadata belongs inside parameters, NOT at slot level.
  // - Fixed slots: parameters.scoring_mode = 'fixed'. NO mark_rule or mark_range.
  // - Dynamic slots: parameters.scoring_mode = 'dynamic', parameters.mark_rule, parameters.mark_range = [min, max].
  for (const sec of sections) {
    for (const q of sec.questions) {
      delete q.scoring_mode;
      delete q.parameters.mark_formula;

      if (sec.key === 'multiplication') {
        const lo = q.parameters.d2_range[0];
        const hi = q.parameters.d2_range[1];
        const xLevel = q.parameters.x_level;
        let minM = Infinity, maxM = -Infinity;
        if (hi + 1 - lo <= 0) {
          const d1 = xLevel + 1 - lo;
          const mk = Math.floor(Math.pow(d1 * lo, 0.75) + 0.35);
          minM = mk;
          maxM = mk;
        } else {
          const minD = Math.min(lo, hi);
          const maxD = Math.max(lo, hi);
          for (let d2 = minD; d2 <= maxD; d2++) {
            const d1 = xLevel + 1 - d2;
            const mk = Math.floor(Math.pow(d1 * d2, 0.75) + 0.35);
            if (mk < minM) minM = mk;
            if (mk > maxM) maxM = mk;
          }
        }
        q.parameters.scoring_mode = 'dynamic';
        q.parameters.mark_rule = 'multiplication_digits_product';
        q.parameters.mark_range = [minM, maxM];
      } else if (sec.key === 'prime_factors') {
        q.parameters.scoring_mode = 'dynamic';
        q.parameters.mark_rule = 'prime_factors_target_scale';
        q.parameters.mark_range = [3, 10];
      } else if (sec.key === 'approximation') {
        if ((q.slot >= 1 && q.slot <= 6) || (q.slot >= 11 && q.slot <= 16)) {
          q.parameters.scoring_mode = 'dynamic';
          q.parameters.mark_rule = 'approximation_product_digits';
          q.parameters.mark_range = [2, 16];
        } else {
          // Fixed slots: 7..10 and 17..20
          q.parameters.scoring_mode = 'fixed';
          delete q.parameters.mark_rule;
          delete q.parameters.mark_range;
        }
      } else if (sec.key === 'sum_squares') {
        q.parameters.scoring_mode = 'dynamic';
        q.parameters.mark_rule =
          g === 'j1'
            ? 'sum_squares_j1_decomposition'
            : g === 'j2'
            ? 'sum_squares_j2_target'
            : 'sum_squares_sr_target';
        q.parameters.mark_range = g === 'j1' ? [2, 6] : [2, 10];
      } else {
        q.parameters.scoring_mode = 'fixed';
        delete q.parameters.mark_rule;
        delete q.parameters.mark_range;
      }
    }
  }

  return sections;
}
