/**
 * Trendz Tracker - Readable Score-Sheet Mirror Model Builder (api/_mirror.js)
 *
 * Pure functions (zero network or database calls) for building the one-way
 * Google Sheets score-sheet mirror in the classic Jr. MCWC layout:
 * - One spreadsheet (`MIRROR_SHEET_ID`), first tab `INFO`, plus one tab per active student.
 * - Within a student tab: one block per series that has at least one round
 *   (current series first on the left, blocks separated by 2 empty columns).
 * - Within each block (1-based columns from block start):
 *   Col 1: INDEX (width 45)
 *   Col 2: Category (width 150)
 *   Col 3: empty spacer column (width 10)
 *   Col 4+: each round as a pair of columns (Score width 80, Time width 60), newest round on the left.
 */

import { getScoreColorHex } from '../shared/scoreColors.js';
import { isFlatRound } from '../js/roundType.js';

export const MIRROR_FROZEN_ROWS = 4;
export const MIRROR_FROZEN_COLUMNS = 3;

/**
 * Security boundary: `jmcwc_payloads` contains generated question `answer_key` values
 * and must never be included in Google Sheets mirrors or public backups.
 */
export const MIRROR_FORBIDDEN_TABLES = Object.freeze(['jmcwc_payloads']);

export function assertMirrorExcludesPayloads(data) {
  if (!data || typeof data !== 'object') return true;
  if (Object.prototype.hasOwnProperty.call(data, 'jmcwc_payloads')) {
    throw new Error('Security violation: jmcwc_payloads must never be passed to Google Sheets mirror.');
  }
  return true;
}

export const MIRROR_COL_WIDTHS = Object.freeze({
  index: 45,
  category: 150,
  spacer: 10,
  score: 80,
  time: 60,
  separator: 30,
});

const MAX_TAB_NAME_LENGTH = 95;
const SURPRISE_TASK_REGEX = /surprise\s*task/i;

/**
 * Creates an empty cell object for the mirror grid.
 * @returns {{ text: string, bg: null, bold: boolean, align: null }}
 */
export function emptyCell() {
  return {
    text: '',
    bg: null,
    bold: false,
    align: null,
  };
}

/**
 * Creates a text cell object.
 * @param {string} text
 * @param {{ bg?: string|null, bold?: boolean, align?: 'LEFT'|'CENTER'|'RIGHT'|null }} [opts]
 */
export function textCell(text, opts = {}) {
  return {
    text: String(text ?? ''),
    bg: opts.bg || null,
    bold: Boolean(opts.bold),
    align: opts.align || null,
  };
}

/**
 * Creates a numeric cell object.
 * @param {number} num
 * @param {{ bg?: string|null, bold?: boolean, align?: 'LEFT'|'CENTER'|'RIGHT'|null }} [opts]
 */
export function numberCell(num, opts = {}) {
  const n = Number(num);
  return {
    number: n,
    bg: opts.bg || null,
    bold: Boolean(opts.bold),
    align: opts.align || 'CENTER',
  };
}

/**
 * Strips `trendz_` prefix (case-insensitive) from a student login code.
 * @param {string} code
 * @returns {string}
 */
export function shortStudentCode(code) {
  const raw = String(code || '').trim();
  return raw.replace(/^trendz_/i, '').trim() || raw;
}

/**
 * Computes a safe, unique Google Sheets tab title for a student:
 * `<name> (<code without trendz_>)` (e.g. `Riya (riya)`).
 * - Removes characters forbidden by Google Sheets in sheet titles: `[ ] * ? : / \`
 * - Trims and caps at 95 characters
 * - Appends `" 2"`, `" 3"`, etc. if already present in `usedNames`
 *
 * @param {{ name?: string, full_name?: string, code?: string, student_code?: string }} student
 * @param {Set<string>|Array<string>} [usedNames]
 * @returns {string}
 */
