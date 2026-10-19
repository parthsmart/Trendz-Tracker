/**
 * Trendz Tracker — Hand-Written CSV & Multi-Block Score Sheet Parser (js/importParser.js)
 *
 * STRICT ARCHITECTURAL RULES (Phase 4c-1):
 * - 100% pure JavaScript functions.
 * - NO DOM calls (no document, window, FileReader, innerHTML).
 * - NO import.meta.env references (must run directly in Node.js with `node --test`).
 * - Read-only preview parser: performs zero database mutations or network calls.
 */

/**
 * Built-in category aliases (normalised key -> target normalised key).
 * Never queries a category_aliases table; uses only these built-in mappings.
 */
export const BUILT_IN_CATEGORY_ALIASES = Object.freeze({
  calender: 'calendar',
  timeelapse: 'timeelapsed',
});

/**
 * Converts a 0-based column index into a spreadsheet column label.
 * Examples: 0 -> 'A', 25 -> 'Z', 26 -> 'AA', 153 -> 'EX'.
 *
 * @param {number} colIndex - 0-based column number
 * @returns {string} Spreadsheet column letters
 */
export function colLabel(colIndex) {
  let n = Math.trunc(Number(colIndex));
  if (isNaN(n) || n < 0) return 'A';
  let label = '';
  while (n >= 0) {
    const rem = n % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/**
 * Builds an A1-style spreadsheet coordinate from 0-based row and column indices.
 * Example: rowIndex = 9, colIndex = 14 -> 'O10'.
 *
 * @param {number} rowIndex - 0-based row index
 * @param {number} colIndex - 0-based column index
 * @returns {string} Cell reference such as 'D5' or 'O10'
 */
export function cellRef(rowIndex, colIndex) {
  return `${colLabel(colIndex)}${rowIndex + 1}`;
}

/**
 * Normalises a category name for matching:
 * lowercases, strips all whitespace, and applies built-in aliases.
 *
 * @param {string} name - Raw category name
 * @returns {{ rawKey: string, normalizedKey: string, usedAlias: boolean, aliasTarget: string|null }}
 */
export function normalizeCategoryKey(name) {
  const rawKey = String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const aliasTarget = BUILT_IN_CATEGORY_ALIASES[rawKey] || null;
  return {
    rawKey,
    normalizedKey: aliasTarget || rawKey,
    usedAlias: Boolean(aliasTarget),
    aliasTarget,
  };
}

/**
 * Hand-written RFC-4180 compliant CSV parser.
 * Handles:
 * - UTF-8 BOM (\uFEFF) at the start of the text
 * - Quoted fields ("...")
 * - Escaped quotes inside quoted fields ("")
 * - Commas and newlines (\n, \r\n) inside quoted fields
 * - CRLF (\r\n), LF (\n), and CR (\r) line endings
 * - Ragged rows (pads all rows to the widest row + spare columns)
 *
 * @param {string} csvText - Raw CSV file content
 * @param {number} [spareCols=4] - Extra trailing empty columns added to every row
 * @returns {string[][]} 2D rectangular array of strings
 */
export function parseCsv(csvText, spareCols = 4) {
  if (typeof csvText !== 'string' || csvText.length === 0) {
    return [];
  }

  // Strip UTF-8 BOM if present
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped double-quote ""
        if (i + 1 < len && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        currentField += ch;
        i += 1;
        continue;
      }
    } else {
      // Not inside quotes
      if (ch === '"' && currentField.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }

      if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
        i += 1;
        continue;
      }

      if (ch === '\r') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        if (i + 1 < len && text[i + 1] === '\n') {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      if (ch === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i += 1;
        continue;
      }

      currentField += ch;
      i += 1;
    }
  }

  // Push final field/row if we didn't just end on a newline with an empty row
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];

  // Find widest row and pad all rows to widest + spareCols
  let maxCols = 0;
  for (const r of rows) {
    if (r.length > maxCols) maxCols = r.length;
  }

  const targetWidth = maxCols + Math.max(2, spareCols);
  for (const r of rows) {
    while (r.length < targetWidth) {
      r.push('');
    }
  }

  return rows;
}

// Alias for callers expecting parseCsvGrid
export const parseCsvGrid = parseCsv;

/**
 * Checks whether a cell's text represents an intentionally blank/placeholder cell
 * (empty, or only dots, dashes, and spaces).
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isEmptyOrPlaceholderCell(raw) {
  const str = String(raw ?? '');
  return /^[.\-\s]*$/.test(str);
}

/**
 * Database constraint constants mirrored from PostgreSQL `admin_import_rounds`.
 */
export const MAX_ROUND_NUMBER = 100000;
export const MIN_ROUND_DATE_ISO = '2020-01-01';
export const MAX_ROUND_TYPE_LENGTH = 40;
export const MAX_ROUND_TOTAL_TIME_SECONDS = 28800; // 8 hours (8:00:00)
export const MAX_CELL_TIME_SECONDS = 14400; // 4 hours (4:00:00)
export const MAX_NOTE_LENGTH = 500;

/**
 * Parses a category Time cell (or summary Time Taken cell when options.maxSeconds = Infinity).
 * Accepted formats:
 * - Empty or dots/dashes/spaces -> status: 'empty', seconds: null
 * - m:ss or mm:ss (seconds < 60) -> status: 'ok', seconds: mins * 60 + secs
 * - h:mm:ss (minutes < 60, seconds < 60) -> status: 'ok', seconds: hrs * 3600 + mins * 60 + secs
 * - Cell times above `maxSeconds` (default 14400 = 4 hours) -> status: 'unreadable'
 * - Plain numbers (e.g. "75") or anything else -> status: 'unreadable' (never guessed)
 *
 * @param {string} rawTime
 * @param {{ maxSeconds?: number }} [options={}]
 * @returns {{ status: 'empty'|'ok'|'unreadable', seconds: number|null, raw: string, reason: string|null }}
 */
export function parseTimeCell(rawTime, options = {}) {
  const maxSeconds =
    options && options.maxSeconds !== undefined ? options.maxSeconds : MAX_CELL_TIME_SECONDS;
  const raw = String(rawTime ?? '');
  if (isEmptyOrPlaceholderCell(raw)) {
    return { status: 'empty', seconds: null, raw, reason: null };
  }

  const trimmed = raw.trim();

  // Match m:ss or mm:ss (or mmm:ss)
  const mmss = trimmed.match(/^(\d{1,3}):(\d{2})$/);
  if (mmss) {
    const mins = parseInt(mmss[1], 10);
    const secs = parseInt(mmss[2], 10);
    if (secs >= 60) {
      return {
        status: 'unreadable',
        seconds: null,
        raw,
        reason: `Invalid seconds in time "${trimmed}" (must be 00–59)`,
      };
    }
    const totalSeconds = mins * 60 + secs;
    if (totalSeconds > maxSeconds) {
      return {
        status: 'unreadable',
        seconds: null,
        raw,
        reason: `Cell time "${trimmed}" is more than 4 hours (max 4:00:00)`,
      };
    }
    return { status: 'ok', seconds: totalSeconds, raw, reason: null };
  }

  // Match h:mm:ss (or hhh:mm:ss)
  const hhmmss = trimmed.match(/^(\d{1,4}):(\d{2}):(\d{2})$/);
  if (hhmmss) {
    const hrs = parseInt(hhmmss[1], 10);
    const mins = parseInt(hhmmss[2], 10);
    const secs = parseInt(hhmmss[3], 10);
    if (mins >= 60 || secs >= 60) {
      return {
        status: 'unreadable',
        seconds: null,
        raw,
        reason: `Invalid minutes/seconds in time "${trimmed}" (must be 00–59)`,
      };
    }
    const totalSeconds = hrs * 3600 + mins * 60 + secs;
    if (totalSeconds > maxSeconds) {
      return {
        status: 'unreadable',
        seconds: null,
        raw,
        reason: `Cell time "${trimmed}" is more than 4 hours (max 4:00:00)`,
      };
    }
    return {
      status: 'ok',
      seconds: totalSeconds,
      raw,
      reason: null,
    };
  }

  // Plain numbers like "75" or any other text are unreadable (never guessed)
  return {
    status: 'unreadable',
    seconds: null,
    raw,
    reason: `Unreadable time "${trimmed}" (expected m:ss or h:mm:ss; plain numbers are not guessed)`,
  };
}

/**
 * Formats seconds into h:mm:ss or m:ss for display.
 *
 * @param {number|null|undefined} seconds
 * @param {boolean} [forceHours=false]
 * @returns {string}
 */
export function formatSecondsDisplay(seconds, forceHours = false) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.round(Number(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const ss = String(secs).padStart(2, '0');
  if (hrs > 0 || forceHours) {
    const mm = String(mins).padStart(2, '0');
    return `${hrs}:${mm}:${ss}`;
  }
  return `${mins}:${ss}`;
}

/**
 * Parses a category Score cell.
 * - Empty or dots/dashes/spaces -> status: 'empty'
 * - Ratio correct/total -> validates total > 0 and correct <= total
 * - Surprise Task non-ratio text -> status: 'note', stores text in note
 * - Any other text -> status: 'unreadable'
 *
 * @param {string} rawScore
 * @param {boolean} [isSurpriseTask=false]
 * @returns {{ status: 'empty'|'ok'|'unreadable'|'note', correct: number|null, total: number|null, note: string|null, reason: string|null }}
 */
export function parseScoreCell(rawScore, isSurpriseTask = false) {
  const raw = String(rawScore ?? '');
  if (isEmptyOrPlaceholderCell(raw)) {
    return { status: 'empty', correct: null, total: null, note: null, reason: null };
  }

  const trimmed = raw.trim();
  const ratioMatch = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);

  if (ratioMatch) {
    const correct = parseInt(ratioMatch[1], 10);
    const total = parseInt(ratioMatch[2], 10);
    if (total <= 0) {
      return {
        status: 'unreadable',
        correct,
        total,
        note: null,
        reason: `Unreadable score "${trimmed}" (total must be greater than 0)`,
      };
    }
    if (correct > total) {
      return {
        status: 'unreadable',
        correct,
        total,
        note: null,
        reason: `Unreadable score "${trimmed}" (correct ${correct} exceeds total ${total})`,
      };
    }
    return { status: 'ok', correct, total, note: null, reason: null };
  }

  if (isSurpriseTask) {
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return {
        status: 'note',
        correct: null,
        total: null,
        note: trimmed.slice(0, MAX_NOTE_LENGTH),
        noteTruncated: true,
        originalNoteLength: trimmed.length,
        reason: null,
      };
    }
    return {
      status: 'note',
      correct: null,
      total: null,
      note: trimmed,
      reason: null,
    };
  }

  return {
    status: 'unreadable',
    correct: null,
    total: null,
    note: null,
    reason: `Unreadable score "${trimmed}" (expected correct/total ratio)`,
  };
}

/**
 * Classifies whether a label in the Category or INDEX column is one of the 5 summary rows.
 *
 * @param {string} text
 * @returns {'roundType'|'timeTaken'|'finalScore'|'totalAttempt'|'marksToBeCorrected'|null}
 */
export function classifySummaryLabel(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^round\s*type$/i.test(t)) return 'roundType';
  if (/^time\s*taken$/i.test(t)) return 'timeTaken';
  if (/^final\s*score$/i.test(t)) return 'finalScore';
  if (/^total\s*attempt\s*$/i.test(t)) return 'totalAttempt';
  if (/^marks\s*to\s*be\s*corrected$/i.test(t)) return 'marksToBeCorrected';
  return null;
}

/**
 * Helper to return the number of days in a calendar month (1–12).
 *
 * @param {number} year
 * @param {number} month - 1 to 12
 * @returns {number}
 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validates and converts day, month, year into YYYY-MM-DD, or null if impossible.
 *
 * @param {number} day
 * @param {number} month
 * @param {number} year
 * @returns {string|null}
 */