export function tabNameFor(student, usedNames = new Set()) {
  const usedSet = usedNames instanceof Set ? usedNames : new Set(Array.isArray(usedNames) ? usedNames : []);
  const lowerUsed = new Set(Array.from(usedSet, (n) => String(n).toLowerCase()));

  const rawName = String(student?.name ?? student?.full_name ?? 'Student')
    .replace(/[\[\]*?:\/\\]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Student';

  const rawCode = shortStudentCode(student?.code ?? student?.student_code ?? '')
    .replace(/[\[\]*?:\/\\]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, '')
    .trim();

  const suffixPart = rawCode ? ` (${rawCode})` : '';
  const maxNameChars = Math.max(1, MAX_TAB_NAME_LENGTH - suffixPart.length);
  const clippedName = rawName.slice(0, maxNameChars).trim();
  const baseTitle = `${clippedName}${suffixPart}`.slice(0, MAX_TAB_NAME_LENGTH).trim() || 'Student';

  // Reserve 'INFO' as well so a student tab can never collide with the INFO tab
  lowerUsed.add('info');

  if (!lowerUsed.has(baseTitle.toLowerCase())) {
    if (usedNames instanceof Set) {
      usedNames.add(baseTitle);
    } else if (Array.isArray(usedNames)) {
      usedNames.push(baseTitle);
    }
    return baseTitle;
  }

  let counter = 2;
  while (true) {
    const disambig = ` ${counter}`;
    const allowedBaseLen = Math.max(1, MAX_TAB_NAME_LENGTH - disambig.length);
    const candidate = `${baseTitle.slice(0, allowedBaseLen).trim()}${disambig}`;
    if (!lowerUsed.has(candidate.toLowerCase())) {
      if (usedNames instanceof Set) {
        usedNames.add(candidate);
      } else if (Array.isArray(usedNames)) {
        usedNames.push(candidate);
      }
      return candidate;
    }
    counter += 1;
  }
}

/**
 * Returns the list of `student_id`s whose `fingerprint` in `mirror_state` differs
 * from the current one in `fingerprints` (or who have no row / null fingerprint / previous error).
 * Ordered deterministically:
 * 1. Students never built (`!stateRow || !stateRow.last_built_at`) first
 * 2. Then students with the oldest `last_built_at` first
 *
 * @param {Array<{ student_id: string, fingerprint: string }>} fingerprints
 * @param {Array<{ student_id: string, fingerprint?: string|null, last_built_at?: string|null, last_error?: string|null }>} stateRows
 * @returns {string[]}
 */
export function staleStudents(fingerprints = [], stateRows = []) {
  const fpList = Array.isArray(fingerprints) ? fingerprints : [];
  const stList = Array.isArray(stateRows) ? stateRows : [];
  const stateByStudent = new Map();

  for (const row of stList) {
    if (row && row.student_id) {
      stateByStudent.set(String(row.student_id), row);
    }
  }

  const staleItems = [];
  fpList.forEach((fpRow, idx) => {
    if (!fpRow || !fpRow.student_id) return;
    const studentId = String(fpRow.student_id);
    const currentFp = fpRow.fingerprint != null ? String(fpRow.fingerprint) : '';
    const state = stateByStudent.get(studentId);

    const storedFp = state && state.fingerprint != null ? String(state.fingerprint) : null;
    const isUpToDate = storedFp !== null && storedFp === currentFp && !state?.last_error;

    if (!isUpToDate) {
      const builtAtStr = state?.last_built_at ? String(state.last_built_at) : null;
      const builtAtMs = builtAtStr ? Date.parse(builtAtStr) : NaN;
      staleItems.push({
        studentId,
        neverBuilt: !Number.isFinite(builtAtMs),
        builtAtMs: Number.isFinite(builtAtMs) ? builtAtMs : 0,
        originalIndex: idx,
      });
    }
  });

  staleItems.sort((a, b) => {
    if (a.neverBuilt !== b.neverBuilt) {
      return a.neverBuilt ? -1 : 1;
    }
    if (a.builtAtMs !== b.builtAtMs) {
      return a.builtAtMs - b.builtAtMs;
    }
    return a.originalIndex - b.originalIndex;
  });

  return staleItems.map((item) => item.studentId);
}

/**
 * Formats an ISO date (`YYYY-MM-DD` or timestamp) as `dd/mm/yyyy`.
 * @param {string|Date|null|undefined} dateInput
 * @returns {string}
 */
export function formatMirrorDate(dateInput) {
  if (!dateInput) return '';
  const raw = String(dateInput).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }
  const dmyMatch = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const dd = String(parsed.getUTCDate()).padStart(2, '0');
    const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = String(parsed.getUTCFullYear());
    return `${dd}/${mm}/${yyyy}`;
  }
  return raw;
}