function buildValidISODate(day, month, year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const maxDay = daysInMonth(year, month);
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Computes current IST date string (YYYY-MM-DD) as a fallback when todayIST is not passed.
 *
 * @returns {string}
 */
export function getDefaultTodayIST() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Main entry point: parses a student's multi-block CSV score sheet and produces
 * a complete read-only diagnostic preview object.
 *
 * @param {string} csvText - Raw CSV file content
 * @param {Object} [options={}]
 * @param {Array<{id?: string, name: string, section?: string, active?: boolean, sort_order?: number}>} [options.roundCategories=[]] - DB round categories (active and inactive)
 * @param {'auto'|'DD/MM'|'MM/DD'} [options.dateFormat='auto'] - Selected date format mode
 * @param {string} [options.todayIST] - Authoritative Indian date YYYY-MM-DD from today_ist()
 * @param {string} [options.selectedStudentName=''] - Name of the student chosen in Step 1
 * @returns {Object} Structured parse & validation result
 */
export function parseScoreSheetCsv(csvText, options = {}) {
  const {
    roundCategories = [],
    dateFormat = 'auto',
    todayIST = getDefaultTodayIST(),
    selectedStudentName = '',
  } = options;

  const grid = parseCsv(csvText, 4);
  if (grid.length === 0) {
    return {
      ok: false,
      error: 'Layout not recognised: the CSV file is empty.',
      blocks: [],
      needsAttention: [],
      summary: null,
    };
  }

  // 1. Locate the Header Row: the first row containing at least one cell whose trimmed text is "Category" (case-insensitive)
  let headerRowIdx = -1;
  const categoryCols = [];

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const foundCols = [];
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] ?? '').trim().toLowerCase() === 'category') {
        foundCols.push(c);
      }
    }
    if (foundCols.length > 0) {
      headerRowIdx = r;
      categoryCols.push(...foundCols);
      break;
    }
  }

  if (headerRowIdx === -1 || categoryCols.length === 0) {
    return {
      ok: false,
      error: 'Layout not recognised: no "Category" header column found.',
      blocks: [],
      needsAttention: [],
      summary: null,
    };
  }

  const gridWidth = grid[0].length;

  // 2. Partition into horizontal blocks
  // Each block runs from its Category column to just before the next block's Category column minus one (its INDEX column), or to the end.
  const rawBlocks = categoryCols.map((catCol, idx) => {
    const nextCatCol = idx + 1 < categoryCols.length ? categoryCols[idx + 1] : null;
    const indexCol = catCol > 0 ? catCol - 1 : null;
    const endCol = nextCatCol !== null ? Math.max(catCol, nextCatCol - 2) : gridWidth - 1;
    const blockNumber = idx + 1;
    const defaultSeriesName = blockNumber === 1 ? 'Block 1 (left)' : `Block ${blockNumber}`;

    return {
      blockIndex: idx,
      blockNumber,
      defaultSeriesName,
      seriesName: defaultSeriesName,
      indexCol,
      categoryCol: catCol,
      endCol,
      headerRowIdx,
      candidateRounds: [],
      ignoredRounds: [],
      rounds: [],
      categories: [],
      absentDbCategories: [],
      strayValues: [],
      dateWarnings: [],
      dateErrors: [],
      dateInfos: [],
      studentNames: [],
      levelLabels: [],
      labelHints: [],
    };
  });

  // 3. Scan top metadata rows (above headerRowIdx) for Name cells, JUNIOR level labels, and other block label hints
  const studentNames = [];
  const levelLabelsSet = new Set();
  const levelLabelsList = [];
  const labelHints = [];
  const needsAttention = [];

  // Helper to find which block a column visually belongs to (or nearest block)
  function findBlockForCol(c) {
    for (let b = rawBlocks.length - 1; b >= 0; b--) {
      const start = rawBlocks[b].indexCol !== null ? rawBlocks[b].indexCol : rawBlocks[b].categoryCol;
      if (c >= start) return rawBlocks[b];
    }
    return rawBlocks[0];
  }

  for (let r = 0; r < headerRowIdx; r++) {
    for (let c = 0; c < gridWidth; c++) {
      const rawCell = String(grid[r][c] ?? '');
      const trimmed = rawCell.trim();
      if (!trimmed || isEmptyOrPlaceholderCell(trimmed)) continue;

      const ref = cellRef(r, c);
      const blk = findBlockForCol(c);

      // Name cell: starts with "Name" (strip "Name", dashes, colons, spaces)
      if (/^name\b/i.test(trimmed)) {
        const extractedName = trimmed.replace(/^name[\s\-–—:]+/i, '').trim();
        if (extractedName) {
          const entry = { name: extractedName, raw: trimmed, ref, row: r, col: c, blockNumber: blk.blockNumber };
          studentNames.push(entry);
          blk.studentNames.push(entry);
        }
        continue;
      }

      // Level label: matches /^junior/i
      if (/^junior/i.test(trimmed)) {
        blk.levelLabels.push({ label: trimmed, ref });
        if (!levelLabelsSet.has(trimmed)) {
          levelLabelsSet.add(trimmed);
          levelLabelsList.push(trimmed);
        }
        continue;
      }

      // Any other non-empty text in top rows (e.g. "NEW SIMULATOR") -> show as a hint, never auto-assign to a block
      const hintEntry = { text: trimmed, ref, row: r, col: c };
      labelHints.push(hintEntry);
      blk.labelHints.push(hintEntry);
    }
  }

  // Check if multiple Name cells in the sheet disagree
  let studentNameMismatchWarning = null;
  if (studentNames.length > 1) {
    const firstNorm = studentNames[0].name.toLowerCase().replace(/\s+/g, ' ');
    for (let i = 1; i < studentNames.length; i++) {
      const otherNorm = studentNames[i].name.toLowerCase().replace(/\s+/g, ' ');
      if (otherNorm !== firstNorm) {
        const msg = `Student name mismatch inside sheet: "${studentNames[0].name}" (${studentNames[0].ref}) vs "${studentNames[i].name}" (${studentNames[i].ref}).`;
        studentNameMismatchWarning = msg;
        needsAttention.push({
          severity: 'warning',
          type: 'name_mismatch',
          blockNumber: studentNames[i].blockNumber,
          roundNumber: null,
          ref: studentNames[i].ref,
          message: msg,
        });
      }
    }
  }

  // Check if sheet name differs from selected student name (warning only, does not block)
  if (selectedStudentName && studentNames.length > 0) {
    const selNorm = selectedStudentName.trim().toLowerCase().replace(/\s+/g, ' ');
    const sheetNorm = studentNames[0].name.toLowerCase().replace(/\s+/g, ' ');
    if (selNorm && sheetNorm && selNorm !== sheetNorm) {
      const msg = `Sheet student name "${studentNames[0].name}" (${studentNames[0].ref}) differs from selected student "${selectedStudentName.trim()}".`;
      if (!studentNameMismatchWarning) studentNameMismatchWarning = msg;
      needsAttention.push({
        severity: 'warning',
        type: 'selected_student_mismatch',
        blockNumber: studentNames[0].blockNumber,
        roundNumber: null,
        ref: studentNames[0].ref,
        message: msg,
      });
    }
  }

  // 4. Discover Round columns in each block's header row (/^round\s*(\d+)$/i)
  let totalCandidateRounds = 0;
  for (const blk of rawBlocks) {
    for (let c = blk.categoryCol + 1; c <= blk.endCol; c++) {
      const headerText = String(grid[headerRowIdx][c] ?? '').trim();
      const m = headerText.match(/^round\s*(\d+)$/i);
      if (m) {
        const roundNumber = parseInt(m[1], 10);
        blk.candidateRounds.push({
          roundNumber,
          rawHeader: headerText,
          headerRef: cellRef(headerRowIdx, c),
          scoreCol: c,
          timeCol: c + 1,
        });
        totalCandidateRounds += 1;
      }
    }
  }

  if (totalCandidateRounds === 0) {
    return {
      ok: false,
      error: 'Layout not recognised: no Round headers (matching "Round <number>") found.',
      blocks: [],
      needsAttention: [],
      summary: null,
    };
  }

  // 5. Find the first category row below headerRowIdx
  // Rows between headerRowIdx + 1 and firstCategoryRowIdx - 1 are the Date / Score-Time sub-header rows.
  const dateRegex = /(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/;
  let firstCategoryRowIdx = -1;

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    // Check if any round scoreCol in this row has "Score" label or a date
    let isScoreLabelRow = false;
    let hasDateInScoreCol = false;

    for (const blk of rawBlocks) {
      for (const cand of blk.candidateRounds) {
        const scText = String(grid[r][cand.scoreCol] ?? '').trim();
        const tmText = String(grid[r][cand.timeCol] ?? '').trim();
        if (/^score$/i.test(scText) || /^time$/i.test(tmText)) {
          isScoreLabelRow = true;
        }
        if (dateRegex.test(scText)) {
          hasDateInScoreCol = true;
        }
      }
    }

    if (isScoreLabelRow || hasDateInScoreCol) {
      continue;
    }

    // Check if any block has a non-empty Category cell in this row
    let hasCategoryName = false;
    for (const blk of rawBlocks) {
      const catText = String(grid[r][blk.categoryCol] ?? '').trim();
      if (catText && !/^date$/i.test(catText) && !/^score$/i.test(catText)) {
        hasCategoryName = true;
        break;
      }
    }

    if (hasCategoryName) {
      firstCategoryRowIdx = r;
      break;
    }
  }

  if (firstCategoryRowIdx === -1) {
    return {
      ok: false,
      error: 'Layout not recognised: no category rows found below the header row.',
      blocks: [],
      needsAttention: [],
      summary: null,
    };
  }

  // 6. Extract raw date strings in rows between headerRowIdx and firstCategoryRowIdx,
  // and filter out placeholder rounds like "Round0" that have no date and no scores.
  const allDateTriples = [];

  for (const blk of rawBlocks) {
    const roundScoreColsInBlock = new Set(blk.candidateRounds.map((cr) => cr.scoreCol));

    for (const cand of blk.candidateRounds) {
      const hasDedicatedTimeCol = !roundScoreColsInBlock.has(cand.timeCol);
      let rawDateCell = '';
      let dateRef = cellRef(headerRowIdx + 1, cand.scoreCol);
      let dateMatch = null;

      for (let r = headerRowIdx + 1; r < firstCategoryRowIdx; r++) {
        const cellVal = String(grid[r][cand.scoreCol] ?? '').trim();
        if (!cellVal || /^score$/i.test(cellVal)) continue;
        const m = cellVal.match(dateRegex);
        if (m) {
          rawDateCell = cellVal;
          dateRef = cellRef(r, cand.scoreCol);
          dateMatch = m;
          break;
        } else if (!rawDateCell && !isEmptyOrPlaceholderCell(cellVal)) {
          rawDateCell = cellVal;
          dateRef = cellRef(r, cand.scoreCol);
        }
      }

      // Check if this candidate round has any non-empty score or time in rows >= firstCategoryRowIdx
      let hasAnyDataBelow = false;
      for (let r = firstCategoryRowIdx; r < grid.length; r++) {
        const sc = String(grid[r][cand.scoreCol] ?? '');
        const tm = hasDedicatedTimeCol ? String(grid[r][cand.timeCol] ?? '') : '';
        if (!isEmptyOrPlaceholderCell(sc) || !isEmptyOrPlaceholderCell(tm)) {
          hasAnyDataBelow = true;
          break;
        }
      }

      // A header like "Round0" with no date and no scores must be ignored and reported as an information line
      if (!rawDateCell && !hasAnyDataBelow) {
        const infoMsg = `Ignored placeholder header "${cand.rawHeader}" at ${cand.headerRef} (no date and no scores).`;
        blk.ignoredRounds.push({
          roundNumber: cand.roundNumber,
          rawHeader: cand.rawHeader,
          ref: cand.headerRef,
          message: infoMsg,
        });
        needsAttention.push({
          severity: 'info',
          type: 'ignored_round',
          blockNumber: blk.blockNumber,
          roundNumber: cand.roundNumber,
          ref: cand.headerRef,
          message: infoMsg,
        });
        continue;
      }

      let dateTriple = null;
      if (dateMatch) {
        const n1 = parseInt(dateMatch[1], 10);
        const n2 = parseInt(dateMatch[2], 10);
        const yRaw = parseInt(dateMatch[3], 10);
        const year = dateMatch[3].length <= 2 || yRaw < 100 ? 2000 + yRaw : yRaw;
        dateTriple = {
          n1,
          n2,
          year,
          raw: rawDateCell,
          ref: dateRef,
          blockNumber: blk.blockNumber,
          roundNumber: cand.roundNumber,
        };
        allDateTriples.push(dateTriple);
      }

      blk.rounds.push({
        blockIndex: blk.blockIndex,
        blockNumber: blk.blockNumber,
        roundNumber: cand.roundNumber,
        rawHeader: cand.rawHeader,
        headerRef: cand.headerRef,
        scoreCol: cand.scoreCol,
        timeCol: cand.timeCol,
        rawDate: rawDateCell,
        dateRef,
        dateTriple,
        dateISO: null,
        dateStatus: 'ok', // 'ok' | 'missing' | 'unreadable'
        dateError: null,
        dateFlags: [],
        cells: [],
        summary: {
          roundType: null,
          roundTypeRef: null,
          timeTakenRaw: null,
          timeTakenSeconds: null,
          timeTakenDisplay: '—',
          withoutTime: false,
          timeTakenUnreadable: false,
          timeTakenRef: null,
          finalScore: null,
          finalScoreRaw: null,
          finalScoreUnreadable: false,
          finalScoreRef: null,
          totalAttempt: null,
          totalAttemptRaw: null,
          totalAttemptUnreadable: false,
          totalAttemptRef: null,
          marksToBeCorrected: null,
          marksToBeCorrectedRaw: null,
          marksToBeCorrectedUnreadable: false,
          marksToBeCorrectedRef: null,
        },
        computed: {
          sumCorrect: 0,
          sumTotal: 0,
          computedMarks: 0,
          okCount: 0,
          emptyCount: 0,
          unreadableCount: 0,
          noteCount: 0,
          hasUnreadableScore: false,
          hasUnreadableCell: false,
        },
        crossChecks: {
          finalScore: null,
          totalAttempt: null,
          marksToBeCorrected: null,
        },
      });
    }
  }

  // 7. Resolve Date Format (Auto vs DD/MM vs MM/DD)
  const firstGt12Triples = allDateTriples.filter((t) => t.n1 > 12);
  const secondGt12Triples = allDateTriples.filter((t) => t.n2 > 12);

  let resolvedDateFormat = 'DD/MM';
  let dateFormatError = null;
  let dateFormatWarning = null;

  const requestedFormat = String(dateFormat || 'auto').trim().toUpperCase();

  if (requestedFormat === 'DD/MM' || requestedFormat === 'MM/DD') {
    resolvedDateFormat = requestedFormat;
  } else {
    // Auto mode
    if (firstGt12Triples.length > 0 && secondGt12Triples.length > 0) {
      dateFormatError = `Dates are mixed: found DD/MM dates (e.g. "${firstGt12Triples[0].raw}" at ${firstGt12Triples[0].ref}) and MM/DD dates (e.g. "${secondGt12Triples[0].raw}" at ${secondGt12Triples[0].ref}). Select DD/MM or MM/DD manually to override.`;
      resolvedDateFormat = 'DD/MM';
      needsAttention.push({
        severity: 'error',
        type: 'mixed_dates',
        blockNumber: null,
        roundNumber: null,
        ref: `${firstGt12Triples[0].ref}, ${secondGt12Triples[0].ref}`,
        message: dateFormatError,
      });
    } else if (firstGt12Triples.length > 0) {
      resolvedDateFormat = 'DD/MM';
    } else if (secondGt12Triples.length > 0) {
      resolvedDateFormat = 'MM/DD';
    } else {
      resolvedDateFormat = 'DD/MM';
      if (allDateTriples.length > 0) {
        dateFormatWarning =
          'All dates have day and month numbers 12 or below; defaulted to DD/MM. Verify the date format selector if dates look swapped.';
        needsAttention.push({
          severity: 'warning',
          type: 'ambiguous_date_format',
          blockNumber: null,
          roundNumber: null,
          ref: null,
          message: dateFormatWarning,
        });
      }
    }
  }

  // 8. Resolve each round's date and run per-block date & round-number checks
  for (const blk of rawBlocks) {
    for (const rnd of blk.rounds) {
      rnd.excluded = false;
      rnd.exclusionReason = null;

      if (
        !Number.isInteger(rnd.roundNumber) ||
        rnd.roundNumber < 1 ||
        rnd.roundNumber > MAX_ROUND_NUMBER
      ) {
        rnd.excluded = true;
        rnd.exclusionReason = `Round number ${rnd.roundNumber} is outside 1..100,000`;
        needsAttention.push({
          severity: 'warning',
          type: 'round_excluded',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.headerRef,
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Round number ${rnd.roundNumber} at ${rnd.headerRef} is outside 1..100,000 (excluded from import).`,
        });
      }

      if (!rnd.rawDate) {
        rnd.dateStatus = 'missing';
        rnd.dateError = 'Missing date';
        rnd.excluded = true;
        rnd.exclusionReason = `Missing round date at ${rnd.dateRef}`;
        const flag = {
          severity: 'error',
          code: 'missing_date',
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Missing date at ${rnd.dateRef} (excluded from import).`,
        };
        rnd.dateFlags.push(flag);
        blk.dateErrors.push(flag);
        needsAttention.push({
          severity: 'error',
          type: 'missing_date',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.dateRef,
          excluded: true,
          message: flag.message,
        });
      } else if (!rnd.dateTriple) {
        rnd.dateStatus = 'unreadable';
        rnd.dateError = `Unreadable date "${rnd.rawDate}"`;
        rnd.excluded = true;
        rnd.exclusionReason = `Unreadable date "${rnd.rawDate}" at ${rnd.dateRef}`;
        const flag = {
          severity: 'error',
          code: 'unreadable_date',
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Unreadable date "${rnd.rawDate}" at ${rnd.dateRef} (excluded from import).`,
        };
        rnd.dateFlags.push(flag);
        blk.dateErrors.push(flag);
        needsAttention.push({
          severity: 'error',
          type: 'unreadable_date',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.dateRef,
          excluded: true,
          message: flag.message,
        });
      } else {
        const { n1, n2, year } = rnd.dateTriple;
        const day = resolvedDateFormat === 'DD/MM' ? n1 : n2;
        const month = resolvedDateFormat === 'DD/MM' ? n2 : n1;
        const iso = buildValidISODate(day, month, year);

        if (!iso) {
          rnd.dateStatus = 'unreadable';
          rnd.dateError = `Impossible calendar date "${rnd.rawDate}" under ${resolvedDateFormat}`;
          rnd.excluded = true;
          rnd.exclusionReason = rnd.dateError;
          const flag = {
            severity: 'error',
            code: 'unreadable_date',
            message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Unreadable/impossible date "${rnd.rawDate}" (${resolvedDateFormat}) at ${rnd.dateRef} (excluded from import).`,
          };
          rnd.dateFlags.push(flag);
          blk.dateErrors.push(flag);
          needsAttention.push({
            severity: 'error',
            type: 'unreadable_date',
            blockNumber: blk.blockNumber,
            roundNumber: rnd.roundNumber,
            ref: rnd.dateRef,
            excluded: true,
            message: flag.message,
          });
        } else {
          rnd.dateISO = iso;
          rnd.dateStatus = 'ok';

          // Check future date against today_ist()
          if (todayIST && iso > todayIST) {
            rnd.excluded = true;
            rnd.exclusionReason = `Future date ${iso} (after today ${todayIST})`;
            const flag = {
              severity: 'error',
              code: 'future_date',
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Future date ${iso} at ${rnd.dateRef} (after today ${todayIST} — excluded from import).`,
            };
            rnd.dateFlags.push(flag);
            blk.dateErrors.push(flag);
            needsAttention.push({
              severity: 'error',
              type: 'future_date',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: rnd.dateRef,
              excluded: true,
              message: flag.message,
            });
          }

          // Check date before 2020-01-01
          if (iso < MIN_ROUND_DATE_ISO) {
            rnd.excluded = true;
            rnd.exclusionReason = `Date ${iso} is before ${MIN_ROUND_DATE_ISO}`;
            const flag = {
              severity: 'warning',
              code: 'before_2020',
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Date ${iso} at ${rnd.dateRef} is before 2020 (excluded from import).`,
            };
            rnd.dateFlags.push(flag);
            blk.dateWarnings.push(flag);
            needsAttention.push({
              severity: 'warning',
              type: 'before_2020',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: rnd.dateRef,
              excluded: true,
              message: flag.message,
            });
          }
        }
      }
    }

    // Per-block chronological order & duplicate date checks (ordered by roundNumber ascending)
    const roundsWithDates = [...blk.rounds]
      .filter((r) => r.dateISO !== null)
      .sort((a, b) => a.roundNumber - b.roundNumber);

    // Out-of-order check: a later round number has an earlier date than a previous round
    for (let i = 1; i < roundsWithDates.length; i++) {
      const prev = roundsWithDates[i - 1];
      const curr = roundsWithDates[i];
      if (curr.dateISO < prev.dateISO) {
        const msg = `Block ${blk.blockNumber}: Out-of-order dates — Round ${curr.roundNumber} (${curr.dateISO} at ${curr.dateRef}) is earlier than Round ${prev.roundNumber} (${prev.dateISO} at ${prev.dateRef}).`;
        const flag = { severity: 'warning', code: 'out_of_order_date', message: msg };
        curr.dateFlags.push(flag);
        blk.dateWarnings.push(flag);
        needsAttention.push({
          severity: 'warning',
          type: 'out_of_order_date',
          blockNumber: blk.blockNumber,
          roundNumber: curr.roundNumber,
          ref: curr.dateRef,
          message: msg,
        });
      }
    }

    // Duplicate date check within the same block (info)
    const byDate = new Map();
    for (const r of roundsWithDates) {
      if (!byDate.has(r.dateISO)) byDate.set(r.dateISO, []);
      byDate.get(r.dateISO).push(r);
    }
    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (const [iso, group] of byDate.entries()) {
      if (group.length > 1) {
        const [yStr, mStr, dStr] = iso.split('-');
        const humanDate = `${parseInt(dStr, 10)} ${shortMonths[parseInt(mStr, 10) - 1]} ${yStr}`;
        const roundLabels = group.map((g) => `Round ${g.roundNumber}`).join(', ');
        const refs = group.map((g) => g.dateRef).filter(Boolean).join(', ');
        const msg = `Block ${blk.blockNumber}: Same date ${humanDate} (${iso}) shared by ${roundLabels}.`;
        const flag = { severity: 'info', code: 'duplicate_date', message: msg, dateISO: iso };
        group.forEach((g) => g.dateFlags.push(flag));
        blk.dateInfos.push(flag);
        needsAttention.push({
          severity: 'info',
          type: 'duplicate_date',
          blockNumber: blk.blockNumber,
          roundNumber: group[0].roundNumber,
          roundNumbers: group.map((g) => g.roundNumber),
          ref: refs || group[0].dateRef,
          dateISO: iso,
          message: msg,
        });
      }
    }
  }

  // 9. Build DB category lookup map (section = 'round' categories)
  const dbCatByNormKey = new Map();
  const normalizedDbCats = roundCategories.map((cat, idx) => {
    const obj = typeof cat === 'string'
      ? { id: `cat-${idx + 1}`, name: cat, section: 'round', active: true, sort_order: idx + 1 }
      : cat;
    const { rawKey } = normalizeCategoryKey(obj.name);
    dbCatByNormKey.set(rawKey, obj);
    return obj;
  });

  // 10. Scan rows from firstCategoryRowIdx downward for each block:
  // classify each row as a Category row, a Summary row, or a non-category row (checking for stray values).
  let totalCategoryRowsFound = 0;

  for (const blk of rawBlocks) {
    const matchedDbCatIds = new Set();

    for (let r = firstCategoryRowIdx; r < grid.length; r++) {
      const catText = String(grid[r][blk.categoryCol] ?? '').trim();
      const idxText = blk.indexCol !== null ? String(grid[r][blk.indexCol] ?? '').trim() : '';

      // A summary label can be in the Category column OR in the INDEX column (just left of it)
      const summaryType = classifySummaryLabel(catText) || classifySummaryLabel(idxText);

      if (summaryType) {
        // Parse summary values for each round in this block
        for (const rnd of blk.rounds) {
          const rawVal = String(grid[r][rnd.scoreCol] ?? '').trim();
          const ref = cellRef(r, rnd.scoreCol);

          if (summaryType === 'roundType') {
            rnd.summary.roundTypeRef = ref;
            if (isEmptyOrPlaceholderCell(rawVal)) {
              rnd.summary.roundType = null;
            } else if (rawVal.length > MAX_ROUND_TYPE_LENGTH) {
              const cutType = rawVal.slice(0, MAX_ROUND_TYPE_LENGTH);
              rnd.summary.roundType = cutType;
              rnd.summary.roundTypeOriginal = rawVal;
              rnd.summary.roundTypeTruncated = true;
              needsAttention.push({
                severity: 'warning',
                type: 'round_type_truncated',
                blockNumber: blk.blockNumber,
                roundNumber: rnd.roundNumber,
                ref,
                rawText: rawVal,
                message: `Round type "${rawVal.slice(0, 24)}…" at ${ref} is ${rawVal.length} characters (max 40): cut to "${cutType}".`,
              });
            } else {
              rnd.summary.roundType = rawVal;
            }
          } else if (summaryType === 'timeTaken') {
            rnd.summary.timeTakenRaw = rawVal;
            rnd.summary.timeTakenRef = ref;
            if (isEmptyOrPlaceholderCell(rawVal)) {
              rnd.summary.timeTakenSeconds = null;
              rnd.summary.timeTakenDisplay = '—';
            } else if (/without\s*time/i.test(rawVal)) {
              rnd.summary.timeTakenSeconds = null;
              rnd.summary.timeTakenDisplay = '— (Without Time)';
              rnd.summary.withoutTime = true;
            } else {
              const parsedT = parseTimeCell(rawVal, { maxSeconds: Infinity });
              if (parsedT.status === 'ok') {
                if (parsedT.seconds > MAX_ROUND_TOTAL_TIME_SECONDS) {
                  rnd.summary.timeTakenRawSeconds = parsedT.seconds;
                  rnd.summary.timeTakenSeconds = null;
                  rnd.summary.timeTakenOverLimit = true;
                  rnd.summary.timeTakenDisplay = `${rawVal} (>8h → omitted)`;
                  needsAttention.push({
                    severity: 'warning',
                    type: 'time_taken_over_limit',
                    blockNumber: blk.blockNumber,
                    roundNumber: rnd.roundNumber,
                    ref,
                    rawText: rawVal,
                    seconds: parsedT.seconds,
                    message: `Total time ${rawVal} at ${ref} is more than 8 hours: the round will be imported WITHOUT a total time`,
                  });
                } else {
                  rnd.summary.timeTakenSeconds = parsedT.seconds;
                  rnd.summary.timeTakenDisplay = formatSecondsDisplay(parsedT.seconds, true);
                }
              } else {
                rnd.summary.timeTakenSeconds = null;
                rnd.summary.timeTakenDisplay = rawVal;
                rnd.summary.timeTakenUnreadable = true;
                needsAttention.push({
                  severity: 'warning',
                  type: 'unreadable_summary_time',
                  blockNumber: blk.blockNumber,
                  roundNumber: rnd.roundNumber,
                  ref,
                  message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Unreadable Time Taken "${rawVal}" at ${ref}.`,
                });
              }
            }
          } else if (
            summaryType === 'finalScore' ||
            summaryType === 'totalAttempt' ||
            summaryType === 'marksToBeCorrected'
          ) {
            rnd.summary[`${summaryType}Raw`] = rawVal;
            rnd.summary[`${summaryType}Ref`] = ref;
            if (isEmptyOrPlaceholderCell(rawVal)) {
              rnd.summary[summaryType] = null;
            } else if (/^-?\d+$/.test(rawVal)) {
              rnd.summary[summaryType] = parseInt(rawVal, 10);
            } else {
              rnd.summary[summaryType] = null;
              rnd.summary[`${summaryType}Unreadable`] = true;
              needsAttention.push({
                severity: 'warning',
                type: 'unreadable_summary_number',
                blockNumber: blk.blockNumber,
                roundNumber: rnd.roundNumber,
                ref,
                message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Unreadable ${summaryType} value "${rawVal}" at ${ref}.`,
              });
            }
          }
        }
        continue;
      }

      if (catText && !isEmptyOrPlaceholderCell(catText)) {
        // Category row for this block
        totalCategoryRowsFound += 1;
        const catRef = cellRef(r, blk.categoryCol);
        const { rawKey, normalizedKey, usedAlias } = normalizeCategoryKey(catText);
        const matchedDbCat = dbCatByNormKey.get(normalizedKey) || null;
        if (matchedDbCat && matchedDbCat.id) {
          matchedDbCatIds.add(matchedDbCat.id);
        }

        const isSurpriseTask = /^surprise\s*task$/i.test(catText);

        const categoryEntry = {
          rowIndex: r,
          indexLabel: idxText,
          sheetName: catText,
          ref: catRef,
          rawKey,
          normalizedKey,
          usedAlias,
          isSurpriseTask,
          matchStatus: matchedDbCat ? (usedAlias ? 'alias' : 'exact') : 'unmatched',
          matchedCategory: matchedDbCat
            ? {
                id: matchedDbCat.id,
                name: matchedDbCat.name,
                active: matchedDbCat.active !== false,
              }
            : null,
          // Default admin mapping action for unmatched categories in preview UI
          mappingAction: matchedDbCat ? 'matched' : 'create_historical',
          mappedCategoryId: matchedDbCat ? matchedDbCat.id : null,
        };
        blk.categories.push(categoryEntry);

        // Parse each round's score & time cells in this category row
        for (const rnd of blk.rounds) {
          const rawScore = String(grid[r][rnd.scoreCol] ?? '');
          const rawTime = String(grid[r][rnd.timeCol] ?? '');
          const scoreRef = cellRef(r, rnd.scoreCol);
          const timeRef = cellRef(r, rnd.timeCol);

          const scoreParsed = parseScoreCell(rawScore, isSurpriseTask);
          const timeParsed = parseTimeCell(rawTime);

          let cellStatus = scoreParsed.status;
          const cellWarnings = [];

          if (scoreParsed.noteTruncated) {
            needsAttention.push({
              severity: 'warning',
              type: 'note_truncated',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: scoreRef,
              rawText: rawScore.trim().slice(0, 40) + '…',
              categoryName: catText,
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber} (${catText}): Note at ${scoreRef} is ${scoreParsed.originalNoteLength} characters (max 500): cut to 500 characters.`,
            });
          }

          if (scoreParsed.status === 'unreadable') {
            rnd.computed.hasUnreadableScore = true;
            rnd.computed.hasUnreadableCell = true;
            cellWarnings.push(`${scoreParsed.reason} at ${scoreRef}`);
            needsAttention.push({
              severity: 'error',
              type: 'unreadable_score',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: scoreRef,
              rawText: rawScore.trim(),
              categoryName: catText,
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber} (${catText}): ${scoreParsed.reason} at ${scoreRef}.`,
            });
          }

          if (timeParsed.status === 'unreadable') {
            rnd.computed.hasUnreadableCell = true;
            cellStatus = 'unreadable';
            cellWarnings.push(`${timeParsed.reason} at ${timeRef}`);
            needsAttention.push({
              severity: 'warning',
              type: 'unreadable_time',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: timeRef,
              rawText: rawTime.trim(),
              categoryName: catText,
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber} (${catText}): ${timeParsed.reason} at ${timeRef}.`,
            });
          } else if (scoreParsed.status === 'empty' && timeParsed.status === 'ok') {
            // Time present without a score
            rnd.computed.hasUnreadableCell = true;
            cellStatus = 'unreadable';
            const msg = `Time "${rawTime.trim()}" at ${timeRef} has no score at ${scoreRef}`;
            cellWarnings.push(msg);
            needsAttention.push({
              severity: 'warning',
              type: 'time_without_score',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref: timeRef,
              rawText: rawTime.trim(),
              categoryName: catText,
              message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber} (${catText}): ${msg}.`,
            });
          }

          // Accumulate round totals for valid numeric scores (including numeric Surprise Task ratios)
          if (scoreParsed.status === 'ok') {
            rnd.computed.sumCorrect += scoreParsed.correct;
            rnd.computed.sumTotal += scoreParsed.total;
          }

          if (cellStatus === 'ok') {
            rnd.computed.okCount += 1;
          } else if (cellStatus === 'empty') {
            rnd.computed.emptyCount += 1;
          } else if (cellStatus === 'note') {
            rnd.computed.noteCount += 1;
          } else if (cellStatus === 'unreadable') {
            rnd.computed.unreadableCount += 1;
          }

          rnd.cells.push({
            rowIndex: r,
            categoryName: catText,
            isSurpriseTask,
            scoreRef,
            timeRef,
            rawScore,
            rawTime,
            status: cellStatus,
            scoreStatus: scoreParsed.status,
            timeStatus: timeParsed.status,
            correct: scoreParsed.status === 'ok' ? scoreParsed.correct : null,
            total: scoreParsed.status === 'ok' ? scoreParsed.total : null,
            timeSeconds: timeParsed.status === 'ok' ? timeParsed.seconds : null,
            timeDisplay: timeParsed.status === 'ok' ? formatSecondsDisplay(timeParsed.seconds, false) : null,
            note: scoreParsed.note,
            reason: cellWarnings.length > 0 ? cellWarnings.join('; ') : null,
          });
        }
      } else {
        // Non-category, non-summary row for this block -> check for stray values in any round's scoreCol or timeCol
        for (const rnd of blk.rounds) {
          const scRaw = String(grid[r][rnd.scoreCol] ?? '');
          const tmRaw = String(grid[r][rnd.timeCol] ?? '');

          if (!isEmptyOrPlaceholderCell(scRaw)) {
            const ref = cellRef(r, rnd.scoreCol);
            const val = scRaw.trim();
            const msg = `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Stray value "${val}" at ${ref} (not in a category or summary row — ignored).`;
            const strayObj = {
              ref,
              rawValue: val,
              roundNumber: rnd.roundNumber,
              row: r,
              col: rnd.scoreCol,
              columnType: 'score',
              message: msg,
            };
            blk.strayValues.push(strayObj);
            needsAttention.push({
              severity: 'warning',
              type: 'stray_value',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref,
              rawText: val,
              message: msg,
            });
          }

          if (!isEmptyOrPlaceholderCell(tmRaw)) {
            const ref = cellRef(r, rnd.timeCol);
            const val = tmRaw.trim();
            const msg = `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Stray value "${val}" at ${ref} (not in a category or summary row — ignored).`;
            const strayObj = {
              ref,
              rawValue: val,
              roundNumber: rnd.roundNumber,
              row: r,
              col: rnd.timeCol,
              columnType: 'time',
              message: msg,
            };
            blk.strayValues.push(strayObj);
            needsAttention.push({
              severity: 'warning',
              type: 'stray_value',
              blockNumber: blk.blockNumber,
              roundNumber: rnd.roundNumber,
              ref,
              rawText: val,
              message: msg,
            });
          }
        }
      }
    }

    // Record unmatched sheet categories in needsAttention
    for (const cat of blk.categories) {
      if (cat.matchStatus === 'unmatched') {
        needsAttention.push({
          severity: 'warning',
          type: 'unmatched_category',
          blockNumber: blk.blockNumber,
          roundNumber: null,
          ref: cat.ref,
          rawText: cat.sheetName,
          message: `Block ${blk.blockNumber}: Category "${cat.sheetName}" at ${cat.ref} does not match any database round category (choose mapping below).`,
        });
      }
    }

    // Compute DB round categories absent from this block (informational)
    blk.absentDbCategories = normalizedDbCats
      .filter((dbCat) => !matchedDbCatIds.has(dbCat.id))
      .map((dbCat) => ({
        id: dbCat.id,
        name: dbCat.name,
        active: dbCat.active !== false,
      }));
  }

  if (totalCategoryRowsFound === 0) {
    return {
      ok: false,
      error: 'Layout not recognised: no category rows found.',
      blocks: [],
      needsAttention: [],
      summary: null,
    };
  }

  // 11. Run the 3 Cross-Checks per Round
  for (const blk of rawBlocks) {
    for (const rnd of blk.rounds) {
      rnd.computed.computedMarks = rnd.computed.sumTotal - rnd.computed.sumCorrect;
      const incomplete = rnd.computed.hasUnreadableScore;

      // Cross-Check 1: sum(correct) vs Final Score
      rnd.crossChecks.finalScore = evaluateCrossCheck({
        label: 'Final Score',
        sheetValue: rnd.summary.finalScore,
        sheetUnreadable: rnd.summary.finalScoreUnreadable,
        computedValue: rnd.computed.sumCorrect,
        incomplete,
        ref: rnd.summary.finalScoreRef,
      });

      if (rnd.crossChecks.finalScore.status === 'MISMATCH') {
        needsAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Final Score',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.finalScoreRef,
          sheetValue: rnd.crossChecks.finalScore.sheetValue,
          computedValue: rnd.crossChecks.finalScore.computedValue,
          diff: rnd.crossChecks.finalScore.diff,
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Final Score MISMATCH at ${rnd.summary.finalScoreRef || 'summary'} (Sheet: ${rnd.crossChecks.finalScore.sheetValue}, Sum of correct: ${rnd.crossChecks.finalScore.computedValue}, Diff: ${formatDiff(rnd.crossChecks.finalScore.diff)}).`,
        });
      }

      // Cross-Check 2: sum(total) vs Total Attempt
      rnd.crossChecks.totalAttempt = evaluateCrossCheck({
        label: 'Total Attempt',
        sheetValue: rnd.summary.totalAttempt,
        sheetUnreadable: rnd.summary.totalAttemptUnreadable,
        computedValue: rnd.computed.sumTotal,
        incomplete,
        ref: rnd.summary.totalAttemptRef,
      });

      if (rnd.crossChecks.totalAttempt.status === 'MISMATCH') {
        needsAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Total Attempt',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.totalAttemptRef,
          sheetValue: rnd.crossChecks.totalAttempt.sheetValue,
          computedValue: rnd.crossChecks.totalAttempt.computedValue,
          diff: rnd.crossChecks.totalAttempt.diff,
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Total Attempt MISMATCH at ${rnd.summary.totalAttemptRef || 'summary'} (Sheet: ${rnd.crossChecks.totalAttempt.sheetValue}, Sum of total: ${rnd.crossChecks.totalAttempt.computedValue}, Diff: ${formatDiff(rnd.crossChecks.totalAttempt.diff)}).`,
        });
      }

      // Cross-Check 3: (Total Attempt - Final Score) vs Marks TO BE CORRECTED
      // Uses computedMarks = sum(total) - sum(correct), and also records sheetDerivedMarks when sheet Final Score & Total Attempt exist
      const sheetDerivedMarks =
        rnd.summary.totalAttempt !== null && rnd.summary.finalScore !== null
          ? rnd.summary.totalAttempt - rnd.summary.finalScore
          : null;

      rnd.crossChecks.marksToBeCorrected = evaluateMarksCrossCheck({
        sheetValue: rnd.summary.marksToBeCorrected,
        sheetUnreadable: rnd.summary.marksToBeCorrectedUnreadable,
        computedMarks: rnd.computed.computedMarks,
        sheetDerivedMarks,
        incomplete,
        ref: rnd.summary.marksToBeCorrectedRef,
      });

      if (rnd.crossChecks.marksToBeCorrected.status === 'MISMATCH') {
        needsAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Marks TO BE CORRECTED',
          blockNumber: blk.blockNumber,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.marksToBeCorrectedRef,
          sheetValue: rnd.crossChecks.marksToBeCorrected.sheetValue,
          computedValue: rnd.crossChecks.marksToBeCorrected.computedValue,
          diff: rnd.crossChecks.marksToBeCorrected.diff,
          message: `Block ${blk.blockNumber} · Round ${rnd.roundNumber}: Marks TO BE CORRECTED MISMATCH at ${rnd.summary.marksToBeCorrectedRef || 'summary'} (Sheet: ${rnd.crossChecks.marksToBeCorrected.sheetValue}, Expected: ${rnd.crossChecks.marksToBeCorrected.computedValue}, Diff: ${formatDiff(rnd.crossChecks.marksToBeCorrected.diff)}).`,
        });
      }
    }
  }

  // 12. Build overall summary object
  let totalRounds = 0;
  let totalCellsOk = 0;
  let totalCellsEmpty = 0;
  let totalCellsUnreadable = 0;
  let totalCellsNote = 0;
  let totalStray = 0;

  const blockSummaries = rawBlocks.map((blk) => {
    totalRounds += blk.rounds.length;
    totalStray += blk.strayValues.length;

    let blkOk = 0;
    let blkEmpty = 0;
    let blkUnreadable = 0;
    let blkNote = 0;
    const validDates = [];

    for (const rnd of blk.rounds) {
      blkOk += rnd.computed.okCount;
      blkEmpty += rnd.computed.emptyCount;
      blkUnreadable += rnd.computed.unreadableCount;
      blkNote += rnd.computed.noteCount;
      if (rnd.dateISO) validDates.push(rnd.dateISO);
    }

    totalCellsOk += blkOk;
    totalCellsEmpty += blkEmpty;
    totalCellsUnreadable += blkUnreadable;
    totalCellsNote += blkNote;

    validDates.sort();
    const minDate = validDates.length > 0 ? validDates[0] : null;
    const maxDate = validDates.length > 0 ? validDates[validDates.length - 1] : null;

    blk.dateRange = { minDate, maxDate };
    blk.cellCounts = {
      ok: blkOk,
      empty: blkEmpty,
      unreadable: blkUnreadable,
      note: blkNote,
      stray: blk.strayValues.length,
    };

    return {
      blockNumber: blk.blockNumber,
      seriesName: blk.seriesName,
      roundCount: blk.rounds.length,
      minDate,
      maxDate,
      cellCounts: blk.cellCounts,
    };
  });

  return {
    ok: true,
    error: null,
    dateFormatRequested: dateFormat,
    resolvedDateFormat,
    dateFormatError,
    dateFormatWarning,
    todayIST,
    studentNames,
    primaryStudentName: studentNames.length > 0 ? studentNames[0].name : null,
    studentNameMismatchWarning,
    levelLabels: levelLabelsList,
    labelHints,
    blocks: rawBlocks,
    needsAttention,
    summary: {
      blockCount: rawBlocks.length,
      totalRounds,
      blockSummaries,
      totalCells: {
        ok: totalCellsOk,
        empty: totalCellsEmpty,
        unreadable: totalCellsUnreadable,
        note: totalCellsNote,
        stray: totalStray,
      },
    },
  };
}

/**
 * Evaluates a single round cross-check (Final Score or Total Attempt).
 */
function evaluateCrossCheck({ label, sheetValue, sheetUnreadable, computedValue, incomplete, ref }) {
  if (incomplete || sheetUnreadable) {
    return {
      label,
      status: 'INCOMPLETE',
      sheetValue,
      computedValue,
      diff: null,
      ref,
    };
  }
  if (sheetValue === null || sheetValue === undefined) {
    return {
      label,
      status: 'NOT PRESENT',
      sheetValue: null,
      computedValue,
      diff: null,
      ref,
    };
  }
  const diff = computedValue - sheetValue;
  return {
    label,
    status: diff === 0 ? 'OK' : 'MISMATCH',
    sheetValue,
    computedValue,
    diff,
    ref,
  };
}

/**
 * Evaluates the Marks TO BE CORRECTED cross-check.
 * Compares Marks TO BE CORRECTED against (Total Attempt - Final Score).
 */
function evaluateMarksCrossCheck({
  sheetValue,
  sheetUnreadable,
  computedMarks,
  sheetDerivedMarks,
  incomplete,
  ref,
}) {
  const label = 'Marks TO BE CORRECTED';
  // Expected marks from (Total Attempt - Final Score) on sheet if present, or computed (sumTotal - sumCorrect)
  const expected = sheetDerivedMarks !== null ? sheetDerivedMarks : computedMarks;

  if (incomplete || sheetUnreadable) {
    return {
      label,
      status: 'INCOMPLETE',
      sheetValue,
      computedValue: expected,
      computedFromCells: computedMarks,
      sheetDerivedMarks,
      diff: null,
      ref,
    };
  }
  if (sheetValue === null || sheetValue === undefined) {
    return {
      label,
      status: 'NOT PRESENT',
      sheetValue: null,
      computedValue: expected,
      computedFromCells: computedMarks,
      sheetDerivedMarks,
      diff: null,
      ref,
    };
  }

  // Strict Marks TO BE CORRECTED check: compare sheet value against calculated marks
  // from the category cells: sum(total) - sum(correct) (`computedMarks`).
  const diff = computedMarks - sheetValue;
  const isOk = diff === 0;

  return {
    label,
    status: isOk ? 'OK' : 'MISMATCH',
    sheetValue,
    computedValue: computedMarks,
    computedFromCells: computedMarks,
    sheetDerivedMarks,
    diff: isOk ? 0 : diff,
    ref,
  };
}