/**
 * Formats per-category time in seconds:
 * - `m:ss` under an hour (e.g. `2:18`, `0:45`)
 * - `h:mm:ss` from an hour up (e.g. `1:05:09`)
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatCategoryTime(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  if (sec < 3600) {
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${mins}:${String(remSec).padStart(2, '0')}`;
  }
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

/**
 * Formats total round `Time Taken` in seconds as `hh:mm:ss` (e.g. `01:09:01`).
 * @param {number} seconds
 * @returns {string}
 */
export function formatSummaryTimeTaken(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

/**
 * Checks whether a category cell has a numeric score (`correct` and `total` with `total > 0`).
 * @param {any} cell
 * @returns {boolean}
 */
function hasNumericScore(cell) {
  if (!cell || typeof cell !== 'object') return false;
  if (cell.correct === null || cell.correct === undefined || cell.correct === '') return false;
  if (cell.total === null || cell.total === undefined || cell.total === '') return false;
  const c = Number(cell.correct);
  const t = Number(cell.total);
  return Number.isFinite(c) && Number.isFinite(t) && t > 0 && c >= 0;
}

/**
 * Builds the complete cell grid and layout metadata for one student's mirror tab.
 *
 * @param {{
 *   student?: { id?: string, code?: string, name?: string, level?: string|null },
 *   series?: Array<{ id: string, name: string, is_current?: boolean }>,
 *   categories?: Array<{ id: string, name: string, series_id: string, sort_order?: number }>,
 *   rounds?: Array<{
 *     id: string,
 *     series_id: string,
 *     number: number,
 *     date: string,
 *     type?: string,
 *     time_taken_seconds?: number|null,
 *     cells?: Array<{
 *       category_id: string,
 *       correct?: number|null,
 *       total?: number|null,
 *       time_seconds?: number|null,
 *       note?: string|null
 *     }>
 *   }>
 * }} data
 */
export function buildStudentTabModel(data = {}) {
  const student = data?.student || {};
  const studentNameUpper = String(student.name || student.full_name || 'STUDENT')
    .trim()
    .toUpperCase();
  const studentLevelUpper =
    typeof student.level === 'string' && student.level.trim().length > 0
      ? student.level.trim().toUpperCase()
      : null;

  const seriesList = Array.isArray(data?.series) ? [...data.series] : [];
  const categoriesList = Array.isArray(data?.categories) ? [...data.categories] : [];
  const roundsList = Array.isArray(data?.rounds) ? [...data.rounds] : [];

  // Sort series so current series is always first, preserving original order otherwise
  const sortedSeries = seriesList
    .map((s, idx) => ({ ...s, _origIdx: idx }))
    .sort((a, b) => {
      const aCurr = Boolean(a.is_current);
      const bCurr = Boolean(b.is_current);
      if (aCurr !== bCurr) return aCurr ? -1 : 1;
      return a._origIdx - b._origIdx;
    });

  // Build blocks only for series that have at least one round
  const blocks = [];
  for (const s of sortedSeries) {
    const seriesRounds = roundsList.filter((r) => r && r.series_id === s.id);
    if (seriesRounds.length === 0) continue;

    const seriesCategories = categoriesList
      .filter((c) => c && c.series_id === s.id)
      .map((c, idx) => ({ ...c, _origIdx: idx }))
      .sort((a, b) => {
        const sa = Number(a.sort_order ?? 0);
        const sb = Number(b.sort_order ?? 0);
        if (sa !== sb) return sa - sb;
        return a._origIdx - b._origIdx;
      });

    blocks.push({
      series: s,
      categories: seriesCategories,
      rounds: seriesRounds,
    });
  }

  // If the student has no rounds yet, still return a valid header grid
  if (blocks.length === 0) {
    const rowCount = 10;
    const columnCount = 5;
    const cells = Array.from({ length: rowCount }, () =>
      Array.from({ length: columnCount }, () => emptyCell())
    );
    cells[0][0] = textCell(`Name -- ${studentNameUpper}`, { bold: true, align: 'LEFT' });
    cells[1][0] = textCell('INDEX', { bold: true, align: 'CENTER' });
    cells[1][1] = textCell('Category', { bold: true, align: 'LEFT' });

    const columnWidths = [
      { colIndex: 0, width: MIRROR_COL_WIDTHS.index },
      { colIndex: 1, width: MIRROR_COL_WIDTHS.category },
      { colIndex: 2, width: MIRROR_COL_WIDTHS.spacer },
      { colIndex: 3, width: MIRROR_COL_WIDTHS.score },
      { colIndex: 4, width: MIRROR_COL_WIDTHS.time },
    ];

    return {
      cells,
      rows: cells,
      rowCount,
      columnCount,
      frozenRows: MIRROR_FROZEN_ROWS,
      frozenColumns: MIRROR_FROZEN_COLUMNS,
      columnWidths,
    };
  }

  // Compute starting column and column widths for each block
  const columnWidths = [];
  let currentCol = 0;

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    if (bIdx > 0) {
      // Two empty separator columns between blocks
      columnWidths.push({ colIndex: currentCol, width: MIRROR_COL_WIDTHS.separator });
      columnWidths.push({ colIndex: currentCol + 1, width: MIRROR_COL_WIDTHS.separator });
      currentCol += 2;
    }

    const block = blocks[bIdx];
    block.startCol = currentCol;

    columnWidths.push({ colIndex: currentCol + 0, width: MIRROR_COL_WIDTHS.index });
    columnWidths.push({ colIndex: currentCol + 1, width: MIRROR_COL_WIDTHS.category });
    columnWidths.push({ colIndex: currentCol + 2, width: MIRROR_COL_WIDTHS.spacer });

    for (let rIdx = 0; rIdx < block.rounds.length; rIdx++) {
      const scoreCol = currentCol + 3 + rIdx * 2;
      const timeCol = scoreCol + 1;
      columnWidths.push({ colIndex: scoreCol, width: MIRROR_COL_WIDTHS.score });
      columnWidths.push({ colIndex: timeCol, width: MIRROR_COL_WIDTHS.time });
    }

    currentCol += 3 + block.rounds.length * 2;
  }

  const maxCategories = Math.max(0, ...blocks.map((b) => b.categories.length));
  // 4 header rows + maxCategories rows + 1 empty row + 5 summary rows
  const rowCount = 4 + maxCategories + 1 + 5;
  const columnCount = currentCol;

  const cells = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => emptyCell())
  );

  // Row 1 (index 0), first cell of the first block: "Name -- <FULL NAME IN CAPITALS>"
  cells[0][0] = textCell(`Name -- ${studentNameUpper}`, { bold: true, align: 'LEFT' });

  const summaryStartRow = 4 + maxCategories + 1; // 0-based index after the empty separator row

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx];
    const startCol = block.startCol;

    // Row 2 (index 1): INDEX & Category headers
    cells[1][startCol + 0] = textCell('INDEX', { bold: true, align: 'CENTER' });
    cells[1][startCol + 1] = textCell('Category', { bold: true, align: 'LEFT' });

    // Category rows (Row 5+ -> index 4+)
    for (let cIdx = 0; cIdx < block.categories.length; cIdx++) {
      const cat = block.categories[cIdx];
      const rowIdx = 4 + cIdx;
      cells[rowIdx][startCol + 0] = numberCell(cIdx + 1, { bold: false, align: 'CENTER' });
      cells[rowIdx][startCol + 1] = textCell(cat.name, { bold: false, align: 'LEFT' });
    }

    // Summary row labels in the block's Category column (startCol + 1)
    cells[summaryStartRow + 0][startCol + 1] = textCell('Round Type', { bold: true, align: 'LEFT' });
    cells[summaryStartRow + 1][startCol + 1] = textCell('Time Taken', { bold: true, align: 'LEFT' });
    cells[summaryStartRow + 2][startCol + 1] = textCell('Final Score', { bold: true, align: 'LEFT' });
    cells[summaryStartRow + 3][startCol + 1] = textCell('Total Attempt', { bold: true, align: 'LEFT' });
    cells[summaryStartRow + 4][startCol + 1] = textCell('Marks TO BE CORRECTED', {
      bold: true,
      align: 'LEFT',
    });

    // Populate each round pair of columns (Score, Time)
    for (let rIdx = 0; rIdx < block.rounds.length; rIdx++) {
      const round = block.rounds[rIdx];
      const scoreCol = startCol + 3 + rIdx * 2;
      const timeCol = scoreCol + 1;
      const flat = isFlatRound(round?.type);

      // Row 1 (index 0): level in capitals above each round's Score column (if student has one)
      if (studentLevelUpper) {
        cells[0][scoreCol] = textCell(studentLevelUpper, { bold: true, align: 'CENTER' });
      }

      // Row 2 (index 1): ROUND <n>
      cells[1][scoreCol] = textCell(`ROUND ${round.number}`, { bold: true, align: 'CENTER' });

      // Row 3 (index 2): Date - dd/mm/yyyy
      cells[2][scoreCol] = textCell(`Date - ${formatMirrorDate(round.date)}`, {
        bold: true,
        align: 'CENTER',
      });

      // Row 4 (index 3): Score & Time labels
      cells[3][scoreCol] = textCell('Score', { bold: true, align: 'CENTER' });
      cells[3][timeCol] = textCell('Time', { bold: true, align: 'CENTER' });

      // Map round cells by category_id
      const cellMap = new Map();
      if (Array.isArray(round?.cells)) {
        for (const rc of round.cells) {
          if (rc && rc.category_id) {
            cellMap.set(String(rc.category_id), rc);
          }
        }
      }

      let finalScore = 0;
      let totalAttempt = 0;
      let summedCategorySeconds = 0;

      for (let cIdx = 0; cIdx < block.categories.length; cIdx++) {
        const cat = block.categories[cIdx];
        const rowIdx = 4 + cIdx;
        const rc = cellMap.get(String(cat.id));
        const isSurprise = SURPRISE_TASK_REGEX.test(String(cat.name || ''));
        const hasScore = hasNumericScore(rc);

        if (isSurprise) {
          if (hasScore) {
            const cVal = Number(rc.correct);
            const tVal = Number(rc.total);
            finalScore += cVal;
            totalAttempt += tVal;
            cells[rowIdx][scoreCol] = textCell(`${cVal}/${tVal}`, {
              bg: getScoreColorHex(cVal, tVal),
              bold: false,
              align: 'CENTER',
            });
          } else if (rc && typeof rc.note === 'string' && rc.note.trim().length > 0) {
            cells[rowIdx][scoreCol] = textCell(rc.note.trim().slice(0, 40), {
              bg: null,
              bold: false,
              align: 'CENTER',
            });
          } else {
            cells[rowIdx][scoreCol] = textCell('........', {
              bg: null,
              bold: false,
              align: 'CENTER',
            });
          }
        } else if (hasScore) {
          const cVal = Number(rc.correct);
          const tVal = Number(rc.total);
          finalScore += cVal;
          totalAttempt += tVal;
          cells[rowIdx][scoreCol] = textCell(`${cVal}/${tVal}`, {
            bg: getScoreColorHex(cVal, tVal),
            bold: false,
            align: 'CENTER',
          });
        }

        // Time cell: empty for flat rounds; formatted m:ss or h:mm:ss otherwise when score/note exists
        const hasSurpriseNote =
          isSurprise && rc && typeof rc.note === 'string' && rc.note.trim().length > 0;
        if (
          !flat &&
          (hasScore || hasSurpriseNote) &&
          rc &&
          rc.time_seconds !== null &&
          rc.time_seconds !== undefined &&
          rc.time_seconds !== '' &&
          Number.isFinite(Number(rc.time_seconds)) &&
          Number(rc.time_seconds) >= 0
        ) {
          const secVal = Number(rc.time_seconds);
          summedCategorySeconds += secVal;
          cells[rowIdx][timeCol] = textCell(formatCategoryTime(secVal), {
            bg: null,
            bold: false,
            align: 'CENTER',
          });
        }
      }

      // Summary Row 1: Round Type
      const roundTypeLabel =
        typeof round?.type === 'string' && round.type.trim().length > 0
          ? round.type.trim()
          : 'Category wise';
      cells[summaryStartRow + 0][scoreCol] = textCell(roundTypeLabel, {
        bg: null,
        bold: true,
        align: 'CENTER',
      });

      // Summary Row 2: Time Taken (hh:mm:ss or "Without time")
      let totalTimeSec = null;
      if (
        round?.time_taken_seconds !== null &&
        round?.time_taken_seconds !== undefined &&
        Number(round.time_taken_seconds) > 0
      ) {
        totalTimeSec = Number(round.time_taken_seconds);
      } else if (!flat && summedCategorySeconds > 0) {
        totalTimeSec = summedCategorySeconds;
      }

      const timeTakenStr =
        totalTimeSec !== null && totalTimeSec > 0
          ? formatSummaryTimeTaken(totalTimeSec)
          : 'Without time';
      cells[summaryStartRow + 1][scoreCol] = textCell(timeTakenStr, {
        bg: null,
        bold: true,
        align: 'CENTER',
      });

      // Summary Row 3: Final Score (number)
      cells[summaryStartRow + 2][scoreCol] = numberCell(finalScore, {
        bg: null,
        bold: true,
        align: 'CENTER',
      });

      // Summary Row 4: Total Attempt (number)
      cells[summaryStartRow + 3][scoreCol] = numberCell(totalAttempt, {
        bg: null,
        bold: true,
        align: 'CENTER',
      });

      // Summary Row 5: Marks TO BE CORRECTED (number = Total Attempt - Final Score)
      cells[summaryStartRow + 4][scoreCol] = numberCell(totalAttempt - finalScore, {
        bg: null,
        bold: true,
        align: 'CENTER',
      });
    }
  }

  return {
    cells,
    rows: cells,
    rowCount,
    columnCount,
    frozenRows: MIRROR_FROZEN_ROWS,
    frozenColumns: MIRROR_FROZEN_COLUMNS,
    columnWidths,
  };
}