/**
 * Formats an integer difference with an explicit + or - sign.
 */
function formatDiff(diff) {
  if (diff === null || diff === undefined) return '0';
  return diff > 0 ? `+${diff}` : String(diff);
}

/**
 * Synthetic 2-block score sheet CSV fixture covering all real-world layout cases:
 * - Two side-by-side blocks with a gap column and "NEW SIMULATOR" hint
 * - "Name -- TEST STUDENT" and "JUNIOR -1" level headers
 * - "Round0" placeholder column with no date and no scores (ignored + info)
 * - Mixed date separators ("Date- 17/08/26", "21.08.2026", "Date - 18-08-26")
 * - Built-in category aliases ("Calender" -> "Calendar", "Time Elapse" -> "Time Elapsed")
 * - Unmatched historical category ("Currency")
 * - Dots-only cell ("......" at D9 -> empty, skipped silently)
 * - Unreadable plain-number time ("75" at E5)
 * - Surprise Task with ratio ("379/384") and with text note ("Mental relay bonus")
 * - Stray value ("94/231" at O10 in a row with no category)
 * - Summary labels in Category column (Block 1) and INDEX column (Block 2)
 * - Time Taken "1:08:37" (4117s) and "Without Time"
 * - Deliberate Final Score mismatch in Block 2 Round 1 (Sheet: 250, Sum: 255, Diff: +5)
 */
export const SAMPLE_TWO_BLOCK_CSV = [
  // Row 1 (index 0): Name, Level labels, and "NEW SIMULATOR" block hint
  ',Name -- TEST STUDENT,,JUNIOR -1,,JUNIOR -1,,NEW SIMULATOR,,Name -- TEST STUDENT,JUNIOR -1,,JUNIOR -1,,JUNIOR -1,',
  // Row 2 (index 1): Header row (Block 1: A=INDEX, B=Category, C=Round0, D=Round 1, F=Round 2; Block 2: I=INDEX, J=Category, K=Round 1, M=Round 2, O=Round 3)
  'INDEX,Category,Round0,Round 1,,Round 2,,,INDEX,Category,Round 1,,Round 2,,ROUND 3,',
  // Row 3 (index 2): Date row
  ',,,Date- 17/08/26,,21.08.2026,,,,,Date - 18-08-26,,19/8/26,,20/08/2026,',
  // Row 4 (index 3): Score / Time label row (some Time labels omitted, trailing space on Score)
  ',,,Score ,Time,Score ,,,,,Score,Time,Score ,,Score,Time',
  // Row 5 (index 4): Category 1 (D5=75/75, E5=75 unreadable plain number time)
  '1,ADD,,75/75,75,75/75,1:15,,1,ADD,85/85,1:20,90/90,1:10,95/95,1:05',
  // Row 6 (index 5): Category 2 (D6=89/89)
  '2,SUB,,89/89,1:42,90/90,1:30,,2,HCF and LCM,80/85,2:05,84/85,1:55,85/85,1:45',
  // Row 7 (index 6): Category 3 (Block 1 has "Currency" unmatched; Block 2 has "Approximation")
  '3,Currency,,40/45,2:10,44/45,2:00,,3,Approximation,40/45,2:15,42/45,2:00,45/45,1:50',
  // Row 8 (index 7): Category 4 (Built-in aliases: "Calender" and "Time Elapse")
  '4,Calender,,30/30,1:50,29/30,1:45,,4,Time Elapse,50/50,1:40,48/50,1:35,50/50,1:30',
  // Row 9 (index 8): Category 5 (Surprise Task: D9="......", F9="379/384", M9="Mental relay bonus")
  '5,Surprise Task,,......,,379/384,3:12,,5,Surprise Task,,,Mental relay bonus,,100/100,2:00',
  // Row 10 (index 9): Stray row without a category — O10 has stray value "94/231"
  ',,,,,,,,,,,,,,94/231,',
  // Row 11 (index 10): Summary row — Round Type (in Category col B for Block 1, INDEX col I for Block 2)
  ',Round Type,,Category wise,,Flat Round,,,Round Type,,Flat Round,,Without Time,,Flat Round,',
  // Row 12 (index 11): Summary row — Time Taken
  ',Time Taken,,1:12:00,,1:08:37,,,Time Taken,,1:05:20,,Without Time,,0:58:10,',
  // Row 13 (index 12): Summary row — Final Score (Block 2 Round 1 has 250 instead of 255)
  ',Final Score,,234,,617,,,Final Score,,250,,264,,375,',
  // Row 14 (index 13): Summary row — Total Attempt
  ',Total Attempt,,239,,624,,,Total Attempt,,265,,270,,375,',
  // Row 15 (index 14): Summary row — Marks TO BE CORRECTED
  ',Marks TO BE CORRECTED,,5,,7,,,Marks TO BE CORRECTED,,10,,6,,0,',
].join('\r\n');