/**
 * Builds the model for the `INFO` first tab.
 *
 * @param {Array<{ name?: string, code?: string, level?: string|null, tab_name?: string, last_built_at?: string|null }>} students
 * @param {string} [builtAtIso]
 */
export function buildInfoModel(students = [], builtAtIso = new Date().toISOString()) {
  const list = Array.isArray(students) ? students : [];
  const rowCount = Math.max(10, 6 + list.length);
  const columnCount = 5;
  const cells = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => emptyCell())
  );

  cells[0][0] = textCell('TRENDZ TRACKER — SCORE SHEET MIRROR (READ-ONLY)', {
    bold: true,
    align: 'LEFT',
  });
  cells[1][0] = textCell(
    'Do not edit — this sheet is overwritten from the website. To work during a website outage, make a copy first (File -> Make a copy).',
    { bold: true, align: 'LEFT' }
  );
  cells[2][0] = textCell(`Last updated: ${builtAtIso}`, { bold: false, align: 'LEFT' });

  // Table headers on Row 5 (index 4)
  cells[4][0] = textCell('Student Name', { bold: true, align: 'LEFT' });
  cells[4][1] = textCell('Student ID', { bold: true, align: 'LEFT' });
  cells[4][2] = textCell('Level', { bold: true, align: 'LEFT' });
  cells[4][3] = textCell('Tab Name', { bold: true, align: 'LEFT' });
  cells[4][4] = textCell('Last Built (UTC)', { bold: true, align: 'LEFT' });

  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const r = 5 + i;
    cells[r][0] = textCell(s.name || '', { align: 'LEFT' });
    cells[r][1] = textCell(s.code || '', { align: 'LEFT' });
    cells[r][2] = textCell(s.level || '—', { align: 'LEFT' });
    cells[r][3] = textCell(s.tab_name || '', { align: 'LEFT' });
    cells[r][4] = textCell(s.last_built_at || '', { align: 'LEFT' });
  }

  return {
    cells,
    rows: cells,
    rowCount,
    columnCount,
    frozenRows: 5,
    frozenColumns: 0,
    columnWidths: [
      { colIndex: 0, width: 180 },
      { colIndex: 1, width: 140 },
      { colIndex: 2, width: 110 },
      { colIndex: 3, width: 200 },
      { colIndex: 4, width: 180 },
    ],
  };
}

/**
 * Serializes a tab model built by `buildStudentTabModel` into RFC 4180 CSV text.
 * Used by round-trip unit tests with `parseScoreSheetCsv` and emergency exports.
 *
 * @param {{ cells: Array<Array<{ text?: string, number?: number }>> }} model
 * @returns {string}
 */
export function modelToCsv(model) {
  const rows = Array.isArray(model?.cells) ? model.cells : [];
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const raw =
            cell && typeof cell.number === 'number' && Number.isFinite(cell.number)
              ? String(cell.number)
              : String(cell?.text ?? '');
          if (/[",\r\n]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
          }
          return raw;
        })
        .join(',')
    )
    .join('\n');
}
