/**
 * Trendz Tracker — Pure CSV Import Planning, Comparison & Execution Logic (js/importPlan.js)
 *
 * STRICT PHASE 4c-2a, 4c-2b, 4c-2c & 4c-2d RULES:
 * - 100% pure JavaScript functions.
 * - Zero DOM calls, zero network calls, zero side effects.
 * - Must run directly in Node.js with `node --test`.
 * - Mirrors all database limits from `admin_import_rounds` in the preview and plan.
 * - Supports Phase 4c-2d live preview editing (`createEmptyEditState`, `validateRoundEdit`,
 *   `validateCellEdit`, `applyPreviewEdits`, `buildPreviewEditsList`, `buildImportPayload`),
 *   keeping original parsed values intact so any round or cell can be reset to its sheet value.
 */

import {
  normalizeCategoryKey,
  parseTimeCell,
  parseScoreCell,
  formatSecondsDisplay,
  MAX_ROUND_NUMBER,
  MIN_ROUND_DATE_ISO,
  MAX_ROUND_TYPE_LENGTH,
  MAX_ROUND_TOTAL_TIME_SECONDS,
  MAX_CELL_TIME_SECONDS,
  MAX_NOTE_LENGTH,
  getDefaultTodayIST,
} from './importParser.js';

export const MAX_ROUNDS_PER_RPC_CALL = 100;
export const MAX_CELLS_PER_RPC_CALL = 3000;
export const DB_MIN_ROUND_NUMBER = 1;
export const DB_MAX_ROUND_NUMBER = MAX_ROUND_NUMBER; // 100000
export const DB_MIN_ROUND_DATE_ISO = MIN_ROUND_DATE_ISO; // '2020-01-01'
export const DB_MAX_ROUND_TYPE_LEN = MAX_ROUND_TYPE_LENGTH; // 40
export const DB_MAX_ROUND_TYPE_LENGTH = MAX_ROUND_TYPE_LENGTH; // 40
export const DB_MAX_ROUND_TIME_TAKEN_SECONDS = MAX_ROUND_TOTAL_TIME_SECONDS; // 28800 (8 hours)
export const DB_MAX_ROUND_TIME_SECONDS = MAX_ROUND_TOTAL_TIME_SECONDS; // 28800
export const DB_MAX_CELL_TIME_SECONDS = MAX_CELL_TIME_SECONDS; // 14400 (4 hours)
export const DB_MAX_NOTE_LEN = MAX_NOTE_LENGTH; // 500
export const DB_MAX_NOTE_LENGTH = MAX_NOTE_LENGTH; // 500
export const DB_MAX_ROUNDS_PER_CALL = MAX_ROUNDS_PER_RPC_CALL; // 100
export const DB_MAX_CELLS_PER_CALL = MAX_CELLS_PER_RPC_CALL; // 3000
export const MAX_RECORDED_EDITS = 500;

/**
 * Normalises a string into a compact lowercase alphanumeric key
 * matching `normalizeCategoryKey(str).rawKey`.
 *
 * @param {string} name
 * @returns {string}
 */
export function toMatchingKey(name) {
  return normalizeCategoryKey(name).rawKey;
}

/**
 * Distinctive category keys that identify "Old Simulator" vs "New Simulator"
 * when no explicit top-row simulator banner hint is present.
 */
export const OLD_SIMULATOR_MARKER_KEYS = Object.freeze([
  'calendar',
  'calender',
  'timeelapsed',
  'timeelapse',
  'currency',
  'missingfigures',
  'roman',
  'romannumerals',
]);

export const NEW_SIMULATOR_MARKER_KEYS = Object.freeze([
  'hcfandlcm',
  'hcflcm',
  'approximation',
  'mensuration',
  'averages',
  'percentage',
  'ratioandproportion',
]);

/**
 * Validates whether a string is a valid calendar date in YYYY-MM-DD format.
 *
 * @param {string} iso
 * @returns {boolean}
 */
export function isValidISODate(iso) {
  if (typeof iso !== 'string') return false;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Formats an integer difference with an explicit + or - sign.
 *
 * @param {number|null|undefined} diff
 * @returns {string}
 */
function formatSignedDiff(diff) {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return '0';
  return diff > 0 ? `+${diff}` : String(diff);
}

/* ==========================================================================
   PHASE 4c-2d: PURE PREVIEW EDIT STATE, VALIDATION & LIVE RECALCULATION
   ========================================================================== */

/**
 * Creates a clean, empty preview edit state container.
 * Supports both `{ rounds, cells }` (keyed by `${b}-${r}` and `${b}-${r}-${rowIndex}`)
 * and `{ roundEdits, cellEdits }` (keyed by `b${b}_r${r}` and `b${b}_r${r}_c${rowIndex}`).
 *
 * @returns {{ rounds: Object, cells: Object, roundEdits: Object, cellEdits: Object }}
 */
export function createEmptyEditState() {
  const rounds = {};
  const cells = {};
  return {
    rounds,
    cells,
    roundEdits: rounds,
    cellEdits: cells,
  };
}

/**
 * Canonical round edit lookup key.
 */
export function getRoundEditKey(blockNumber, roundNumber) {
  return `${Number(blockNumber)}-${Number(roundNumber)}`;
}

/**
 * Canonical cell edit lookup key.
 */
export function getCellEditKey(blockNumber, roundNumber, rowIndex) {
  return `${Number(blockNumber)}-${Number(roundNumber)}-${Number(rowIndex)}`;
}

/**
 * Looks up a round edit from `editState` supporting both key conventions:
 * `${blockNumber}-${roundNumber}` and `b${blockNumber}_r${roundNumber}`.
 */
function findRoundEditEntry(editState, blockNumber, roundNumber) {
  if (!editState || typeof editState !== 'object') return null;
  const b = Number(blockNumber);
  const r = Number(roundNumber);
  const map1 = editState.rounds || {};
  const map2 = editState.roundEdits || {};
  return (
    map1[`${b}-${r}`] ||
    map1[`b${b}_r${r}`] ||
    map2[`b${b}_r${r}`] ||
    map2[`${b}-${r}`] ||
    null
  );
}

/**
 * Looks up a cell edit from `editState` supporting both key conventions:
 * `${blockNumber}-${roundNumber}-${rowIndex}` and `b${blockNumber}_r${roundNumber}_c${rowIndex}`.
 */
function findCellEditEntry(editState, blockNumber, roundNumber, rowIndex) {
  if (!editState || typeof editState !== 'object') return null;
  const b = Number(blockNumber);
  const r = Number(roundNumber);
  const c = Number(rowIndex);
  const map1 = editState.cells || {};
  const map2 = editState.cellEdits || {};
  return (
    map1[`${b}-${r}-${c}`] ||
    map1[`b${b}_r${r}_c${c}`] ||
    map2[`b${b}_r${r}_c${c}`] ||
    map2[`${b}-${r}-${c}`] ||
    null
  );
}

/**
 * Validates an admin's round edit form input before applying it to preview state.
 * Mirrors the exact PostgreSQL `admin_import_rounds` round constraints:
 * - If `skip` / `skipped` is true, the round is marked skipped by admin.
 * - `roundDate` (`dateISO`): required YYYY-MM-DD calendar date between `2020-01-01` and `todayIST`.
 * - `roundType`: optional string, max 40 characters (`Flat Round`, `Category wise`, or custom <= 40 chars).
 * - `timeTakenRaw` / `timeTaken`: optional `h:mm:ss` or `m:ss` string; empty means null;
 *   if provided, must parse to 0..28,800 seconds (8 hours).
 *
 * Returns `{ ok, valid, error, errors, value, normalized }`.
 *
 * @param {Object} input
 * @param {Object} [options]
 * @param {string} [options.todayIST]
 * @returns {Object}
 */
export function validateRoundEdit(input = {}, options = {}) {
  const todayIST = options.todayIST || getDefaultTodayIST();
  const errors = [];
  const skip = Boolean(input.skip || input.skipped);

  const rawDate = String(
    input.roundDate !== undefined ? input.roundDate : input.dateISO || ''
  ).trim();
  const rawType =
    input.roundType === null || input.roundType === undefined
      ? ''
      : String(input.roundType).trim();
  const rawTime = String(
    input.timeTakenRaw !== undefined
      ? input.timeTakenRaw
      : input.timeTaken !== undefined
        ? input.timeTaken
        : input.timeTakenInput !== undefined
          ? input.timeTakenInput
          : ''
  ).trim();

  if (skip) {
    let timeSeconds = null;
    if (rawTime !== '') {
      const parsedT = parseTimeCell(rawTime, {
        maxSeconds: DB_MAX_ROUND_TIME_TAKEN_SECONDS,
      });
      if (parsedT.status === 'ok') timeSeconds = parsedT.seconds;
    }
    const validIso = isValidISODate(rawDate) ? rawDate : null;
    const val = {
      skip: true,
      skipped: true,
      roundDate: validIso,
      dateISO: validIso,
      roundType: rawType ? rawType.slice(0, DB_MAX_ROUND_TYPE_LEN) : null,
      timeTakenSeconds: timeSeconds,
      timeTakenFormatted:
        timeSeconds !== null ? formatSecondsDisplay(timeSeconds, true) : '',
    };
    return {
      ok: true,
      valid: true,
      error: null,
      errors: [],
      value: val,
      normalized: val,
    };
  }

  // 1. Validate roundDate
  if (!rawDate) {
    errors.push('Round date is required (YYYY-MM-DD).');
  } else if (!isValidISODate(rawDate)) {
    errors.push(
      `Round date "${rawDate}" is not a valid YYYY-MM-DD calendar date.`
    );
  } else if (rawDate < DB_MIN_ROUND_DATE_ISO) {
    errors.push(
      `Round date ${rawDate} cannot be earlier than ${DB_MIN_ROUND_DATE_ISO}.`
    );
  } else if (rawDate > todayIST) {
    errors.push(
      `Round date ${rawDate} cannot be in the future (after today ${todayIST} IST).`
    );
  }

  // 2. Validate roundType (max 40 characters)
  let normalizedType = null;
  if (rawType.length > DB_MAX_ROUND_TYPE_LEN) {
    errors.push(
      `Round type is ${rawType.length} characters (maximum ${DB_MAX_ROUND_TYPE_LEN} characters).`
    );
  } else if (rawType.length > 0) {
    normalizedType = rawType;
  }

  // 3. Validate total time (empty means no total time; max 28800s / 8 hours)
  let timeTakenSeconds = null;
  let timeTakenFormatted = '';
  if (rawTime !== '') {
    const parsedTime = parseTimeCell(rawTime, { maxSeconds: Infinity });
    if (parsedTime.status !== 'ok') {
      errors.push(
        `Total time "${rawTime}" is invalid. Use h:mm:ss or m:ss (between 0:00:00 and 8:00:00), or leave empty for no total time.`
      );
    } else if (parsedTime.seconds > DB_MAX_ROUND_TIME_TAKEN_SECONDS) {
      errors.push(
        `Total time "${rawTime}" exceeds the 8-hour database limit (max 8:00:00 / 28,800 seconds). Clear the field to import without a total time, or enter a value up to 8:00:00.`
      );
    } else {
      timeTakenSeconds = parsedTime.seconds;
      timeTakenFormatted = formatSecondsDisplay(parsedTime.seconds, true);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      valid: false,
      error: errors[0],
      errors,
      value: null,
      normalized: null,
    };
  }

  const val = {
    skip: false,
    skipped: false,
    roundDate: rawDate,
    dateISO: rawDate,
    roundType: normalizedType,
    timeTakenSeconds,
    timeTakenFormatted,
  };
  return {
    ok: true,
    valid: true,
    error: null,
    errors: [],
    value: val,
    normalized: val,
  };
}

/**
 * Validates an admin's cell edit form input before applying it to preview state.
 * Mirrors the exact PostgreSQL `admin_import_rounds` cell constraints:
 * - If `skip` / `skipped` is true, the cell is skipped and not imported.
 * - Either `correct` and `total` are BOTH present integers with `0 <= correct <= total` and `total >= 1`,
 *   OR both are empty/absent with a non-empty `note` (max 500 characters).
 * - `timeRaw` / `time` (`m:ss` or `h:mm:ss` or empty): optional, must be `0..14400` seconds (0 to 4 hours).
 * - `note`: optional text up to 500 characters (required if `correct` and `total` are both empty).
 *
 * Returns `{ ok, valid, error, errors, value, normalized }`.
 *
 * @param {Object} input
 * @returns {Object}
 */
export function validateCellEdit(input = {}) {
  const errors = [];
  const skip = Boolean(input.skip || input.skipped);

  if (skip) {
    const val = {
      skip: true,
      skipped: true,
      status: 'skipped',
      correct: null,
      total: null,
      timeSeconds: null,
      timeFormatted: '',
      note: null,
    };
    return {
      ok: true,
      valid: true,
      error: null,
      errors: [],
      value: val,
      normalized: val,
    };
  }

  const rawCorrect =
    input.correct === null || input.correct === undefined
      ? ''
      : String(input.correct).trim();
  const rawTotal =
    input.total === null || input.total === undefined
      ? ''
      : String(input.total).trim();
  const rawTime = String(
    input.timeRaw !== undefined
      ? input.timeRaw
      : input.time !== undefined
        ? input.time
        : input.timeInput !== undefined
          ? input.timeInput
          : ''
  ).trim();
  const rawNote =
    input.note === null || input.note === undefined
      ? ''
      : String(input.note).trim();

  const hasCorrect = rawCorrect !== '';
  const hasTotal = rawTotal !== '';

  let correct = null;
  let total = null;

  if (hasCorrect || hasTotal) {
    if (!hasCorrect || !hasTotal) {
      errors.push(
        'Both Correct and Total must be provided together (or leave both empty for a note-only cell).'
      );
    } else if (!/^-?\d+$/.test(rawCorrect) || !/^-?\d+$/.test(rawTotal)) {
      errors.push('Correct and Total must be whole numbers.');
    } else {
      correct = parseInt(rawCorrect, 10);
      total = parseInt(rawTotal, 10);
      if (total < 1) {
        errors.push(`Total questions (${total}) must be at least 1.`);
      } else if (correct < 0) {
        errors.push(`Correct (${correct}) cannot be negative.`);
      } else if (correct > total) {
        errors.push(
          `Correct (${correct}) cannot be greater than Total (${total}).`
        );
      }
    }
  } else {
    if (!rawNote) {
      errors.push(
        'Enter Correct and Total scores, or enter a Note (or toggle "Skip this cell").'
      );
    }
  }

  // Validate note length (max 500 characters)
  let note = null;
  if (rawNote.length > DB_MAX_NOTE_LEN) {
    errors.push(
      `Note is ${rawNote.length} characters (maximum ${DB_MAX_NOTE_LEN} characters).`
    );
  } else if (rawNote.length > 0) {
    note = rawNote;
  }

  // Validate cell time (0 to 14,400 seconds = 4 hours)
  let timeSeconds = null;
  let timeFormatted = '';
  if (rawTime !== '') {
    if (!hasCorrect && !hasTotal) {
      errors.push('A cell with a time must also have Correct and Total scores.');
    } else {
      const parsedTime = parseTimeCell(rawTime, {
        maxSeconds: DB_MAX_CELL_TIME_SECONDS,
      });
      if (parsedTime.status !== 'ok') {
        if (
          parsedTime.reason &&
          parsedTime.reason.includes('more than 4 hours')
        ) {
          errors.push(
            `Cell time "${rawTime}" must be between 0 and 4 hours (max 4:00:00 / 14,400 seconds).`
          );
        } else {
          errors.push(
            parsedTime.reason ||
              `Cell time "${rawTime}" must be between 0 and 4 hours (m:ss or h:mm:ss).`
          );
        }
      } else {
        timeSeconds = parsedTime.seconds;
        timeFormatted = formatSecondsDisplay(parsedTime.seconds, false);
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      valid: false,
      error: errors[0],
      errors,
      value: null,
      normalized: null,
    };
  }

  const isScoreCell = correct !== null && total !== null;
  const val = {
    skip: false,
    skipped: false,
    status: isScoreCell ? 'ok' : 'note',
    correct,
    total,
    timeSeconds,
    timeFormatted,
    note,
  };
  return {
    ok: true,
    valid: true,
    error: null,
    errors: [],
    value: val,
    normalized: val,
  };
}

/**
 * Formats a cell snapshot for human-readable display in the edits record list.
 */
function formatCellAuditSnapshot(snap) {
  if (!snap) return 'empty';
  if (snap.cellSkippedByAdmin || snap.adminSkipped || snap.status === 'skipped') {
    return 'skipped';
  }
  if (snap.status === 'empty') return 'empty';
  if (snap.status === 'unreadable') {
    const rawS = String(snap.rawScore || '').trim();
    const rawT = String(snap.rawTime || '').trim();
    return `unreadable (${[rawS, rawT].filter(Boolean).join(' / ') || 'invalid'})`;
  }
  const parts = [];
  if (
    snap.correct !== null &&
    snap.correct !== undefined &&
    snap.total !== null &&
    snap.total !== undefined
  ) {
    parts.push(`${snap.correct}/${snap.total}`);
  }
  if (snap.timeSeconds !== null && snap.timeSeconds !== undefined) {
    parts.push(formatSecondsDisplay(snap.timeSeconds, false));
  }
  if (snap.note) {
    parts.push(`note: "${snap.note}"`);
  }
  return parts.join(', ') || 'empty';
}

/**
 * Evaluates a single round cross-check (Final Score or Total Attempt).
 */
function evaluateCrossCheck({
  label,
  sheetValue,
  sheetUnreadable,
  computedValue,
  incomplete,
  ref,
}) {
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
 * Evaluates the Marks TO BE CORRECTED cross-check against `sum(total) - sum(correct)`.
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
  const expected =
    sheetDerivedMarks !== null ? sheetDerivedMarks : computedMarks;

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
 * Applies `editState` on top of the original parsed sheet (`parsed`), returning a new
 * parsed-sheet object with:
 * - `originalValues` / `original` snapshot attached to every round and cell so reset is always possible.
 * - Re-evaluated cell statuses (`ok`, `note`, `unreadable`, `empty`, `skipped`).
 * - Re-run per-round cross-checks (`finalScore`, `totalAttempt`, `marksToBeCorrected`).
 * - Re-run per-block date checks (`missing_date`, `unreadable_date`, `future_date`, `before_2020`,
 *   `out_of_order_date`, `duplicate_date`).
 * - Re-computed `needsAttention` items and `summary` counts (with admin-skipped rounds excluded from counts).
 * - Built `editsList` / `edits` audit array.
 *
 * Accepts either:
 *   `applyPreviewEdits(parsed, editState, options)`
 * or:
 *   `applyPreviewEdits(parsed, { editState, todayIST, blockSeriesMap })`
 *
 * @param {Object} parsed - Output of `parseScoreSheetCsv`
 * @param {Object} [editStateOrOptions]
 * @param {Object} [options]
 * @returns {Object} New parsed sheet object reflecting all active edits
 */
export function applyPreviewEdits(
  parsed,
  editStateOrOptions = {},
  options = {}
) {
  if (!parsed || !parsed.ok || !Array.isArray(parsed.blocks)) {
    return parsed;
  }

  let editState = editStateOrOptions;
  let opts = options || {};
  if (
    editStateOrOptions &&
    typeof editStateOrOptions === 'object' &&
    !editStateOrOptions.rounds &&
    !editStateOrOptions.cells &&
    !editStateOrOptions.roundEdits &&
    !editStateOrOptions.cellEdits &&
    (editStateOrOptions.editState !== undefined ||
      editStateOrOptions.todayIST !== undefined ||
      editStateOrOptions.blockSeriesMap !== undefined)
  ) {
    editState = editStateOrOptions.editState || createEmptyEditState();
    opts = editStateOrOptions;
  }

  const todayIST = opts.todayIST || parsed.todayIST || getDefaultTodayIST();
  const blockSeriesMap = opts.blockSeriesMap || {};
  const shortMonths = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  const recalculatedAttention = [];
  if (parsed.dateFormatError) {
    recalculatedAttention.push({
      severity: 'error',
      type: 'mixed_date_format',
      blockNumber: null,
      roundNumber: null,
      ref: null,
      message: parsed.dateFormatError,
    });
  } else if (parsed.dateFormatWarning) {
    recalculatedAttention.push({
      severity: 'warning',
      type: 'ambiguous_date_format',
      blockNumber: null,
      roundNumber: null,
      ref: null,
      message: parsed.dateFormatWarning,
    });
  }
  if (parsed.studentNameMismatchWarning) {
    recalculatedAttention.push({
      severity: 'warning',
      type: 'multiple_student_names',
      blockNumber: null,
      roundNumber: null,
      ref: null,
      message: parsed.studentNameMismatchWarning,
    });
  }

  // Preserve info lines for ignored empty Round0 columns from original parse
  for (const item of parsed.needsAttention || []) {
    if (item.type === 'ignored_empty_round') {
      recalculatedAttention.push({ ...item });
    }
  }

  const clonedBlocks = parsed.blocks.map((blk) => {
    const bNum = Number(blk.blockNumber);

    const nextRounds = (blk.rounds || []).map((rnd) => {
      const rNum = Number(rnd.roundNumber);
      const rEdit = findRoundEditEntry(editState, bNum, rNum);

      // Capture immutable original snapshot from sheet
      const origValues = rnd.originalValues || {
        rawDate: rnd.rawDate,
        dateISO: rnd.dateISO,
        dateStatus: rnd.dateStatus,
        dateError: rnd.dateError || null,
        excluded: Boolean(rnd.excluded),
        exclusionReason: rnd.exclusionReason || null,
        roundType: rnd.summary?.roundType ?? null,
        roundTypeOriginal:
          rnd.summary?.roundTypeOriginal ?? rnd.summary?.roundType ?? null,
        roundTypeTruncated: Boolean(rnd.summary?.roundTypeTruncated),
        timeTakenRaw: rnd.summary?.timeTakenRaw ?? '',
        timeTakenSeconds: rnd.summary?.timeTakenSeconds ?? null,
        timeTakenRawSeconds: rnd.summary?.timeTakenRawSeconds ?? null,
        timeTakenDisplay: rnd.summary?.timeTakenDisplay ?? '—',
        timeTakenOverLimit: Boolean(rnd.summary?.timeTakenOverLimit),
        timeTakenUnreadable: Boolean(rnd.summary?.timeTakenUnreadable),
        withoutTime: Boolean(rnd.summary?.withoutTime),
        summary: { ...(rnd.summary || {}) },
      };

      const nextSummary = { ...origValues.summary };
      let nextRawDate = origValues.rawDate;
      let nextDateISO = origValues.dateISO;
      let nextDateStatus = origValues.dateStatus;
      let nextDateError = origValues.dateError;
      let roundSkippedByAdmin = false;
      let isRoundEdited = false;
      const editedFields = [];

      if (rEdit) {
        if (rEdit.skip || rEdit.skipped) {
          roundSkippedByAdmin = true;
          isRoundEdited = true;
          editedFields.push('skip');
        } else {
          // 1. Round Date edit
          const editedDate =
            rEdit.roundDate !== undefined ? rEdit.roundDate : rEdit.dateISO;
          if (editedDate !== undefined && editedDate !== origValues.dateISO) {
            nextDateISO = editedDate;
            nextRawDate = editedDate;
            nextDateStatus = editedDate ? 'ok' : 'missing';
            nextDateError = null;
            isRoundEdited = true;
            editedFields.push('roundDate');
          }

          // 2. Round Type edit
          if (rEdit.roundType !== undefined) {
            const newType = rEdit.roundType ? String(rEdit.roundType).trim() : null;
            if (
              newType !== origValues.roundType ||
              origValues.roundTypeTruncated
            ) {
              nextSummary.roundType = newType
                ? newType.slice(0, DB_MAX_ROUND_TYPE_LEN)
                : null;
              nextSummary.roundTypeOriginal = nextSummary.roundType;
              nextSummary.roundTypeTruncated = false;
              isRoundEdited = true;
              editedFields.push('roundType');
            }
          }

          // 3. Total Time edit
          const hasSecField = rEdit.timeTakenSeconds !== undefined;
          const hasStrField =
            rEdit.timeTakenRaw !== undefined ||
            rEdit.timeTaken !== undefined ||
            rEdit.timeTakenInput !== undefined;

          if (hasSecField || hasStrField) {
            let newSec = rEdit.timeTakenSeconds;
            if (newSec === undefined && hasStrField) {
              const rawStr = String(
                rEdit.timeTakenRaw !== undefined
                  ? rEdit.timeTakenRaw
                  : rEdit.timeTaken !== undefined
                    ? rEdit.timeTaken
                    : rEdit.timeTakenInput
              ).trim();
              if (rawStr === '') {
                newSec = null;
              } else {
                const pt = parseTimeCell(rawStr, {
                  maxSeconds: DB_MAX_ROUND_TIME_TAKEN_SECONDS,
                });
                if (pt.status === 'ok') newSec = pt.seconds;
              }
            }

            if (newSec !== undefined) {
              if (
                newSec !== origValues.timeTakenSeconds ||
                origValues.timeTakenOverLimit ||
                origValues.timeTakenUnreadable
              ) {
                nextSummary.timeTakenSeconds = newSec;
                nextSummary.timeTakenRawSeconds = newSec;
                nextSummary.timeTakenRaw =
                  newSec !== null ? formatSecondsDisplay(newSec, true) : '';
                nextSummary.timeTakenDisplay =
                  newSec !== null ? formatSecondsDisplay(newSec, true) : '—';
                nextSummary.timeTakenOverLimit = false;
                nextSummary.timeTakenUnreadable = false;
                nextSummary.withoutTime = false;
                isRoundEdited = true;
                editedFields.push('timeTaken');
              }
            }
          }
        }
      }

      // Clone and apply cell edits for this round
      let sumCorrect = 0;
      let sumTotal = 0;
      let okCount = 0;
      let emptyCount = 0;
      let noteCount = 0;
      let unreadableCount = 0;
      let skippedCount = 0;
      let hasUnreadableScore = false;
      let hasUnreadableCell = false;

      const nextCells = (rnd.cells || []).map((cell, cellIdx) => {
        const rowKey =
          cell.rowIndex !== undefined ? cell.rowIndex : cell.categoryRowIndex ?? cellIdx;
        const cEdit = findCellEditEntry(editState, bNum, rNum, rowKey);

        const origCell = cell.originalValues || cell.original || {
          status: cell.status,
          scoreStatus: cell.scoreStatus,
          timeStatus: cell.timeStatus,
          correct: cell.correct,
          total: cell.total,
          timeSeconds: cell.timeSeconds,
          timeDisplay: cell.timeDisplay,
          note: cell.note,
          noteTruncated: Boolean(cell.noteTruncated),
          originalNoteLength:
            cell.originalNoteLength || (cell.note ? cell.note.length : 0),
          rawScore: cell.rawScore,
          rawTime: cell.rawTime,
          reason: cell.reason || null,
        };

        let nextCell;
        if (!cEdit) {
          nextCell = {
            ...cell,
            rowIndex: rowKey,
            categoryRowIndex: rowKey,
            originalValues: { ...origCell },
            original: { ...origCell },
            status: origCell.status,
            scoreStatus: origCell.scoreStatus,
            timeStatus: origCell.timeStatus,
            correct: origCell.correct,
            total: origCell.total,
            timeSeconds: origCell.timeSeconds,
            timeDisplay: origCell.timeDisplay,
            note: origCell.note,
            noteTruncated: origCell.noteTruncated,
            rawScore: origCell.rawScore,
            rawTime: origCell.rawTime,
            reason: origCell.reason,
            isEdited: false,
            cellEdited: false,
            cellSkippedByAdmin: false,
            adminSkipped: false,
            editedFields: [],
          };
        } else if (cEdit.skip || cEdit.skipped) {
          nextCell = {
            ...cell,
            rowIndex: rowKey,
            categoryRowIndex: rowKey,
            originalValues: { ...origCell },
            original: { ...origCell },
            status: 'skipped',
            scoreStatus: 'empty',
            timeStatus: 'empty',
            correct: null,
            total: null,
            timeSeconds: null,
            timeDisplay: null,
            note: null,
            noteTruncated: false,
            reason: 'Skipped by admin in preview',
            isEdited: true,
            cellEdited: true,
            cellSkippedByAdmin: true,
            adminSkipped: true,
            editedFields: ['skip'],
          };
        } else {
          let normCorrect =
            cEdit.correct !== undefined ? cEdit.correct : origCell.correct;
          let normTotal =
            cEdit.total !== undefined ? cEdit.total : origCell.total;
          let normTimeSeconds =
            cEdit.timeSeconds !== undefined
              ? cEdit.timeSeconds
              : origCell.timeSeconds;
          let normNote = cEdit.note !== undefined ? cEdit.note : origCell.note;

          if (
            typeof normCorrect === 'string' ||
            typeof normTotal === 'string' ||
            cEdit.timeRaw !== undefined ||
            cEdit.time !== undefined ||
            cEdit.timeInput !== undefined
          ) {
            const vc = validateCellEdit({
              correct: normCorrect,
              total: normTotal,
              timeRaw:
                cEdit.timeRaw !== undefined
                  ? cEdit.timeRaw
                  : cEdit.time !== undefined
                    ? cEdit.time
                    : cEdit.timeInput !== undefined
                      ? cEdit.timeInput
                      : normTimeSeconds !== null && normTimeSeconds !== undefined
                        ? formatSecondsDisplay(normTimeSeconds, false)
                        : '',
              note: normNote,
            });
            if (vc.ok && vc.value) {
              normCorrect = vc.value.correct;
              normTotal = vc.value.total;
              normTimeSeconds = vc.value.timeSeconds;
              normNote = vc.value.note;
            }
          }

          const isScore =
            normCorrect !== null &&
            normCorrect !== undefined &&
            normTotal !== null &&
            normTotal !== undefined;
          const cEditedFields = [];
          if (normCorrect !== origCell.correct || normTotal !== origCell.total) {
            cEditedFields.push('score');
          }
          if (normTimeSeconds !== origCell.timeSeconds) {
            cEditedFields.push('time');
          }
          if ((normNote || null) !== (origCell.note || null)) {
            cEditedFields.push('note');
          }
          if (origCell.status === 'unreadable' && cEditedFields.length === 0) {
            cEditedFields.push('score');
          }

          nextCell = {
            ...cell,
            rowIndex: rowKey,
            categoryRowIndex: rowKey,
            originalValues: { ...origCell },
            original: { ...origCell },
            status: isScore ? 'ok' : 'note',
            scoreStatus: isScore ? 'ok' : 'note',
            timeStatus:
              normTimeSeconds !== null && normTimeSeconds !== undefined
                ? 'ok'
                : 'empty',
            correct: isScore ? normCorrect : null,
            total: isScore ? normTotal : null,
            timeSeconds: isScore ? normTimeSeconds : null,
            timeDisplay:
              isScore && normTimeSeconds !== null && normTimeSeconds !== undefined
                ? formatSecondsDisplay(normTimeSeconds, false)
                : null,
            note: normNote || null,
            noteTruncated: false,
            reason: null,
            isEdited: true,
            cellEdited: true,
            cellSkippedByAdmin: false,
            adminSkipped: false,
            editedFields: cEditedFields,
          };
        }

        // Accumulate per-round totals for non-skipped cells
        if (nextCell.cellSkippedByAdmin || nextCell.status === 'skipped') {
          skippedCount += 1;
        } else if (nextCell.status === 'ok') {
          okCount += 1;
          sumCorrect += nextCell.correct;
          sumTotal += nextCell.total;
        } else if (nextCell.status === 'empty') {
          emptyCount += 1;
        } else if (nextCell.status === 'note') {
          noteCount += 1;
        } else if (nextCell.status === 'unreadable') {
          unreadableCount += 1;
          hasUnreadableCell = true;
          if (nextCell.scoreStatus === 'unreadable') {
            hasUnreadableScore = true;
          }
        }

        return nextCell;
      });

      const computedMarks = sumTotal - sumCorrect;
      const sheetDerivedMarks =
        nextSummary.totalAttempt !== null && nextSummary.finalScore !== null
          ? nextSummary.totalAttempt - nextSummary.finalScore
          : null;

      const nextCrossChecks = {
        finalScore: evaluateCrossCheck({
          label: 'Final Score',
          sheetValue: nextSummary.finalScore,
          sheetUnreadable: nextSummary.finalScoreUnreadable,
          computedValue: sumCorrect,
          incomplete: hasUnreadableScore,
          ref: nextSummary.finalScoreRef,
        }),
        totalAttempt: evaluateCrossCheck({
          label: 'Total Attempt',
          sheetValue: nextSummary.totalAttempt,
          sheetUnreadable: nextSummary.totalAttemptUnreadable,
          computedValue: sumTotal,
          incomplete: hasUnreadableScore,
          ref: nextSummary.totalAttemptRef,
        }),
        marksToBeCorrected: evaluateMarksCrossCheck({
          sheetValue: nextSummary.marksToBeCorrected,
          sheetUnreadable: nextSummary.marksToBeCorrectedUnreadable,
          computedMarks,
          sheetDerivedMarks,
          incomplete: hasUnreadableScore,
          ref: nextSummary.marksToBeCorrectedRef,
        }),
      };

      const anyCellEdited = nextCells.some((c) => c.isEdited);

      return {
        ...rnd,
        originalValues: origValues,
        original: origValues,
        rawDate: nextRawDate,
        dateISO: nextDateISO,
        dateStatus: nextDateStatus,
        dateError: nextDateError,
        dateFlags: [],
        excluded: false,
        exclusionReason: null,
        roundSkippedByAdmin,
        adminSkipped: roundSkippedByAdmin,
        isEdited: isRoundEdited,
        roundEdited: isRoundEdited,
        hasEditedCells: anyCellEdited,
        editedFields,
        summary: nextSummary,
        cells: nextCells,
        computed: {
          sumCorrect,
          sumTotal,
          computedMarks,
          okCount,
          emptyCount,
          noteCount,
          unreadableCount,
          skippedCount,
          hasUnreadableScore,
          hasUnreadableCell,
        },
        crossChecks: nextCrossChecks,
      };
    });

    return {
      ...blk,
      rounds: nextRounds,
      dateErrors: [],
      dateWarnings: [],
      dateInfos: [],
    };
  });

  // Re-run date checks and rebuild Needs Attention items across all blocks
  for (const blk of clonedBlocks) {
    const bNum = Number(blk.blockNumber);

    for (const rnd of blk.rounds) {
      if (rnd.roundSkippedByAdmin) continue;

      if (
        !Number.isInteger(rnd.roundNumber) ||
        rnd.roundNumber < DB_MIN_ROUND_NUMBER ||
        rnd.roundNumber > DB_MAX_ROUND_NUMBER
      ) {
        rnd.excluded = true;
        rnd.exclusionReason = `Round number ${rnd.roundNumber} is outside 1..100,000`;
        recalculatedAttention.push({
          severity: 'warning',
          type: 'round_excluded',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.headerRef,
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Round number ${rnd.roundNumber} at ${rnd.headerRef} is outside 1..100,000 (excluded from import).`,
        });
      }

      if (rnd.dateStatus === 'missing' || (!rnd.dateISO && !rnd.rawDate)) {
        rnd.dateStatus = 'missing';
        rnd.dateError = 'Missing date';
        rnd.excluded = true;
        rnd.exclusionReason = `Missing round date at ${rnd.dateRef}`;
        const flag = {
          severity: 'error',
          code: 'missing_date',
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Missing date at ${rnd.dateRef} (excluded from import).`,
        };
        rnd.dateFlags.push(flag);
        blk.dateErrors.push(flag);
        recalculatedAttention.push({
          severity: 'error',
          type: 'missing_date',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.dateRef,
          excluded: true,
          message: flag.message,
        });
      } else if (rnd.dateStatus === 'unreadable' || !rnd.dateISO) {
        rnd.dateStatus = 'unreadable';
        rnd.excluded = true;
        rnd.exclusionReason =
          rnd.dateError || `Unreadable date "${rnd.rawDate}" at ${rnd.dateRef}`;
        const flag = {
          severity: 'error',
          code: 'unreadable_date',
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Unreadable date "${rnd.rawDate}" at ${rnd.dateRef} (excluded from import).`,
        };
        rnd.dateFlags.push(flag);
        blk.dateErrors.push(flag);
        recalculatedAttention.push({
          severity: 'error',
          type: 'unreadable_date',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.dateRef,
          excluded: true,
          message: flag.message,
        });
      } else {
        const iso = rnd.dateISO;
        if (todayIST && iso > todayIST) {
          rnd.excluded = true;
          rnd.exclusionReason = `Future date ${iso} (after today ${todayIST})`;
          const flag = {
            severity: 'error',
            code: 'future_date',
            message: `Block ${bNum} · Round ${rnd.roundNumber}: Future date ${iso} at ${rnd.dateRef} (after today ${todayIST} — excluded from import).`,
          };
          rnd.dateFlags.push(flag);
          blk.dateErrors.push(flag);
          recalculatedAttention.push({
            severity: 'error',
            type: 'future_date',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: rnd.dateRef,
            excluded: true,
            message: flag.message,
          });
        }

        if (iso < DB_MIN_ROUND_DATE_ISO) {
          rnd.excluded = true;
          rnd.exclusionReason = `Date ${iso} is before ${DB_MIN_ROUND_DATE_ISO}`;
          const flag = {
            severity: 'warning',
            code: 'before_2020',
            message: `Block ${bNum} · Round ${rnd.roundNumber}: Date ${iso} at ${rnd.dateRef} is before 2020 (excluded from import).`,
          };
          rnd.dateFlags.push(flag);
          blk.dateWarnings.push(flag);
          recalculatedAttention.push({
            severity: 'warning',
            type: 'before_2020',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: rnd.dateRef,
            excluded: true,
            message: flag.message,
          });
        }
      }
    }

    // Per-block chronological order & duplicate date checks across non-skipped rounds
    const roundsWithDates = blk.rounds
      .filter((r) => !r.roundSkippedByAdmin && r.dateISO !== null)
      .sort((a, b) => a.roundNumber - b.roundNumber);

    for (let i = 1; i < roundsWithDates.length; i++) {
      const prev = roundsWithDates[i - 1];
      const curr = roundsWithDates[i];
      if (curr.dateISO < prev.dateISO) {
        const msg = `Block ${bNum}: Out-of-order dates — Round ${curr.roundNumber} (${curr.dateISO} at ${curr.dateRef}) is earlier than Round ${prev.roundNumber} (${prev.dateISO} at ${prev.dateRef}).`;
        const flag = { severity: 'warning', code: 'out_of_order_date', message: msg };
        curr.dateFlags.push(flag);
        blk.dateWarnings.push(flag);
        recalculatedAttention.push({
          severity: 'warning',
          type: 'out_of_order_date',
          blockNumber: bNum,
          roundNumber: curr.roundNumber,
          ref: curr.dateRef,
          message: msg,
        });
      }
    }

    const byDate = new Map();
    for (const r of roundsWithDates) {
      if (!byDate.has(r.dateISO)) byDate.set(r.dateISO, []);
      byDate.get(r.dateISO).push(r);
    }
    for (const [iso, group] of byDate.entries()) {
      if (group.length > 1) {
        const [yStr, mStr, dStr] = iso.split('-');
        const humanDate = `${parseInt(dStr, 10)} ${shortMonths[parseInt(mStr, 10) - 1]} ${yStr}`;
        const roundLabels = group.map((g) => `Round ${g.roundNumber}`).join(', ');
        const refs = group.map((g) => g.dateRef).filter(Boolean).join(', ');
        const msg = `Block ${bNum}: Same date ${humanDate} (${iso}) shared by ${roundLabels}.`;
        const flag = { severity: 'info', code: 'duplicate_date', message: msg, dateISO: iso };
        group.forEach((g) => g.dateFlags.push(flag));
        blk.dateInfos.push(flag);
        recalculatedAttention.push({
          severity: 'info',
          type: 'duplicate_date',
          blockNumber: bNum,
          roundNumber: group[0].roundNumber,
          roundNumbers: group.map((g) => g.roundNumber),
          ref: refs || group[0].dateRef,
          dateISO: iso,
          message: msg,
        });
      }
    }

    // Per-round summary, cell, stray, and cross-check attention items for non-skipped rounds
    for (const rnd of blk.rounds) {
      if (rnd.roundSkippedByAdmin) continue;

      if (rnd.summary.roundTypeTruncated) {
        const rawVal =
          rnd.summary.roundTypeOriginal || rnd.summary.roundType || '';
        recalculatedAttention.push({
          severity: 'warning',
          type: 'round_type_truncated',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.roundTypeRef,
          rawText: rawVal,
          message: `Round type "${rawVal.slice(0, 24)}…" at ${rnd.summary.roundTypeRef} is ${rawVal.length} characters (max 40): cut to "${rnd.summary.roundType}".`,
        });
      }

      if (rnd.summary.timeTakenOverLimit) {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'time_taken_over_limit',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.timeTakenRef,
          rawText: rnd.summary.timeTakenRaw,
          seconds: rnd.summary.timeTakenRawSeconds,
          message: `Total time ${rnd.summary.timeTakenRaw} at ${rnd.summary.timeTakenRef} is more than 8 hours: the round will be imported WITHOUT a total time`,
        });
      } else if (rnd.summary.timeTakenUnreadable) {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'unreadable_summary_time',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.timeTakenRef,
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Unreadable Time Taken "${rnd.summary.timeTakenRaw}" at ${rnd.summary.timeTakenRef}.`,
        });
      }

      for (const sType of ['finalScore', 'totalAttempt', 'marksToBeCorrected']) {
        if (rnd.summary[`${sType}Unreadable`]) {
          recalculatedAttention.push({
            severity: 'warning',
            type: 'unreadable_summary_number',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: rnd.summary[`${sType}Ref`],
            message: `Block ${bNum} · Round ${rnd.roundNumber}: Unreadable ${sType} value "${rnd.summary[`${sType}Raw`]}" at ${rnd.summary[`${sType}Ref`]}.`,
          });
        }
      }

      for (const cell of rnd.cells) {
        if (cell.cellSkippedByAdmin || cell.status === 'skipped') continue;

        if (cell.noteTruncated) {
          recalculatedAttention.push({
            severity: 'warning',
            type: 'note_truncated',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: cell.scoreRef,
            rawText: String(cell.rawScore || '').trim().slice(0, 40) + '…',
            categoryName: cell.categoryName,
            message: `Block ${bNum} · Round ${rnd.roundNumber} (${cell.categoryName}): Note at ${cell.scoreRef} is ${cell.originalValues?.originalNoteLength || 501} characters (max 500): cut to 500 characters.`,
          });
        }

        if (cell.scoreStatus === 'unreadable') {
          recalculatedAttention.push({
            severity: 'error',
            type: 'unreadable_score',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: cell.scoreRef,
            rawText: String(cell.rawScore || '').trim(),
            categoryName: cell.categoryName,
            message: `Block ${bNum} · Round ${rnd.roundNumber} (${cell.categoryName}): ${cell.reason || 'Unreadable score'}.`,
          });
        } else if (cell.timeStatus === 'unreadable') {
          recalculatedAttention.push({
            severity: 'warning',
            type: 'unreadable_time',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: cell.timeRef,
            rawText: String(cell.rawTime || '').trim(),
            categoryName: cell.categoryName,
            message: `Block ${bNum} · Round ${rnd.roundNumber} (${cell.categoryName}): ${cell.reason || 'Unreadable time'}.`,
          });
        } else if (cell.status === 'unreadable') {
          recalculatedAttention.push({
            severity: 'warning',
            type: 'time_without_score',
            blockNumber: bNum,
            roundNumber: rnd.roundNumber,
            ref: cell.timeRef,
            rawText: String(cell.rawTime || '').trim(),
            categoryName: cell.categoryName,
            message: `Block ${bNum} · Round ${rnd.roundNumber} (${cell.categoryName}): ${cell.reason || 'Time without score'}.`,
          });
        }
      }

      const roundStrays = (blk.strayValues || []).filter(
        (sv) => Number(sv.roundNumber) === Number(rnd.roundNumber)
      );
      for (const sv of roundStrays) {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'stray_value',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: sv.ref,
          rawText: sv.rawValue,
          message: sv.message,
        });
      }

      if (rnd.crossChecks.finalScore.status === 'MISMATCH') {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Final Score',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.finalScoreRef,
          sheetValue: rnd.crossChecks.finalScore.sheetValue,
          computedValue: rnd.crossChecks.finalScore.computedValue,
          diff: rnd.crossChecks.finalScore.diff,
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Final Score MISMATCH at ${rnd.summary.finalScoreRef || 'summary'} (Sheet: ${rnd.crossChecks.finalScore.sheetValue}, Sum of correct: ${rnd.crossChecks.finalScore.computedValue}, Diff: ${formatSignedDiff(rnd.crossChecks.finalScore.diff)}).`,
        });
      }

      if (rnd.crossChecks.totalAttempt.status === 'MISMATCH') {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Total Attempt',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.totalAttemptRef,
          sheetValue: rnd.crossChecks.totalAttempt.sheetValue,
          computedValue: rnd.crossChecks.totalAttempt.computedValue,
          diff: rnd.crossChecks.totalAttempt.diff,
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Total Attempt MISMATCH at ${rnd.summary.totalAttemptRef || 'summary'} (Sheet: ${rnd.crossChecks.totalAttempt.sheetValue}, Sum of total: ${rnd.crossChecks.totalAttempt.computedValue}, Diff: ${formatSignedDiff(rnd.crossChecks.totalAttempt.diff)}).`,
        });
      }

      if (rnd.crossChecks.marksToBeCorrected.status === 'MISMATCH') {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'crosscheck_mismatch',
          checkName: 'Marks TO BE CORRECTED',
          blockNumber: bNum,
          roundNumber: rnd.roundNumber,
          ref: rnd.summary.marksToBeCorrectedRef,
          sheetValue: rnd.crossChecks.marksToBeCorrected.sheetValue,
          computedValue: rnd.crossChecks.marksToBeCorrected.computedValue,
          diff: rnd.crossChecks.marksToBeCorrected.diff,
          message: `Block ${bNum} · Round ${rnd.roundNumber}: Marks TO BE CORRECTED MISMATCH at ${rnd.summary.marksToBeCorrectedRef || 'summary'} (Sheet: ${rnd.crossChecks.marksToBeCorrected.sheetValue}, Calculated: ${rnd.crossChecks.marksToBeCorrected.computedValue}, Diff: ${formatSignedDiff(rnd.crossChecks.marksToBeCorrected.diff)}).`,
        });
      }
    }

    for (const cat of blk.categories || []) {
      if (cat.matchStatus === 'unmatched') {
        recalculatedAttention.push({
          severity: 'warning',
          type: 'unmatched_category',
          blockNumber: bNum,
          roundNumber: null,
          ref: cat.ref,
          rawText: cat.sheetName,
          message: `Block ${bNum}: Category "${cat.sheetName}" at ${cat.ref} does not match any database round category (choose mapping below).`,
        });
      }
    }
  }

  // Rebuild summary counts (excluding admin-skipped rounds from active counts)
  let totalRounds = 0;
  let skippedRoundsCount = 0;
  let totalCellsOk = 0;
  let totalCellsEmpty = 0;
  let totalCellsUnreadable = 0;
  let totalCellsNote = 0;
  let totalCellsSkipped = 0;
  let totalStray = 0;

  const blockSummaries = clonedBlocks.map((blk) => {
    const activeRounds = blk.rounds.filter((r) => !r.roundSkippedByAdmin);
    const blkSkippedRounds = blk.rounds.length - activeRounds.length;

    totalRounds += activeRounds.length;
    skippedRoundsCount += blkSkippedRounds;

    const activeRoundNums = new Set(activeRounds.map((r) => Number(r.roundNumber)));
    const activeStrayCount = (blk.strayValues || []).filter((sv) =>
      activeRoundNums.has(Number(sv.roundNumber))
    ).length;
    totalStray += activeStrayCount;

    let blkOk = 0;
    let blkEmpty = 0;
    let blkUnreadable = 0;
    let blkNote = 0;
    let blkSkipped = 0;
    const validDates = [];

    for (const rnd of activeRounds) {
      blkOk += rnd.computed.okCount;
      blkEmpty += rnd.computed.emptyCount;
      blkUnreadable += rnd.computed.unreadableCount;
      blkNote += rnd.computed.noteCount;
      blkSkipped += rnd.computed.skippedCount;
      if (rnd.dateISO) validDates.push(rnd.dateISO);
    }

    totalCellsOk += blkOk;
    totalCellsEmpty += blkEmpty;
    totalCellsUnreadable += blkUnreadable;
    totalCellsNote += blkNote;
    totalCellsSkipped += blkSkipped;

    validDates.sort();
    const minDate = validDates.length > 0 ? validDates[0] : null;
    const maxDate =
      validDates.length > 0 ? validDates[validDates.length - 1] : null;

    blk.dateRange = { minDate, maxDate };
    blk.cellCounts = {
      ok: blkOk,
      empty: blkEmpty,
      unreadable: blkUnreadable,
      note: blkNote,
      skipped: blkSkipped,
      stray: activeStrayCount,
    };

    return {
      blockNumber: blk.blockNumber,
      seriesName: blk.seriesName,
      roundCount: activeRounds.length,
      skippedRoundCount: blkSkippedRounds,
      minDate,
      maxDate,
      cellCounts: blk.cellCounts,
    };
  });

  const editsList = buildPreviewEditsList(parsed, editState, blockSeriesMap);

  return {
    ...parsed,
    todayIST,
    blocks: clonedBlocks,
    needsAttention: recalculatedAttention,
    attention: recalculatedAttention,
    editsList,
    edits: editsList,
    summary: {
      ...(parsed.summary || {}),
      blockCount: clonedBlocks.length,
      totalRounds,
      skippedRoundsCount,
      blockSummaries,
      totalCells: {
        ok: totalCellsOk,
        empty: totalCellsEmpty,
        unreadable: totalCellsUnreadable,
        note: totalCellsNote,
        skipped: totalCellsSkipped,
        stray: totalStray,
      },
    },
  };
}

/**
 * Builds the flat, ordered audit list of all edits made in the preview.
 * Each entry includes both snake_case and camelCase properties so callers in UI and tests
 * work seamlessly:
 * - `block_number` / `blockNumber`
 * - `round_number` / `roundNumber`
 * - `series`
 * - `scope`: `'round'` | `'cell'`
 * - `field`: `'round_skipped'` | `'round_date'` | `'round_type'` | `'time_taken_seconds'` | `'cell_skipped'` | `'cell'`
 * - `category_name` / `categoryName`
 * - `row_index` / `rowIndex`
 * - `original_value` / `originalValue`
 * - `new_value` / `newValue`
 * - `skipped`: boolean
 *
 * @param {Object} originalParsed
 * @param {Object} [editState]
 * @param {Object<number, string>} [blockSeriesMap]
 * @returns {Array<Object>}
 */
export function buildPreviewEditsList(
  originalParsed,
  editState = {},
  blockSeriesMap = {}
) {
  if (!originalParsed || !Array.isArray(originalParsed.blocks)) return [];
  const edits = [];

  const pushEditEntry = ({
    blockNumber,
    roundNumber,
    series,
    scope,
    field,
    categoryName = null,
    rowIndex = null,
    ref = null,
    originalValue,
    newValue,
    skipped = false,
  }) => {
    edits.push({
      block_number: blockNumber,
      blockNumber,
      round_number: roundNumber,
      roundNumber,
      series,
      scope,
      field,
      category_name: categoryName,
      categoryName,
      row_index: rowIndex,
      rowIndex,
      ref,
      original_value: originalValue,
      originalValue,
      new_value: newValue,
      newValue,
      skipped: Boolean(skipped),
    });
  };

  for (const blk of originalParsed.blocks) {
    const bNum = Number(blk.blockNumber);
    const seriesName =
      String(blockSeriesMap[bNum] || blk.seriesName || '').trim() ||
      `Block ${bNum}`;

    for (const rnd of blk.rounds || []) {
      const rNum = Number(rnd.roundNumber);
      const rEdit = findRoundEditEntry(editState, bNum, rNum);
      const origR = rnd.originalValues || rnd.original || rnd;
      const origSummary = origR.summary || rnd.summary || {};

      if (rEdit) {
        if (rEdit.skip || rEdit.skipped) {
          pushEditEntry({
            blockNumber: bNum,
            roundNumber: rNum,
            series: seriesName,
            scope: 'round',
            field: 'round_skipped',
            ref: rnd.headerRef || null,
            originalValue: origR.dateISO || origR.rawDate || 'imported',
            newValue: 'skipped',
            skipped: true,
          });
        } else {
          const editedDate =
            rEdit.roundDate !== undefined ? rEdit.roundDate : rEdit.dateISO;
          if (editedDate !== undefined && editedDate !== origR.dateISO) {
            pushEditEntry({
              blockNumber: bNum,
              roundNumber: rNum,
              series: seriesName,
              scope: 'round',
              field: 'round_date',
              ref: rnd.dateRef || null,
              originalValue: origR.dateISO || origR.rawDate || '(missing)',
              newValue: editedDate,
              skipped: false,
            });
          }

          const origType =
            origR.roundTypeOriginal ??
            origSummary.roundTypeOriginal ??
            origR.roundType ??
            origSummary.roundType ??
            null;
          if (rEdit.roundType !== undefined) {
            const newType = rEdit.roundType
              ? String(rEdit.roundType).trim()
              : null;
            if (newType !== origType) {
              pushEditEntry({
                blockNumber: bNum,
                roundNumber: rNum,
                series: seriesName,
                scope: 'round',
                field: 'round_type',
                ref: origSummary.roundTypeRef || null,
                originalValue: origType || '',
                newValue: newType || '',
                skipped: false,
              });
            }
          }

          let newSec = rEdit.timeTakenSeconds;
          if (
            newSec === undefined &&
            (rEdit.timeTakenRaw !== undefined ||
              rEdit.timeTaken !== undefined ||
              rEdit.timeTakenInput !== undefined)
          ) {
            const rawT = String(
              rEdit.timeTakenRaw !== undefined
                ? rEdit.timeTakenRaw
                : rEdit.timeTaken !== undefined
                  ? rEdit.timeTaken
                  : rEdit.timeTakenInput
            ).trim();
            if (rawT === '') {
              newSec = null;
            } else {
              const pT = parseTimeCell(rawT, {
                maxSeconds: DB_MAX_ROUND_TIME_TAKEN_SECONDS,
              });
              if (pT.status === 'ok') newSec = pT.seconds;
            }
          }

          if (newSec !== undefined) {
            const origSec =
              origR.timeTakenSeconds !== undefined
                ? origR.timeTakenSeconds
                : origSummary.timeTakenSeconds ?? null;
            const origRaw = String(
              origR.timeTakenRaw !== undefined
                ? origR.timeTakenRaw
                : origSummary.timeTakenRaw || ''
            ).trim();
            const origOver = Boolean(
              origR.timeTakenOverLimit ?? origSummary.timeTakenOverLimit
            );
            const origUnreadable = Boolean(
              origR.timeTakenUnreadable ?? origSummary.timeTakenUnreadable
            );

            if (newSec !== origSec || origOver || origUnreadable) {
              const origDisplay = origRaw
                ? origRaw
                : origSec !== null
                  ? formatSecondsDisplay(origSec, true)
                  : '';
              const newDisplay =
                newSec !== null ? formatSecondsDisplay(newSec, true) : '';
              pushEditEntry({
                blockNumber: bNum,
                roundNumber: rNum,
                series: seriesName,
                scope: 'round',
                field: 'time_taken_seconds',
                ref: origSummary.timeTakenRef || null,
                originalValue: origDisplay,
                newValue: newDisplay,
                skipped: false,
              });
            }
          }
        }
      }

      // Cell edits in this round
      for (let idx = 0; idx < (rnd.cells || []).length; idx++) {
        const cell = rnd.cells[idx];
        const rowKey =
          cell.rowIndex !== undefined ? cell.rowIndex : cell.categoryRowIndex ?? idx;
        const cEdit = findCellEditEntry(editState, bNum, rNum, rowKey);
        if (!cEdit) continue;

        const origC = cell.originalValues || cell.original || cell;
        const origSnap = formatCellAuditSnapshot(origC);

        if (cEdit.skip || cEdit.skipped) {
          pushEditEntry({
            blockNumber: bNum,
            roundNumber: rNum,
            series: seriesName,
            scope: 'cell',
            field: `${cell.categoryName}.skipped`,
            categoryName: cell.categoryName,
            rowIndex: rowKey,
            ref: cell.scoreRef || null,
            originalValue: origSnap,
            newValue: 'skipped',
            skipped: true,
          });
        } else {
          let normEdit = cEdit;
          if (
            typeof cEdit.correct === 'string' ||
            typeof cEdit.total === 'string' ||
            cEdit.timeRaw !== undefined ||
            cEdit.time !== undefined ||
            cEdit.timeInput !== undefined
          ) {
            const vc = validateCellEdit(cEdit);
            if (vc.ok && vc.value) normEdit = vc.value;
          }

          let pushedFieldChange = false;
          const origCorrect = origC.correct ?? null;
          const origTotal = origC.total ?? null;
          const newCorrect =
            normEdit.correct !== undefined ? normEdit.correct : origCorrect;
          const newTotal =
            normEdit.total !== undefined ? normEdit.total : origTotal;

          if (
            newCorrect !== origCorrect ||
            newTotal !== origTotal ||
            origC.scoreStatus === 'unreadable'
          ) {
            const origScoreStr =
              origCorrect !== null && origTotal !== null
                ? `${origCorrect}/${origTotal}`
                : String(origC.rawScore || '').trim() || '';
            const newScoreStr =
              newCorrect !== null && newTotal !== null
                ? `${newCorrect}/${newTotal}`
                : '';
            if (origScoreStr !== newScoreStr) {
              pushEditEntry({
                blockNumber: bNum,
                roundNumber: rNum,
                series: seriesName,
                scope: 'cell',
                field: `${cell.categoryName}.score`,
                categoryName: cell.categoryName,
                rowIndex: rowKey,
                ref: cell.scoreRef || null,
                originalValue: origScoreStr,
                newValue: newScoreStr,
                skipped: false,
              });
              pushedFieldChange = true;
            }
          }

          const origTimeSec = origC.timeSeconds ?? null;
          const newTimeSec =
            normEdit.timeSeconds !== undefined ? normEdit.timeSeconds : origTimeSec;
          if (
            newTimeSec !== origTimeSec ||
            origC.timeStatus === 'unreadable'
          ) {
            const origTimeStr =
              origC.timeDisplay ||
              (origTimeSec !== null
                ? formatSecondsDisplay(origTimeSec, false)
                : String(origC.rawTime || '').trim());
            const newTimeStr =
              newTimeSec !== null && newTimeSec !== undefined
                ? formatSecondsDisplay(newTimeSec, false)
                : '';
            pushEditEntry({
              blockNumber: bNum,
              roundNumber: rNum,
              series: seriesName,
              scope: 'cell',
              field: `${cell.categoryName}.time_seconds`,
              categoryName: cell.categoryName,
              rowIndex: rowKey,
              ref: cell.timeRef || cell.scoreRef || null,
              originalValue: origTimeStr,
              newValue: newTimeStr,
              skipped: false,
            });
            pushedFieldChange = true;
          }

          const origNote = origC.note ? String(origC.note).trim() : '';
          const newNote =
            normEdit.note !== undefined && normEdit.note !== null
              ? String(normEdit.note).trim()
              : origNote;
          if (newNote !== origNote || origC.noteTruncated) {
            pushEditEntry({
              blockNumber: bNum,
              roundNumber: rNum,
              series: seriesName,
              scope: 'cell',
              field: `${cell.categoryName}.note`,
              categoryName: cell.categoryName,
              rowIndex: rowKey,
              ref: cell.scoreRef || null,
              originalValue: origNote,
              newValue: newNote,
              skipped: false,
            });
            pushedFieldChange = true;
          }

          if (!pushedFieldChange) {
            const newSnap = formatCellAuditSnapshot(normEdit);
            pushEditEntry({
              blockNumber: bNum,
              roundNumber: rNum,
              series: seriesName,
              scope: 'cell',
              field: `cell (${cell.categoryName})`,
              categoryName: cell.categoryName,
              rowIndex: rowKey,
              ref: cell.scoreRef || null,
              originalValue: origSnap,
              newValue: newSnap,
              skipped: false,
            });
          }
        }
      }
    }
  }

  return edits;
}

/* ==========================================================================
   SERIES SUGGESTION, CATEGORY RESOLUTION & DB COMPARISON (PHASE 4c-2a/2b/2c)
   ========================================================================== */

/**
 * Extracts block header metadata (series hint, round range, date range, and associated gap hints).
 *
 * @param {Object} block
 * @param {Array<Object>|Object} [allBlocksOrParsed]
 * @param {Array<Object>} [labelHints]
 * @returns {Object}
 */
export function getBlockHeaderMetadata(
  block,
  allBlocksOrParsed = null,
  labelHints = null
) {
  if (!block) {
    return {
      blockNumber: 1,
      seriesHint: null,
      anchorRef: null,
      roundCount: 0,
      categoryCount: 0,
      roundRange: { minRound: null, maxRound: null, count: 0, text: '0 rounds' },
      dateRange: { minDate: null, maxDate: null },
      blockHints: [],
    };
  }

  const allBlocks = Array.isArray(allBlocksOrParsed)
    ? allBlocksOrParsed
    : Array.isArray(allBlocksOrParsed?.blocks)
      ? allBlocksOrParsed.blocks
      : [block];
  const hints = Array.isArray(labelHints)
    ? labelHints
    : Array.isArray(allBlocksOrParsed?.labelHints)
      ? allBlocksOrParsed.labelHints
      : Array.isArray(block.labelHints)
        ? block.labelHints
        : [];

  const activeRounds = (block.rounds || []).filter((r) => !r.roundSkippedByAdmin);
  const roundNums = activeRounds
    .map((r) => Number(r.roundNumber))
    .filter((n) => Number.isFinite(n));
  const minRound = roundNums.length > 0 ? Math.min(...roundNums) : null;
  const maxRound = roundNums.length > 0 ? Math.max(...roundNums) : null;
  const roundCount = roundNums.length;
  const roundRangeText =
    roundCount === 0
      ? '0 rounds'
      : roundCount === 1
        ? `Round ${minRound} (1 round)`
        : `Rounds ${minRound}–${maxRound} (${roundCount} rounds)`;

  const validDates = activeRounds
    .map((r) => r.dateISO)
    .filter(Boolean)
    .sort();
  const minDate =
    block.dateRange?.minDate !== undefined
      ? block.dateRange.minDate
      : validDates.length > 0
        ? validDates[0]
        : null;
  const maxDate =
    block.dateRange?.maxDate !== undefined
      ? block.dateRange.maxDate
      : validDates.length > 0
        ? validDates[validDates.length - 1]
        : null;

  let blockHints = [];
  if (hints.length > 0) {
    const getLastDataCol = (b) => {
      if (!b) return -1;
      const rCols = (b.rounds || []).flatMap((r) => [
        r.scoreCol ?? -1,
        r.timeCol ?? -1,
      ]);
      const maxRCol = rCols.length > 0 ? Math.max(...rCols) : -1;
      return maxRCol >= 0 ? maxRCol : b.endCol ?? Infinity;
    };

    const prevBlock = allBlocks.find(
      (b) => b.blockNumber === block.blockNumber - 1
    );
    const isLastBlock = !allBlocks.some(
      (b) => b.blockNumber > block.blockNumber
    );
    const prevEndCol = prevBlock ? getLastDataCol(prevBlock) : -1;
    const currEndCol = isLastBlock ? Infinity : getLastDataCol(block);

    blockHints = hints.filter((h) => {
      const c = h.col !== undefined ? h.col : h.colIndex;
      return c > prevEndCol && c <= currEndCol;
    });
  } else if (Array.isArray(block.labelHints) && block.labelHints.length > 0) {
    blockHints = block.labelHints;
  }

  return {
    blockNumber: block.blockNumber || 1,
    seriesHint:
      block.seriesName ||
      block.labelHint ||
      (blockHints.length > 0 ? blockHints[0].text : null),
    anchorRef: block.anchorRef || null,
    roundCount,
    categoryCount: Array.isArray(block.categories) ? block.categories.length : 0,
    studentName:
      (!Array.isArray(allBlocksOrParsed) &&
        allBlocksOrParsed?.primaryStudentName) ||
      null,
    roundRange: {
      minRound,
      maxRound,
      count: roundCount,
      text: roundRangeText,
    },
    dateRange: {
      minDate,
      maxDate,
    },
    blockHints,
  };
}

/**
 * Suggests a simulator series for a parsed block (or array of categories) based on
 * top-row banner hints, distinctive category names, and fallback block order.
 *
 * Accepts either `(block, roundSeries)` or `(categoriesArray, roundSeries)`.
 *
 * @param {Object|Array<Object>} blockOrCategories
 * @param {Array<{ id: string, name: string, is_current?: boolean, sort_order?: number }>} [roundSeries=[]]
 * @returns {{ suggestedSeriesId: string|null, suggestedSeriesName: string|null, confidence: 'high'|'medium'|'low'|'none', reason: string, matchedMarkers: string[] }}
 */
export function suggestSeriesForBlock(
  blockOrCategories,
  roundSeries = []
) {
  const seriesList = Array.isArray(roundSeries) ? roundSeries : [];
  if (seriesList.length === 0) {
    return {
      suggestedSeriesId: null,
      suggestedSeriesName: null,
      confidence: 'none',
      reason: 'No simulator series found in the database.',
      matchedMarkers: [],
    };
  }

  const isCategoryArray = Array.isArray(blockOrCategories);
  const block = isCategoryArray ? null : blockOrCategories;
  const categories = isCategoryArray
    ? blockOrCategories
    : blockOrCategories?.categories || [];

  const findSeriesByKeyword = (kw) =>
    seriesList.find((s) =>
      String(s.name || '')
        .toLowerCase()
        .includes(kw.toLowerCase())
    );

  const oldSeries = findSeriesByKeyword('old');
  const newSeries = findSeriesByKeyword('new');

  // 1. Check distinctive categories first
  const catEntries = categories.map((c) => {
    const rawName = typeof c === 'string' ? c : c.sheetName || c.name || '';
    return {
      rawName,
      key: toMatchingKey(rawName),
    };
  });

  const oldMarkerMatches = catEntries.filter((e) =>
    OLD_SIMULATOR_MARKER_KEYS.includes(e.key)
  );
  const newMarkerMatches = catEntries.filter((e) =>
    NEW_SIMULATOR_MARKER_KEYS.includes(e.key)
  );

  if (oldMarkerMatches.length > 0 && newMarkerMatches.length === 0 && oldSeries) {
    return {
      suggestedSeriesId: oldSeries.id,
      suggestedSeriesName: oldSeries.name,
      confidence: 'high',
      reason: `Detected Old Simulator categories (${oldMarkerMatches.map((m) => m.rawName).join(', ')}). Suggested "${oldSeries.name}" — please confirm.`,
      matchedMarkers: oldMarkerMatches.map((m) => m.rawName),
    };
  }

  if (newMarkerMatches.length > 0 && oldMarkerMatches.length === 0 && newSeries) {
    return {
      suggestedSeriesId: newSeries.id,
      suggestedSeriesName: newSeries.name,
      confidence: 'high',
      reason: `Detected New Simulator categories (${newMarkerMatches.map((m) => m.rawName).join(', ')}). Suggested "${newSeries.name}" — please confirm.`,
      matchedMarkers: newMarkerMatches.map((m) => m.rawName),
    };
  }

  // 2. Check explicit top-row simulator banner hint on the block
  const hint = String(block?.seriesName || block?.labelHint || '').toLowerCase();
  if (hint.includes('new simulator') && newSeries) {
    return {
      suggestedSeriesId: newSeries.id,
      suggestedSeriesName: newSeries.name,
      confidence: 'high',
      reason: `Detected "NEW SIMULATOR" banner above Block ${block?.blockNumber || 1}. Suggested "${newSeries.name}" — please confirm.`,
      matchedMarkers: newMarkerMatches.map((m) => m.rawName),
    };
  }
  if (hint.includes('old simulator') && oldSeries) {
    return {
      suggestedSeriesId: oldSeries.id,
      suggestedSeriesName: oldSeries.name,
      confidence: 'high',
      reason: `Detected "OLD SIMULATOR" banner above Block ${block?.blockNumber || 1}. Suggested "${oldSeries.name}" — please confirm.`,
      matchedMarkers: oldMarkerMatches.map((m) => m.rawName),
    };
  }

  if (oldMarkerMatches.length > 0 && newMarkerMatches.length > 0) {
    const pick =
      newMarkerMatches.length >= oldMarkerMatches.length
        ? newSeries
        : oldSeries;
    return {
      suggestedSeriesId: pick ? pick.id : null,
      suggestedSeriesName: pick ? pick.name : null,
      confidence: 'low',
      reason: 'Mixed Old and New Simulator categories found in block — please verify and confirm.',
      matchedMarkers: [
        ...oldMarkerMatches.map((m) => m.rawName),
        ...newMarkerMatches.map((m) => m.rawName),
      ],
    };
  }

  // 3. No distinctive markers and no banner hint
  return {
    suggestedSeriesId: null,
    suggestedSeriesName: null,
    confidence: 'none',
    reason: 'No distinctive simulator markers found in category list — please select and confirm the simulator series.',
    matchedMarkers: [],
  };
}

/**
 * Validates that every block has a non-empty confirmed seriesId and that no two blocks
 * in the same import share the same simulator series.
 *
 * Accepts either:
 * - an array of `{ blockNumber, seriesId, confirmed }`
 * - OR `(blocksArray, blockUiStateMap, roundSeriesArray)`
 */
export function validateBlockSeriesSelections(
  arg1 = [],
  arg2 = [],
  arg3 = []
) {
  let selections = [];
  let seriesList = [];

  if (
    Array.isArray(arg1) &&
    arg1.length > 0 &&
    arg1[0] &&
    arg1[0].categories !== undefined &&
    arg2 &&
    typeof arg2 === 'object' &&
    !Array.isArray(arg2)
  ) {
    // Called as (blocks, blockUiState, roundSeries)
    seriesList = Array.isArray(arg3) ? arg3 : [];
    selections = arg1.map((blk) => {
      const ui = arg2[blk.blockNumber] || {};
      return {
        blockNumber: blk.blockNumber,
        seriesId: ui.seriesId || null,
        confirmed: Boolean(ui.confirmed && ui.seriesId),
      };
    });
  } else {
    selections = Array.isArray(arg1) ? arg1 : [];
    seriesList = Array.isArray(arg2) ? arg2 : [];
  }

  const unconfirmedBlocks = [];
  const errors = [];
  const seriesById = new Map(seriesList.map((s) => [s.id, s]));
  const blocksBySeriesId = new Map();

  for (const sel of selections) {
    const bNum = sel.blockNumber;
    if (!sel.seriesId || !sel.confirmed) {
      unconfirmedBlocks.push(bNum);
      errors.push({
        type: 'unconfirmed_series',
        blockNumber: bNum,
        message: `Block ${bNum}: Simulator series must be selected and confirmed before importing.`,
      });
    }
    if (sel.seriesId) {
      if (!blocksBySeriesId.has(sel.seriesId)) {
        blocksBySeriesId.set(sel.seriesId, []);
      }
      blocksBySeriesId.get(sel.seriesId).push(bNum);
    }
  }

  let duplicateSeriesError = null;
  const duplicateSeriesIds = [];
  for (const [sId, bNums] of blocksBySeriesId.entries()) {
    if (bNums.length > 1) {
      duplicateSeriesIds.push(sId);
      const sName = seriesById.get(sId)?.name || sId;
      duplicateSeriesError = `Blocks ${bNums.join(' and ')} are both assigned to "${sName}". Each block in a multi-block sheet must map to a distinct simulator series.`;
      errors.push({
        type: 'duplicate_series',
        seriesId: sId,
        blockNumbers: bNums,
        message: duplicateSeriesError,
      });
    }
  }

  const valid = unconfirmedBlocks.length === 0 && !duplicateSeriesError;
  return {
    valid,
    allConfirmed: valid,
    duplicateSeriesIds,
    duplicateSeriesError,
    unconfirmedBlocks,
    errors,
  };
}

/**
 * Resolves all categories in a block against:
 * 1. Saved database aliases (`categoryAliases` / `dbAliases` from `public.category_aliases`)
 * 2. Built-in aliases (`Calender` -> `Calendar`, `Time Elapse` -> `Time Elapsed`)
 * 3. Exact/normalized name match in `roundCategories`
 * 4. Explicit admin override decisions (`adminMappings[rawKey]`)
 */
export function resolveBlockCategories(arg1 = {}, arg2 = {}) {
  let params = arg1;
  if (Array.isArray(arg1)) {
    params = {
      ...arg2,
      block: {
        blockNumber: arg2?.blockNumber || 1,
        categories: arg1,
      },
    };
  } else if (arg1 && Array.isArray(arg1.categories) && !arg1.block) {
    params = {
      ...arg2,
      block: arg1,
    };
  }

  const block = params.block;
  const blockNumber = block?.blockNumber || params.blockNumber || 1;
  const selectedSeriesId =
    params.selectedSeriesId !== undefined
      ? params.selectedSeriesId
      : params.seriesId || null;
  const roundCategories = Array.isArray(params.roundCategories)
    ? params.roundCategories
    : [];
  const seriesCategories = Array.isArray(params.seriesCategories)
    ? params.seriesCategories
    : Array.isArray(params.categorySeries)
      ? params.categorySeries
      : [];
  const roundSeries = Array.isArray(params.roundSeries)
    ? params.roundSeries
    : [];
  const dbAliases = Array.isArray(params.dbAliases)
    ? params.dbAliases
    : Array.isArray(params.categoryAliases)
      ? params.categoryAliases
      : [];
  const adminMappings = params.adminMappings || {};

  const catById = new Map();
  const catByNormKey = new Map();
  for (const rc of roundCategories) {
    if (!rc) continue;
    catById.set(rc.id, rc);
    catByNormKey.set(toMatchingKey(rc.name), rc);
  }

  const seriesById = new Map(roundSeries.map((s) => [s.id, s]));
  const seriesIdsByCatId = new Map();
  const sortOrderBySeriesAndCat = new Map();
  for (const sc of seriesCategories) {
    if (!sc || !sc.category_id || !sc.series_id) continue;
    if (!seriesIdsByCatId.has(sc.category_id)) {
      seriesIdsByCatId.set(sc.category_id, new Set());
    }
    seriesIdsByCatId.get(sc.category_id).add(sc.series_id);
    sortOrderBySeriesAndCat.set(
      `${sc.series_id}::${sc.category_id}`,
      sc.sort_order ?? null
    );
  }

  const dbAliasMap = new Map();
  for (const al of dbAliases) {
    if (!al || !al.alias || !al.category_id) continue;
    dbAliasMap.set(toMatchingKey(al.alias), al.category_id);
  }

  let inSelectedSeriesCount = 0;
  let inOtherSeriesOnly = 0;
  let mappedByAdmin = 0;
  let createHistorical = 0;
  let skippedByAdmin = 0;
  let unresolved = 0;
  const warnings = [];
  const errors = [];

  const items = (block?.categories || []).map((cat, idx) => {
    const rawName = String(cat.sheetName || cat.name || '').trim();
    const { rawKey, normalizedKey, usedAlias } = normalizeCategoryKey(rawName);
    const adminDecision =
      adminMappings[rawKey] || adminMappings[rawName] || null;

    // 3-tier priority: category_aliases -> built-in aliases -> exact match
    let autoMatchedCat = null;
    let matchedVia = 'none';

    if (dbAliasMap.has(rawKey)) {
      const targetId = dbAliasMap.get(rawKey);
      if (catById.has(targetId)) {
        autoMatchedCat = catById.get(targetId);
        matchedVia = 'db_alias';
      }
    }
    if (!autoMatchedCat && usedAlias && catByNormKey.has(normalizedKey)) {
      autoMatchedCat = catByNormKey.get(normalizedKey);
      matchedVia = 'builtin_alias';
    }
    if (!autoMatchedCat && catByNormKey.has(rawKey)) {
      autoMatchedCat = catByNormKey.get(rawKey);
      matchedVia = 'exact';
    }

    let resolutionStatus = 'unresolved';
    let effectiveStatus = 'unmatched';
    let resolvedCategory = autoMatchedCat;
    let saveAliasRequested = false;

    if (adminDecision && adminDecision.action && adminDecision.action !== 'auto') {
      const act = adminDecision.action;
      if (act === 'skip') {
        resolutionStatus = 'skipped_by_admin';
        effectiveStatus = 'skipped';
        resolvedCategory = null;
        skippedByAdmin += 1;
      } else if (act === 'create_historical' || act === 'create') {
        resolutionStatus = 'create_historical';
        effectiveStatus = 'create_historical';
        resolvedCategory = null;
        createHistorical += 1;
      } else if (act === 'map_existing' || act === 'map') {
        const targetId =
          adminDecision.targetCategoryId || adminDecision.matchedCategoryId;
        const targetCat = catById.get(targetId) || null;
        if (targetCat) {
          resolutionStatus = 'mapped_by_admin';
          effectiveStatus = 'mapped';
          resolvedCategory = targetCat;
          saveAliasRequested = Boolean(adminDecision.saveAlias);
          mappedByAdmin += 1;
        } else {
          resolutionStatus = 'unresolved';
          effectiveStatus = 'unmatched';
          resolvedCategory = null;
          unresolved += 1;
        }
      }
    } else if (autoMatchedCat) {
      effectiveStatus = matchedVia;
      const linkedSet = seriesIdsByCatId.get(autoMatchedCat.id) || new Set();
      if (selectedSeriesId && linkedSet.has(selectedSeriesId)) {
        resolutionStatus = 'in_selected_series';
        inSelectedSeriesCount += 1;
      } else if (linkedSet.size > 0 || !selectedSeriesId) {
        resolutionStatus = selectedSeriesId
          ? 'in_other_series_only'
          : 'in_selected_series';
        if (selectedSeriesId) {
          inOtherSeriesOnly += 1;
        } else {
          inSelectedSeriesCount += 1;
        }
      } else {
        resolutionStatus = 'in_other_series_only';
        inOtherSeriesOnly += 1;
      }
    } else {
      resolutionStatus = 'unresolved';
      effectiveStatus = 'unmatched';
      unresolved += 1;
    }

    const linkedSet = resolvedCategory
      ? seriesIdsByCatId.get(resolvedCategory.id) || new Set()
      : new Set();
    const inSelectedSeries = Boolean(
      resolvedCategory &&
        (selectedSeriesId ? linkedSet.has(selectedSeriesId) : true)
    );
    const seriesSortOrder =
      resolvedCategory && selectedSeriesId
        ? sortOrderBySeriesAndCat.get(
            `${selectedSeriesId}::${resolvedCategory.id}`
          ) ?? null
        : null;

    if (resolvedCategory && selectedSeriesId && !inSelectedSeries) {
      warnings.push({
        type: 'category_not_in_series',
        blockNumber,
        categoryName: rawName,
        resolvedCategoryId: resolvedCategory.id,
        resolvedCategoryName: resolvedCategory.name,
        message: `Block ${blockNumber}: Category "${rawName}" (${resolvedCategory.name}) is not linked to the selected simulator series.`,
      });
    }

    const linkedSeriesIds = Array.from(linkedSet);
    const seriesNames = linkedSeriesIds
      .map((id) => seriesById.get(id)?.name)
      .filter(Boolean);

    return {
      rowIndex: cat.rowIndex ?? idx,
      rowNumber: (cat.rowIndex ?? idx) + 1,
      sNo: cat.indexLabel ?? idx + 1,
      nameRef: cat.ref || null,
      rawName,
      sheetName: rawName,
      rawKey,
      normalizedKey,
      matchedVia,
      effectiveStatus,
      resolutionStatus,
      resolvedCategory: resolvedCategory || null,
      resolvedCategoryId: resolvedCategory ? resolvedCategory.id : null,
      resolvedCategoryName: resolvedCategory
        ? resolvedCategory.name
        : resolutionStatus === 'create_historical'
          ? rawName
          : null,
      resolvedCategoryActive: resolvedCategory
        ? resolvedCategory.active !== false
        : false,
      inSelectedSeries,
      seriesSortOrder,
      duplicateTargetError: false,
      seriesIds: linkedSeriesIds,
      seriesNames,
      saveAliasRequested,
    };
  });

  // Duplicate target category detection within the same block
  const itemsByTargetId = new Map();
  for (const item of items) {
    if (!item.resolvedCategoryId) continue;
    if (!itemsByTargetId.has(item.resolvedCategoryId)) {
      itemsByTargetId.set(item.resolvedCategoryId, []);
    }
    itemsByTargetId.get(item.resolvedCategoryId).push(item);
  }
  for (const [targetId, group] of itemsByTargetId.entries()) {
    if (group.length > 1) {
      for (const item of group) {
        item.duplicateTargetError = true;
      }
      const targetName = group[0].resolvedCategoryName || targetId;
      errors.push({
        type: 'duplicate_category_target',
        blockNumber,
        targetCategoryId: targetId,
        targetCategoryName: targetName,
        sheetNames: group.map((g) => g.rawName),
        message: `Block ${blockNumber}: Multiple rows (${group.map((g) => `"${g.rawName}"`).join(', ')}) resolve to the same category "${targetName}".`,
      });
    }
  }

  // Compute absent categories from selectedSeriesId
  const resolvedIdsInBlock = new Set(
    items.map((i) => i.resolvedCategoryId).filter(Boolean)
  );
  const absentCategories = [];
  if (selectedSeriesId) {
    const linksForSeries = seriesCategories
      .filter((sc) => sc.series_id === selectedSeriesId)
      .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));
    for (const sc of linksForSeries) {
      if (!resolvedIdsInBlock.has(sc.category_id)) {
        const catObj = catById.get(sc.category_id);
        if (catObj) {
          absentCategories.push({
            id: catObj.id,
            name: catObj.name,
            active: catObj.active !== false,
            sort_order: sc.sort_order,
          });
        }
      }
    }
  }

  return {
    items,
    categories: items,
    absentCategories,
    warnings,
    errors,
    allResolved: unresolved === 0 && errors.length === 0,
    summaryCounts: {
      total: items.length,
      inSelectedSeries: inSelectedSeriesCount,
      inOtherSeriesOnly,
      mappedByAdmin,
      createHistorical,
      skippedByAdmin,
      unresolved,
    },
  };
}

/**
 * Formats an existing DB result row for side-by-side display.
 */
export function formatDbResultDisplay(dbRow) {
  if (!dbRow) return '—';
  const parts = [];
  if (
    dbRow.correct !== null &&
    dbRow.correct !== undefined &&
    dbRow.total !== null &&
    dbRow.total !== undefined
  ) {
    parts.push(`${dbRow.correct}/${dbRow.total}`);
  }
  if (dbRow.time_seconds !== null && dbRow.time_seconds !== undefined) {
    parts.push(formatSecondsDisplay(dbRow.time_seconds, false));
  }
  const noteVal = dbRow.note ?? dbRow.notes;
  if (noteVal) {
    parts.push(`"${noteVal}"`);
  }
  return parts.join(' · ') || '—';
}

/**
 * Formats a parsed CSV cell for side-by-side display.
 */
export function formatSheetCellDisplay(cell) {
  if (!cell) return '—';
  if (cell.cellSkippedByAdmin || cell.status === 'skipped') return 'Skipped';
  if (cell.status === 'empty') return '—';
  if (cell.status === 'unreadable') {
    const rawS = String(cell.rawScore || '').trim();
    const rawT = String(cell.rawTime || '').trim();
    return [rawS, rawT].filter(Boolean).join(' / ') || 'Unreadable';
  }
  const parts = [];
  if (
    cell.correct !== null &&
    cell.correct !== undefined &&
    cell.total !== null &&
    cell.total !== undefined
  ) {
    parts.push(`${cell.correct}/${cell.total}`);
  }
  if (cell.timeSeconds !== null && cell.timeSeconds !== undefined) {
    parts.push(formatSecondsDisplay(cell.timeSeconds, false));
  }
  if (cell.note) {
    parts.push(`"${cell.note}"`);
  }
  return parts.join(' · ') || '—';
}

/**
 * Compares a parsed block's rounds and cells against the selected student's existing
 * `student_rounds` and `results` for the chosen simulator `seriesId`.
 *
 * Accepts either:
 *   `compareBlockWithExistingData({ block, seriesId, categoryResolution, existingStudentRounds, existingResults, roundCategories })`
 * OR:
 *   `compareBlockWithExistingData(block, resolvedCategoriesOrCategoryResolution, options)`
 */
export function compareBlockWithExistingData(arg1 = {}, arg2 = {}, arg3 = {}) {
  let params = arg1;
  if (arg1 && Array.isArray(arg1.rounds) && !arg1.block) {
    if (Array.isArray(arg2)) {
      params = {
        ...arg3,
        block: arg1,
        categoryResolution: { items: arg2, categories: arg2 },
      };
    } else if (arg2 && Array.isArray(arg2.items) && arg3 && Object.keys(arg3).length > 0) {
      params = {
        ...arg3,
        block: arg1,
        categoryResolution: arg2,
      };
    } else {
      params = {
        ...arg2,
        block: arg1,
      };
    }
  }

  const block = params.block;
  const seriesId =
    params.seriesId !== undefined ? params.seriesId : params.selectedSeriesId || null;
  const categoryResolution = params.categoryResolution;
  const existingStudentRounds = Array.isArray(params.existingStudentRounds)
    ? params.existingStudentRounds
    : [];
  const existingResults = Array.isArray(params.existingResults)
    ? params.existingResults
    : [];
  const roundCategories = Array.isArray(params.roundCategories)
    ? params.roundCategories
    : [];

  const catItems =
    categoryResolution?.items ||
    categoryResolution?.categories ||
    (Array.isArray(categoryResolution) ? categoryResolution : []);
  const catResolutionByRow = new Map();
  for (const item of catItems) {
    catResolutionByRow.set(item.rowIndex, item);
  }
  const catById = new Map(roundCategories.map((c) => [c.id, c]));

  const dbRoundsForSeries = existingStudentRounds.filter(
    (sr) => seriesId && sr.series_id === seriesId
  );
  const dbRoundByNum = new Map();
  for (const sr of dbRoundsForSeries) {
    dbRoundByNum.set(Number(sr.round_number), sr);
  }

  const dbResultByRoundIdAndCatId = new Map();
  const dbResultByRoundNumAndCatId = new Map();
  const roundIdsInSeries = new Set(dbRoundsForSeries.map((sr) => sr.id));

  for (const res of existingResults) {
    if (!res) continue;
    const resRoundId = res.student_round_id || res.round_id || null;
    if (resRoundId && roundIdsInSeries.has(resRoundId)) {
      dbResultByRoundIdAndCatId.set(`${resRoundId}::${res.category_id}`, res);
    }
    if (
      seriesId &&
      (!resRoundId || roundIdsInSeries.has(resRoundId)) &&
      res.round_number !== null &&
      res.round_number !== undefined &&
      res.category_id
    ) {
      const sr = dbRoundByNum.get(Number(res.round_number));
      if (sr && (!resRoundId || resRoundId === sr.id)) {
        dbResultByRoundNumAndCatId.set(
          `${Number(res.round_number)}::${res.category_id}`,
          res
        );
      }
    }
  }

  let newRounds = 0;
  let existingIdentical = 0;
  let existingAddsCells = 0;
  let existingWithConflicts = 0;

  let newCells = 0;
  let identicalCells = 0;
  let conflictCells = 0;
  let protectedConflictCells = 0;
  let dbOnlyCells = 0;

  const sheetRoundNums = new Set();
  const roundsComparison = [];

  for (const rnd of block?.rounds || []) {
    const rNum = Number(rnd.roundNumber);
    if (!rnd.roundSkippedByAdmin) {
      sheetRoundNums.add(rNum);
    }
    const dbRound = dbRoundByNum.get(rNum) || null;

    if (rnd.roundSkippedByAdmin) {
      roundsComparison.push({
        roundNumber: rNum,
        roundStatus: 'skipped_by_admin',
        roundComparisonStatus: 'skipped',
        dbRound: null,
        dateDiffers: false,
        typeDiffers: false,
        timeTakenDiffers: false,
        metadataDiffs: [],
        counts: {
          newCells: 0,
          identicalCells: 0,
          conflictCells: 0,
          protectedConflictCells: 0,
          dbOnlyCells: 0,
        },
        cellCounts: {
          newCount: 0,
          identicalCount: 0,
          conflictCount: 0,
          protectedConflictCount: 0,
          dbOnlyCount: 0,
        },
        cells: [],
        dbOnlyItems: [],
        dbOnlyExtraResults: [],
      });
      continue;
    }

    const dateDiffers = Boolean(
      dbRound &&
        rnd.dateISO &&
        dbRound.round_date &&
        rnd.dateISO !== dbRound.round_date
    );
    const typeDiffers = Boolean(
      dbRound &&
        (rnd.summary?.roundType || null) !== (dbRound.round_type || null)
    );
    const sheetEffectiveTime = rnd.summary?.timeTakenOverLimit
      ? null
      : rnd.summary?.timeTakenSeconds ?? null;
    const timeTakenDiffers = Boolean(
      dbRound &&
        sheetEffectiveTime !== (dbRound.time_taken_seconds ?? null)
    );

    const metadataDiffs = [];
    if (dateDiffers) {
      metadataDiffs.push({
        field: 'round_date',
        label: 'Round Date',
        sheetValue: rnd.dateISO,
        dbValue: dbRound.round_date,
      });
    }
    if (typeDiffers) {
      metadataDiffs.push({
        field: 'round_type',
        label: 'Round Type',
        sheetValue: rnd.summary?.roundType || '—',
        dbValue: dbRound.round_type || '—',
      });
    }
    if (timeTakenDiffers) {
      metadataDiffs.push({
        field: 'time_taken_seconds',
        label: 'Time Taken',
        sheetValue:
          sheetEffectiveTime !== null
            ? formatSecondsDisplay(sheetEffectiveTime, true)
            : '—',
        dbValue:
          dbRound.time_taken_seconds !== null &&
          dbRound.time_taken_seconds !== undefined
            ? formatSecondsDisplay(dbRound.time_taken_seconds, true)
            : '—',
      });
    }

    let rNew = 0;
    let rIdentical = 0;
    let rConflict = 0;
    let rProtected = 0;
    const cellsComparison = [];

    for (const cell of rnd.cells || []) {
      const catItem = catResolutionByRow.get(cell.rowIndex) || null;
      const catId =
        catItem?.resolvedCategoryId ||
        catItem?.resolvedCategory?.id ||
        null;

      const dbRes =
        dbRound && catId
          ? dbResultByRoundIdAndCatId.get(`${dbRound.id}::${catId}`) ||
            dbResultByRoundNumAndCatId.get(`${rNum}::${catId}`) ||
            null
          : null;

      let comparisonStatus = 'empty';
      const isVerified = Boolean(dbRes && (dbRes.verified || dbRes.verified_at));
      const isCorrected = Boolean(
        dbRes && (dbRes.corrected_by || dbRes.corrected_at)
      );
      const isProtected = isVerified || isCorrected;
      const diffFields = [];

      if (cell.cellSkippedByAdmin || cell.status === 'skipped') {
        comparisonStatus = 'skipped';
      } else if (catItem?.resolutionStatus === 'skipped_by_admin') {
        comparisonStatus = 'skipped';
      } else if (catItem?.resolutionStatus === 'unresolved') {
        comparisonStatus = 'unresolved_category';
      } else if (cell.status === 'unreadable') {
        comparisonStatus = 'unreadable';
      } else if (cell.status === 'empty') {
        if (dbRes) {
          comparisonStatus = 'db_only';
        } else {
          comparisonStatus = 'empty';
        }
      } else if (cell.status === 'ok' || cell.status === 'note') {
        if (!dbRes) {
          comparisonStatus = 'new';
          rNew += 1;
          newCells += 1;
        } else {
          const sameScore =
            (cell.correct ?? null) === (dbRes.correct ?? null) &&
            (cell.total ?? null) === (dbRes.total ?? null);
          const sameTime =
            (cell.timeSeconds ?? null) === (dbRes.time_seconds ?? null);
          const dbNoteVal = dbRes.note ?? dbRes.notes ?? '';
          const sameNote =
            String(cell.note || '').trim() === String(dbNoteVal || '').trim();

          if (!sameScore) diffFields.push('score');
          if (!sameTime) diffFields.push('time');
          if (!sameNote) diffFields.push('note');

          if (sameScore && sameTime && sameNote) {
            comparisonStatus = 'identical';
            rIdentical += 1;
            identicalCells += 1;
          } else if (isProtected) {
            comparisonStatus = 'protected_conflict';
            rProtected += 1;
            protectedConflictCells += 1;
          } else {
            comparisonStatus = 'conflict';
            rConflict += 1;
            conflictCells += 1;
          }
        }
      }

      cellsComparison.push({
        rowIndex: cell.rowIndex,
        categoryName: cell.categoryName,
        resolvedCategoryId: catId,
        resolvedCategoryName:
          catItem?.resolvedCategoryName ||
          catItem?.resolvedCategory?.name ||
          cell.categoryName,
        comparisonStatus,
        diffFields,
        sheetDisplay: formatSheetCellDisplay(cell),
        dbDisplay: dbRes ? formatDbResultDisplay(dbRes) : '—',
        dbResult: dbRes,
        isVerified,
        isCorrected,
        isProtected,
      });
    }

    const dbOnlyItems = [];
    if (dbRound) {
      for (const res of existingResults) {
        const resRoundId = res.student_round_id || res.round_id || null;
        if (resRoundId === dbRound.id) {
          const wasCovered = cellsComparison.some(
            (cc) =>
              cc.resolvedCategoryId === res.category_id &&
              cc.comparisonStatus !== 'empty' &&
              cc.comparisonStatus !== 'db_only'
          );
          if (!wasCovered) {
            dbOnlyCells += 1;
            const cObj = catById.get(res.category_id);
            dbOnlyItems.push({
              categoryId: res.category_id,
              categoryName: cObj ? cObj.name : 'Category',
              dbDisplay: formatDbResultDisplay(res),
              isProtected: Boolean(
                res.verified || res.verified_at || res.corrected_by || res.corrected_at
              ),
            });
          }
        }
      }
    }

    let roundStatus = 'new_round';
    let roundComparisonStatus = 'new';
    if (!dbRound) {
      roundStatus = 'new_round';
      roundComparisonStatus = 'new';
      if (!rnd.excluded) newRounds += 1;
    } else if (
      rConflict > 0 ||
      rProtected > 0 ||
      dateDiffers ||
      typeDiffers ||
      timeTakenDiffers
    ) {
      roundStatus = 'existing_with_conflicts';
      roundComparisonStatus = 'conflict';
      existingWithConflicts += 1;
    } else if (rNew > 0) {
      roundStatus = 'existing_adds_cells';
      roundComparisonStatus = 'adds_cells';
      existingAddsCells += 1;
    } else {
      roundStatus = 'existing_identical';
      roundComparisonStatus = 'identical';
      existingIdentical += 1;
    }

    roundsComparison.push({
      roundNumber: rNum,
      roundStatus,
      roundComparisonStatus,
      dbRound,
      dateDiffers,
      typeDiffers,
      timeTakenDiffers,
      metadataDiffs,
      counts: {
        newCells: rNew,
        identicalCells: rIdentical,
        conflictCells: rConflict,
        protectedConflictCells: rProtected,
        dbOnlyCells: dbOnlyItems.length,
      },
      cellCounts: {
        newCount: rNew,
        identicalCount: rIdentical,
        conflictCount: rConflict + rProtected,
        unverifiedConflictCount: rConflict,
        protectedConflictCount: rProtected,
        dbOnlyCount: dbOnlyItems.length,
      },
      cells: cellsComparison,
      dbOnlyItems,
      dbOnlyExtraResults: dbOnlyItems,
    });
  }

  const dbOnlyRounds = dbRoundsForSeries
    .filter((sr) => !sheetRoundNums.has(Number(sr.round_number)))
    .map((sr) => {
      const resultsForRound = existingResults.filter(
        (r) => (r.student_round_id || r.round_id) === sr.id
      );
      dbOnlyCells += resultsForRound.length;
      return {
        roundNumber: Number(sr.round_number),
        roundDate: sr.round_date,
        roundType: sr.round_type,
        resultCount: resultsForRound.length,
      };
    });

  return {
    rounds: roundsComparison,
    dbOnlyRounds,
    summaryCounts: {
      rounds: {
        newRounds,
        existingIdentical,
        existingAddsCells,
        existingWithConflicts,
        dbOnlyRounds: dbOnlyRounds.length,
      },
      cells: {
        newCells,
        identicalCells,
        conflictCells,
        protectedConflictCells,
        dbOnlyCells,
      },
    },
  };
}

/* ==========================================================================
   DATABASE LIMIT VALIDATORS (`validatePayload`, `checkRoundLimits`, `checkCellLimits`)
   ========================================================================== */

/**
 * Validates a single payload cell object against the exact database rules in `admin_import_rounds`:
 * - `category_id` (or `category`): non-empty string
 * - `correct` and `total` both present integers with `0 <= correct <= total` and `total >= 1`,
 *   OR both absent (`null`) with a non-empty `note` (at most 500 characters).
 * - `time_seconds`: `null` or integer `0..14400` (4 hours).
 * - `note`: `null` or string at most 500 characters.
 */
export function checkCellLimits(cell, roundNumber) {
  const problems = [];
  const makeProblem = (field, value, message) => ({
    roundNumber,
    round_number: roundNumber,
    field,
    value,
    message,
  });

  if (!cell || typeof cell !== 'object') {
    problems.push(
      makeProblem('cell', cell, `Round ${roundNumber}: cell is not an object.`)
    );
    return problems;
  }

  const catLabel = String(
    cell.category_id || cell.category || cell.categoryName || ''
  ).trim();
  if (!catLabel) {
    problems.push(
      makeProblem(
        'category_id',
        cell.category_id ?? cell.category,
        `Round ${roundNumber}: cell category_id is missing.`
      )
    );
  }

  const hasCorrect = cell.correct !== null && cell.correct !== undefined;
  const hasTotal = cell.total !== null && cell.total !== undefined;
  const noteStr =
    cell.note === null || cell.note === undefined
      ? ''
      : String(cell.note).trim();

  if (hasCorrect || hasTotal) {
    if (!Number.isInteger(cell.total) || cell.total < 1) {
      problems.push(
        makeProblem(
          'total',
          cell.total,
          `Round ${roundNumber} (${catLabel || 'cell'}): total (${cell.total}) must be an integer >= 1.`
        )
      );
    }
    if (
      !Number.isInteger(cell.correct) ||
      cell.correct < 0 ||
      (Number.isInteger(cell.total) && cell.correct > cell.total)
    ) {
      problems.push(
        makeProblem(
          'correct',
          cell.correct,
          `Round ${roundNumber} (${catLabel || 'cell'}): correct (${cell.correct}) must be between 0 and total (${cell.total}).`
        )
      );
    }
  } else {
    if (!noteStr) {
      problems.push(
        makeProblem(
          'note',
          cell.note,
          `Round ${roundNumber} (${catLabel || 'cell'}): note-only cell must have a non-empty note.`
        )
      );
    }
  }

  if (cell.note !== null && cell.note !== undefined) {
    const rawNoteStr = String(cell.note).trim();
    if (rawNoteStr.length > DB_MAX_NOTE_LEN) {
      problems.push(
        makeProblem(
          'note',
          cell.note,
          `Round ${roundNumber} (${catLabel || 'cell'}): note length ${rawNoteStr.length} exceeds max ${DB_MAX_NOTE_LEN} characters.`
        )
      );
    }
  }

  if (cell.time_seconds !== null && cell.time_seconds !== undefined) {
    if (
      !Number.isInteger(cell.time_seconds) ||
      cell.time_seconds < 0 ||
      cell.time_seconds > DB_MAX_CELL_TIME_SECONDS
    ) {
      problems.push(
        makeProblem(
          'time_seconds',
          cell.time_seconds,
          `Round ${roundNumber} (${catLabel || 'cell'}): cell time_seconds (${cell.time_seconds}) must be between 0 and ${DB_MAX_CELL_TIME_SECONDS} (4 hours).`
        )
      );
    }
  }

  return problems;
}

/**
 * Validates a single payload round object against the exact database rules in `admin_import_rounds`:
 * - `round_number`: integer 1 to 100,000
 * - `round_date`: valid YYYY-MM-DD between `2020-01-01` and `todayIST`
 * - `round_type`: null or string at most 40 characters
 * - `time_taken_seconds`: null or integer 0 to 28,800 (8 hours)
 * - `cells`: non-empty array; each category at most once per round; each cell valid.
 */
export function checkRoundLimits(roundObj, options = {}) {
  const todayIST = options.todayIST || getDefaultTodayIST();
  const problems = [];

  const makeProblem = (rNum, field, value, message) => ({
    roundNumber: rNum,
    round_number: rNum,
    field,
    value,
    message,
  });

  if (!roundObj || typeof roundObj !== 'object') {
    problems.push(
      makeProblem('?', 'round', roundObj, 'Round entry is not an object.')
    );
    return problems;
  }

  const rNum = roundObj.round_number;

  // 1. round_number: 1 to 100000
  if (
    !Number.isInteger(rNum) ||
    rNum < DB_MIN_ROUND_NUMBER ||
    rNum > DB_MAX_ROUND_NUMBER
  ) {
    problems.push(
      makeProblem(
        rNum ?? '?',
        'round_number',
        rNum,
        `Round ${rNum ?? '?'}: round_number (${rNum}) must be an integer between ${DB_MIN_ROUND_NUMBER} and ${DB_MAX_ROUND_NUMBER}.`
      )
    );
  }

  // 2. round_date: YYYY-MM-DD between 2020-01-01 and today_ist()
  const rDate = roundObj.round_date;
  if (!isValidISODate(rDate)) {
    problems.push(
      makeProblem(
        rNum ?? '?',
        'round_date',
        rDate,
        `Round ${rNum ?? '?'}: round_date (${rDate}) must be a valid YYYY-MM-DD calendar date.`
      )
    );
  } else if (rDate < DB_MIN_ROUND_DATE_ISO || rDate > todayIST) {
    problems.push(
      makeProblem(
        rNum ?? '?',
        'round_date',
        rDate,
        `Round ${rNum ?? '?'}: round_date (${rDate}) must be between ${DB_MIN_ROUND_DATE_ISO} and ${todayIST}.`
      )
    );
  }

  // 3. round_type: at most 40 characters
  const rType = roundObj.round_type;
  if (rType !== null && rType !== undefined) {
    const trimmedType = String(rType).trim();
    if (trimmedType.length > DB_MAX_ROUND_TYPE_LEN) {
      problems.push(
        makeProblem(
          rNum ?? '?',
          'round_type',
          trimmedType,
          `Round ${rNum ?? '?'}: round_type ("${trimmedType.slice(0, 20)}…", ${trimmedType.length} chars) exceeds maximum of ${DB_MAX_ROUND_TYPE_LEN} characters.`
        )
      );
    }
  }

  // 4. time_taken_seconds: null or 0 to 28800
  const rTime = roundObj.time_taken_seconds;
  if (rTime !== null && rTime !== undefined) {
    if (
      !Number.isInteger(rTime) ||
      rTime < 0 ||
      rTime > DB_MAX_ROUND_TIME_TAKEN_SECONDS
    ) {
      problems.push(
        makeProblem(
          rNum ?? '?',
          'time_taken_seconds',
          rTime,
          `Round ${rNum ?? '?'}: time_taken_seconds (${rTime}) must be null or between 0 and ${DB_MAX_ROUND_TIME_TAKEN_SECONDS} seconds (8 hours).`
        )
      );
    }
  }

  // 5. cells: non-empty array, each category at most once per round
  const cells = roundObj.cells;
  if (!Array.isArray(cells) || cells.length === 0) {
    problems.push(
      makeProblem(
        rNum ?? '?',
        'cells',
        Array.isArray(cells) ? cells.length : cells,
        `Round ${rNum ?? '?'}: cells must be a non-empty array.`
      )
    );
  } else {
    const seenCategories = new Set();
    for (const cell of cells) {
      const catKey = String(
        cell?.category_id || cell?.category || ''
      ).trim();
      if (catKey) {
        if (seenCategories.has(catKey)) {
          problems.push(
            makeProblem(
              rNum ?? '?',
              'category_id',
              catKey,
              `Round ${rNum ?? '?'}: duplicate category "${catKey}" in the same round.`
            )
          );
        }
        seenCategories.add(catKey);
      }
      const cellProblems = checkCellLimits(cell, rNum ?? '?');
      problems.push(...cellProblems);
    }
  }

  return problems;
}

/**
 * Validates an `admin_import_rounds` call payload (or an array of rounds / call payloads)
 * against all database limits BEFORE sending anything over the network.
 *
 * Returns a list of problems where each problem names:
 * - `round_number` / `roundNumber`
 * - `field`
 * - `value`
 * - `message`
 *
 * @param {Object|Array<Object>} payload
 * @param {Object} [options]
 * @param {string} [options.todayIST]
 * @returns {Array<Object>}
 */
export function validatePayload(payload, options = {}) {
  const todayIST = options.todayIST || getDefaultTodayIST();
  const problems = [];

  const makeBatchProblem = (field, value, message) => ({
    roundNumber: null,
    round_number: null,
    field,
    value,
    message,
  });

  if (!payload) {
    problems.push(
      makeBatchProblem('rounds', payload, 'Payload is empty or missing.')
    );
    return problems;
  }

  let rounds = null;
  if (Array.isArray(payload)) {
    if (
      payload.length > 0 &&
      (payload[0]?.p_rounds !== undefined || payload[0]?.rounds !== undefined)
    ) {
      for (const step of payload) {
        problems.push(...validatePayload(step, { todayIST }));
      }
      return problems;
    }
    rounds = payload;
  } else if (Array.isArray(payload.p_rounds)) {
    rounds = payload.p_rounds;
  } else if (Array.isArray(payload.rounds)) {
    rounds = payload.rounds;
  }

  if (!rounds || rounds.length === 0) {
    problems.push(
      makeBatchProblem(
        'rounds',
        rounds ? rounds.length : rounds,
        'Payload rounds must be a non-empty array of rounds.'
      )
    );
    return problems;
  }

  if (rounds.length > MAX_ROUNDS_PER_RPC_CALL) {
    problems.push(
      makeBatchProblem(
        'rounds_count',
        rounds.length,
        `Batch has ${rounds.length} rounds, exceeding the database limit of ${MAX_ROUNDS_PER_RPC_CALL} rounds per call.`
      )
    );
  }

  let totalCells = 0;
  for (const r of rounds) {
    if (r && Array.isArray(r.cells)) {
      totalCells += r.cells.length;
    }
    const rProblems = checkRoundLimits(r, { todayIST });
    problems.push(...rProblems);
  }

  if (totalCells > MAX_CELLS_PER_RPC_CALL) {
    problems.push(
      makeBatchProblem(
        'cells_count',
        totalCells,
        `Batch has ${totalCells} cells across ${rounds.length} rounds, exceeding the database limit of ${MAX_CELLS_PER_RPC_CALL} cells per call.`
      )
    );
  }

  return problems;
}

/**
 * Splits a list of materialized rounds for a series into one or more chunks
 * so that every chunk has at most `MAX_ROUNDS_PER_RPC_CALL` (100) rounds and
 * at most `MAX_CELLS_PER_RPC_CALL` (3,000) cells.
 */
export function chunkRoundsForImport(rounds, limits = {}) {
  const maxRounds =
    limits.maxRoundsPerCall || limits.maxRounds || MAX_ROUNDS_PER_RPC_CALL;
  const maxCells =
    limits.maxCellsPerCall || limits.maxCells || MAX_CELLS_PER_RPC_CALL;
  if (!Array.isArray(rounds) || rounds.length === 0) return [];

  const chunks = [];
  let currentChunk = [];
  let currentCells = 0;

  for (const r of rounds) {
    const rCells = Array.isArray(r.cells) ? r.cells.length : 0;
    if (
      currentChunk.length > 0 &&
      (currentChunk.length + 1 > maxRounds ||
        currentCells + rCells > maxCells)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCells = 0;
    }
    currentChunk.push(r);
    currentCells += rCells;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/* ==========================================================================
   PREVIEW STATE & EXECUTION PLAN BUILDERS
   ========================================================================== */

/**
 * Builds the complete preview state for a parsed score sheet CSV.
 *
 * Accepts either:
 *   `buildImportPreviewState(parsed, options)`
 * OR:
 *   `buildImportPreviewState({ parsed, selectedStudent, ... })`
 */
export function buildImportPreviewState(arg1 = {}, arg2 = {}) {
  let params = arg1;
  if (arg1 && Array.isArray(arg1.blocks) && !arg1.parsed) {
    params = {
      ...arg2,
      parsed: arg1,
    };
  }

  const rawParsed = params.parsed;
  const selectedStudent = params.selectedStudent || null;
  const roundSeries = Array.isArray(params.roundSeries)
    ? params.roundSeries
    : [
        { id: 'ser-old', name: 'Old simulator', is_current: false, sort_order: 1 },
        { id: 'ser-new', name: 'New simulator', is_current: true, sort_order: 2 },
      ];
  const roundCategories = Array.isArray(params.roundCategories)
    ? params.roundCategories
    : Array.isArray(params.dbCategories)
      ? params.dbCategories
      : [];
  const seriesCategories = Array.isArray(params.seriesCategories)
    ? params.seriesCategories
    : Array.isArray(params.categorySeries)
      ? params.categorySeries
      : [];
  const dbAliases = Array.isArray(params.dbAliases)
    ? params.dbAliases
    : Array.isArray(params.categoryAliases)
      ? params.categoryAliases
      : [];
  const existingStudentRounds = Array.isArray(params.existingStudentRounds)
    ? params.existingStudentRounds
    : Array.isArray(params.existingRounds)
      ? params.existingRounds
      : [];
  const existingResults = Array.isArray(params.existingResults)
    ? params.existingResults
    : [];
  const blockUiState = params.blockUiState || {};
  const editState = params.editState || createEmptyEditState();
  const todayIST =
    params.todayIST ||
    (rawParsed && rawParsed.todayIST) ||
    getDefaultTodayIST();

  if (!rawParsed || !rawParsed.ok || !Array.isArray(rawParsed.blocks)) {
    return {
      ok: false,
      allBlocksReady: false,
      canImport: false,
      blockingErrors: [rawParsed?.error || 'Invalid parsed score sheet.'],
      combinedAttention: rawParsed?.needsAttention || [],
      blockReports: [],
      totals: {
        rounds: {
          newRounds: 0,
          existingIdentical: 0,
          existingAddsCells: 0,
          existingWithConflicts: 0,
          dbOnlyRounds: 0,
        },
        cells: {
          newCells: 0,
          identicalCells: 0,
          conflictCells: 0,
          protectedConflictCells: 0,
          dbOnlyCells: 0,
        },
      },
      editsList: [],
      edits: [],
      editState,
      originalParsed: rawParsed,
      effectiveParsed: rawParsed,
    };
  }

  // Build map of blockNumber -> seriesName for audit log
  const seriesById = new Map(roundSeries.map((s) => [s.id, s]));
  const blockSeriesMap = {};
  for (const blk of rawParsed.blocks) {
    const bState = blockUiState[blk.blockNumber] || {};
    const sug = suggestSeriesForBlock(blk, roundSeries);
    const sId = bState.seriesId || sug.suggestedSeriesId;
    const sObj = sId ? seriesById.get(sId) : null;
    blockSeriesMap[blk.blockNumber] =
      sObj?.name || sug.suggestedSeriesName || `Block ${blk.blockNumber}`;
  }

  // Apply Phase 4c-2d preview edits first so all downstream checks use the edited values
  const parsed = applyPreviewEdits(rawParsed, editState, {
    todayIST,
    blockSeriesMap,
  });

  // Student name check against selected student
  const studentNameInFile = parsed.primaryStudentName || null;
  const studentNameCellRef =
    parsed.studentNames && parsed.studentNames.length > 0
      ? parsed.studentNames[0].ref
      : null;
  let studentNameMatchesSelected = null;
  if (studentNameInFile && selectedStudent && selectedStudent.full_name) {
    const fileNorm = toMatchingKey(studentNameInFile);
    const selNorm = toMatchingKey(selectedStudent.full_name);
    studentNameMatchesSelected =
      fileNorm === selNorm ||
      fileNorm.includes(selNorm) ||
      selNorm.includes(fileNorm);
  }
  parsed.studentNameInFile = studentNameInFile;
  parsed.studentNameCellRef = studentNameCellRef;
  parsed.studentNameMatchesSelected = studentNameMatchesSelected;

  const seriesSelections = [];
  const blockReports = [];

  const totalRoundsAgg = {
    newRounds: 0,
    existingIdentical: 0,
    existingAddsCells: 0,
    existingWithConflicts: 0,
    dbOnlyRounds: 0,
  };
  const totalCellsAgg = {
    newCells: 0,
    identicalCells: 0,
    conflictCells: 0,
    protectedConflictCells: 0,
    dbOnlyCells: 0,
  };

  for (const blk of parsed.blocks) {
    const bNum = blk.blockNumber;
    const seriesSuggestion = suggestSeriesForBlock(blk, roundSeries);
    const ui = blockUiState[bNum] || {
      seriesId: seriesSuggestion.suggestedSeriesId || '',
      confirmed: false,
      adminMappings: {},
    };
    const chosenSeriesId =
      ui.seriesId !== undefined
        ? ui.seriesId
        : seriesSuggestion.suggestedSeriesId;
    const chosenSeries = chosenSeriesId
      ? seriesById.get(chosenSeriesId) || null
      : null;
    const seriesConfirmed = Boolean(ui.confirmed && chosenSeriesId);

    seriesSelections.push({
      blockNumber: bNum,
      seriesId: chosenSeriesId || null,
      confirmed: seriesConfirmed,
    });

    const categoryResolution = resolveBlockCategories({
      block: blk,
      selectedSeriesId: chosenSeriesId || null,
      roundCategories,
      seriesCategories,
      roundSeries,
      dbAliases,
      adminMappings: ui.adminMappings || {},
    });

    const dataComparison = compareBlockWithExistingData({
      block: blk,
      seriesId: chosenSeriesId || null,
      categoryResolution,
      existingStudentRounds,
      existingResults,
      roundCategories,
    });

    const rc = dataComparison.summaryCounts.rounds;
    const cc = dataComparison.summaryCounts.cells;
    totalRoundsAgg.newRounds += rc.newRounds;
    totalRoundsAgg.existingIdentical += rc.existingIdentical;
    totalRoundsAgg.existingAddsCells += rc.existingAddsCells;
    totalRoundsAgg.existingWithConflicts += rc.existingWithConflicts;
    totalRoundsAgg.dbOnlyRounds += rc.dbOnlyRounds;

    totalCellsAgg.newCells += cc.newCells;
    totalCellsAgg.identicalCells += cc.identicalCells;
    totalCellsAgg.conflictCells += cc.conflictCells;
    totalCellsAgg.protectedConflictCells += cc.protectedConflictCells;
    totalCellsAgg.dbOnlyCells += cc.dbOnlyCells;

    blockReports.push({
      blockNumber: bNum,
      seriesId: chosenSeriesId || null,
      seriesName: chosenSeries ? chosenSeries.name : null,
      seriesConfirmed,
      seriesSuggestion,
      categoryResolution,
      dataComparison,
      blockReady:
        seriesConfirmed &&
        Boolean(chosenSeriesId) &&
        categoryResolution.summaryCounts.unresolved === 0,
    });
  }

  const seriesValidation = validateBlockSeriesSelections(
    seriesSelections,
    roundSeries
  );

  // Build combined attention list
  const combinedAttention = [];

  if (
    studentNameInFile &&
    selectedStudent &&
    studentNameMatchesSelected === false
  ) {
    combinedAttention.push({
      severity: 'warning',
      type: 'student_name_differs',
      blockNumber: null,
      roundNumber: null,
      ref: studentNameCellRef,
      message: `Student name in file ("${studentNameInFile}" at ${studentNameCellRef || 'top row'}) differs from selected student "${selectedStudent.full_name} (${selectedStudent.student_code})".`,
    });
  }

  if (seriesValidation.duplicateSeriesError) {
    combinedAttention.push({
      severity: 'error',
      type: 'duplicate_series_selection',
      blockNumber: null,
      roundNumber: null,
      ref: null,
      message: seriesValidation.duplicateSeriesError,
    });
  }

  for (const br of blockReports) {
    if (!br.seriesConfirmed || !br.seriesId) {
      combinedAttention.push({
        severity: 'error',
        type: 'series_unconfirmed',
        blockNumber: br.blockNumber,
        roundNumber: null,
        ref: null,
        message: `Block ${br.blockNumber}: Please confirm the Simulator Series (${br.seriesName || 'unselected'}) in Step 2.${br.blockNumber}a before importing.`,
      });
    }

    for (const catItem of br.categoryResolution.items) {
      if (catItem.resolutionStatus === 'unresolved') {
        combinedAttention.push({
          severity: 'error',
          type: 'unresolved_category',
          blockNumber: br.blockNumber,
          roundNumber: null,
          ref: catItem.nameRef,
          message: `Block ${br.blockNumber}: Category "${catItem.rawName}" at ${catItem.nameRef || 'row'} is unresolved. Map to an existing category, create as historical, or skip.`,
        });
      } else if (catItem.resolutionStatus === 'in_other_series_only') {
        combinedAttention.push({
          severity: 'warning',
          type: 'category_in_other_series',
          blockNumber: br.blockNumber,
          roundNumber: null,
          ref: catItem.nameRef,
          message: `Block ${br.blockNumber}: Category "${catItem.rawName}" (${catItem.resolvedCategoryName}) belongs to another series (${catItem.seriesNames.join(', ') || 'unlinked'}) and will be linked to ${br.seriesName || 'this series'}.`,
        });
      }
    }

    for (const rc of br.dataComparison.rounds) {
      if (rc.dateDiffers && rc.dbRound) {
        combinedAttention.push({
          severity: 'warning',
          type: 'db_round_date_differs',
          blockNumber: br.blockNumber,
          roundNumber: rc.roundNumber,
          ref: null,
          message: `Block ${br.blockNumber} · Round ${rc.roundNumber}: Sheet date differs from existing database round date (${rc.dbRound.round_date}). Choose date conflict handling in Step 3.`,
        });
      }
      if (rc.cellCounts.conflictCount > 0) {
        combinedAttention.push({
          severity: 'warning',
          type: 'db_cell_conflicts',
          blockNumber: br.blockNumber,
          roundNumber: rc.roundNumber,
          ref: null,
          message: `Block ${br.blockNumber} · Round ${rc.roundNumber}: ${rc.cellCounts.conflictCount} score cell(s) differ from existing DB values (existing DB values are never overwritten).`,
        });
      }
    }
  }

  for (const item of parsed.needsAttention || []) {
    if (item.type === 'unmatched_category') continue;
    combinedAttention.push(item);
  }

  const blockingErrors = combinedAttention
    .filter((i) => i.severity === 'error' && !i.excluded)
    .map((i) => i.message);

  const allBlocksReady =
    seriesValidation.allConfirmed &&
    blockReports.every((br) => br.blockReady) &&
    blockingErrors.length === 0;

  return {
    ok: true,
    todayIST,
    allBlocksReady,
    canImport: allBlocksReady,
    seriesValidation,
    blockingErrors,
    combinedAttention,
    blockReports,
    totals: {
      rounds: totalRoundsAgg,
      cells: totalCellsAgg,
    },
    overallComparison: {
      rounds: totalRoundsAgg,
      cells: totalCellsAgg,
    },
    editsList: parsed.editsList || [],
    edits: parsed.editsList || [],
    editState,
    originalParsed: rawParsed,
    effectiveParsed: parsed,
    summary: parsed.summary,
    attention: combinedAttention,
  };
}

/**
 * Materializes the exact `p_rounds` JSON array for a single block (or `blockPlan`) and splits it
 * into chunks that respect `MAX_ROUNDS_PER_RPC_CALL` (100) and `MAX_CELLS_PER_RPC_CALL` (3,000).
 *
 * Supports two calling modes:
 * 1. `materializeBlockRoundChunks(blockPlan, ensuredCategoryByRowIndexMap, limits)`
 *    where `blockPlan.rounds` already contains planned rounds with `{ rowIndex, rawKey, category_id, ... }` cells;
 *    replaces `category_id` using `ensuredCategoryByRowIndexMap.get(cell.rowIndex)` when present and strips
 *    internal keys (`rowIndex`, `rawKey`, `categoryName`) so only clean RPC fields remain.
 * 2. `materializeBlockRoundChunks(rawBlock, categoryResolution, limits)`
 *    where `rawBlock` is a parsed block and `categoryResolution` is the output of `resolveBlockCategories`.
 */
export function materializeBlockRoundChunks(
  blockOrBlockPlan,
  arg2 = new Map(),
  limits = {}
) {
  if (!blockOrBlockPlan || !Array.isArray(blockOrBlockPlan.rounds)) {
    return [];
  }

  const isEnsuredMap = arg2 instanceof Map;
  const isCategoryResolution =
    !isEnsuredMap && arg2 && Array.isArray(arg2.items);

  // Mode 1: `blockOrBlockPlan` has already-planned rounds (`round_number`, `round_date`, `cells`)
  const firstRound = blockOrBlockPlan.rounds[0];
  const isAlreadyPlannedRounds =
    firstRound &&
    firstRound.round_number !== undefined &&
    !isCategoryResolution;

  if (isAlreadyPlannedRounds) {
    const ensuredMap = isEnsuredMap ? arg2 : new Map();
    const cleanedRounds = [];

    for (const rnd of blockOrBlockPlan.rounds) {
      const cleanedCells = [];
      const seenCatIds = new Set();

      for (const c of rnd.cells || []) {
        const resolvedCatId =
          (c.rowIndex !== undefined && ensuredMap.has(c.rowIndex)
            ? ensuredMap.get(c.rowIndex)
            : null) ||
          c.category_id ||
          c.category;
        if (!resolvedCatId) continue;
        if (seenCatIds.has(resolvedCatId)) continue;
        seenCatIds.add(resolvedCatId);

        cleanedCells.push({
          category_id: resolvedCatId,
          correct: c.correct ?? null,
          total: c.total ?? null,
          time_seconds: c.time_seconds ?? null,
          note: c.note ?? null,
        });
      }

      if (cleanedCells.length === 0) continue;

      cleanedRounds.push({
        round_number: rnd.round_number,
        round_date: rnd.round_date,
        round_type: rnd.round_type ?? null,
        time_taken_seconds: rnd.time_taken_seconds ?? null,
        cells: cleanedCells,
      });
    }

    return chunkRoundsForImport(cleanedRounds, limits);
  }

  // Mode 2: Raw parsed block + categoryResolution
  const catByRow = new Map();
  for (const item of arg2?.items || []) {
    catByRow.set(item.rowIndex, item);
  }

  const plannedRounds = buildPlannedRoundsForBlock(blockOrBlockPlan, catByRow);
  return materializeBlockRoundChunks(
    { blockNumber: blockOrBlockPlan.blockNumber, rounds: plannedRounds },
    new Map(),
    limits
  );
}

/**
 * Helper that builds planned rounds (`round_number`, `round_date`, `round_type`, `time_taken_seconds`, `cells`)
 * from an evaluated block and category resolution map.
 */
function buildPlannedRoundsForBlock(blk, catByRow) {
  const plannedRounds = [];

  for (const rnd of blk?.rounds || []) {
    if (rnd.roundSkippedByAdmin || rnd.adminSkipped) continue;
    if (rnd.excluded) continue;
    if (rnd.dateStatus !== 'ok' || !rnd.dateISO) continue;

    const cellsPayload = [];
    const seenCatKeys = new Set();

    for (const cell of rnd.cells || []) {
      if (
        cell.cellSkippedByAdmin ||
        cell.adminSkipped ||
        cell.status === 'skipped'
      ) {
        continue;
      }
      if (cell.status !== 'ok' && cell.status !== 'note') continue;

      const catItem = catByRow.get(cell.rowIndex);
      if (!catItem || catItem.resolutionStatus === 'skipped_by_admin') continue;

      const categoryKey =
        catItem.resolvedCategoryId ||
        (catItem.resolutionStatus === 'create_historical'
          ? `pending_${catItem.rowIndex}`
          : null);
      if (!categoryKey) continue;
      if (seenCatKeys.has(categoryKey)) continue;
      seenCatKeys.add(categoryKey);

      const safeNote =
        cell.note !== null && cell.note !== undefined
          ? String(cell.note).trim().slice(0, DB_MAX_NOTE_LEN) || null
          : null;

      if (cell.status === 'ok') {
        const safeTime =
          Number.isInteger(cell.timeSeconds) &&
          cell.timeSeconds >= 0 &&
          cell.timeSeconds <= DB_MAX_CELL_TIME_SECONDS
            ? cell.timeSeconds
            : null;
        cellsPayload.push({
          rowIndex: catItem.rowIndex,
          rawKey: catItem.rawKey,
          category_id: categoryKey,
          correct: cell.correct,
          total: cell.total,
          time_seconds: safeTime,
          note: safeNote,
        });
      } else if (cell.status === 'note' && safeNote) {
        cellsPayload.push({
          rowIndex: catItem.rowIndex,
          rawKey: catItem.rawKey,
          category_id: categoryKey,
          correct: null,
          total: null,
          time_seconds: null,
          note: safeNote,
        });
      }
    }

    if (cellsPayload.length === 0) continue;

    const safeRoundTime =
      !rnd.summary?.timeTakenOverLimit &&
      Number.isInteger(rnd.summary?.timeTakenSeconds) &&
      rnd.summary.timeTakenSeconds >= 0 &&
      rnd.summary.timeTakenSeconds <= DB_MAX_ROUND_TIME_TAKEN_SECONDS
        ? rnd.summary.timeTakenSeconds
        : null;

    const rawRoundType = rnd.summary?.roundType;
    const safeRoundType =
      rawRoundType !== null &&
      rawRoundType !== undefined &&
      String(rawRoundType).trim() !== ''
        ? String(rawRoundType).trim().slice(0, DB_MAX_ROUND_TYPE_LEN)
        : null;

    plannedRounds.push({
      round_number: rnd.roundNumber,
      round_date: rnd.dateISO,
      round_type: safeRoundType,
      time_taken_seconds: safeRoundTime,
      cells: cellsPayload,
    });
  }

  return plannedRounds;
}

/**
 * Builds the deterministic RPC execution plan for `js/import.js` and `tests/importPlan.test.js`.
 *
 * Accepts either:
 *   `buildImportExecutionPlan(parsed, previewState, options)`
 * OR:
 *   `buildImportExecutionPlan({ parsed, previewState, selectedStudent, fileName, markVerified, onDateConflict })`
 */
export function buildImportExecutionPlan(arg1 = {}, arg2 = {}, arg3 = {}) {
  let parsed = null;
  let previewState = null;
  let opts = {};

  if (arg1 && Array.isArray(arg1.blocks) && !arg1.parsed) {
    // Called as (parsed, previewState, options)
    parsed = arg1;
    previewState = arg2;
    opts = arg3 || {};
  } else {
    // Called as ({ parsed, previewState, ... })
    parsed = arg1.parsed;
    previewState = arg1.previewState;
    opts = arg1;
  }

  const effectiveParsed = previewState?.effectiveParsed || parsed;
  const selectedStudent = opts.selectedStudent || null;
  const fileName = String(opts.fileName || 'sheet.csv').trim() || 'sheet.csv';
  const markVerified = Boolean(opts.markVerified);
  const onDateConflict =
    opts.onDateConflict === 'use_existing' ? 'use_existing' : 'skip';
  const todayIST =
    opts.todayIST ||
    previewState?.todayIST ||
    effectiveParsed?.todayIST ||
    getDefaultTodayIST();

  const blockingReasons = [];
  if (!selectedStudent || !selectedStudent.id) {
    blockingReasons.push('Select a student in Step 1 before importing.');
  }
  if (!effectiveParsed || !effectiveParsed.ok) {
    blockingReasons.push(
      effectiveParsed?.error || 'CSV file could not be parsed.'
    );
  }
  if (previewState && !previewState.allBlocksReady) {
    for (const br of previewState.blockReports || []) {
      if (!br.seriesConfirmed || !br.seriesId) {
        blockingReasons.push(
          `Block ${br.blockNumber}: Confirm the simulator series in Step 2.${br.blockNumber}a.`
        );
      }
      if (br.categoryResolution.summaryCounts.unresolved > 0) {
        blockingReasons.push(
          `Block ${br.blockNumber}: Resolve all ${br.categoryResolution.summaryCounts.unresolved} unknown category row(s) in Step 2.${br.blockNumber}b.`
        );
      }
    }
    if (previewState.seriesValidation?.duplicateSeriesError) {
      blockingReasons.push(previewState.seriesValidation.duplicateSeriesError);
    }
  }

  const excludedRounds = [];
  const skippedRounds = [];
  const blockPlans = [];
  const ensureCategorySteps = [];
  const aliasSteps = [];
  const roundImportSteps = [];
  let totalRounds = 0;
  let rowsFound = 0;

  if (effectiveParsed && Array.isArray(effectiveParsed.blocks) && previewState) {
    for (const blk of effectiveParsed.blocks) {
      const bNum = blk.blockNumber;
      const br = (previewState.blockReports || []).find(
        (r) => r.blockNumber === bNum
      );
      if (!br) continue;

      const catByRow = new Map();
      const categoriesToEnsure = [];
      const aliasesToSave = [];

      for (const catItem of br.categoryResolution.items) {
        catByRow.set(catItem.rowIndex, catItem);

        if (
          catItem.resolutionStatus === 'in_other_series_only' &&
          catItem.resolvedCategoryId
        ) {
          const op = {
            rowIndex: catItem.rowIndex,
            rawKey: catItem.rawKey,
            sheetName: catItem.rawName,
            mode: 'link_existing',
            action: 'link_existing',
            p_category: catItem.resolvedCategoryId,
            p_new_name: null,
            categoryId: catItem.resolvedCategoryId,
            newName: null,
            displayName: catItem.resolvedCategoryName,
          };
          categoriesToEnsure.push(op);
          ensureCategorySteps.push({
            blockNumber: bNum,
            seriesId: br.seriesId,
            seriesName: br.seriesName,
            ...op,
          });
        } else if (
          catItem.resolutionStatus === 'mapped_by_admin' &&
          catItem.resolvedCategoryId
        ) {
          const isAlreadyInSelectedSeries = (catItem.seriesIds || []).includes(
            br.seriesId
          );
          if (!isAlreadyInSelectedSeries) {
            const op = {
              rowIndex: catItem.rowIndex,
              rawKey: catItem.rawKey,
              sheetName: catItem.rawName,
              mode: 'link_existing',
              action: 'link_existing',
              p_category: catItem.resolvedCategoryId,
              p_new_name: null,
              categoryId: catItem.resolvedCategoryId,
              newName: null,
              displayName: catItem.resolvedCategoryName,
            };
            categoriesToEnsure.push(op);
            ensureCategorySteps.push({
              blockNumber: bNum,
              seriesId: br.seriesId,
              seriesName: br.seriesName,
              ...op,
            });
          }
          if (catItem.saveAliasRequested) {
            const alOp = {
              rowIndex: catItem.rowIndex,
              alias: catItem.rawKey,
              category_id: catItem.resolvedCategoryId,
              categoryId: catItem.resolvedCategoryId,
              targetCategoryName: catItem.resolvedCategoryName,
            };
            aliasesToSave.push(alOp);
            aliasSteps.push(alOp);
          }
        } else if (catItem.resolutionStatus === 'create_historical') {
          const op = {
            rowIndex: catItem.rowIndex,
            rawKey: catItem.rawKey,
            sheetName: catItem.rawName,
            mode: 'create_historical',
            action: 'create_historical',
            p_category: null,
            p_new_name: catItem.rawName,
            categoryId: null,
            newName: catItem.rawName,
            displayName: catItem.rawName,
          };
          categoriesToEnsure.push(op);
          ensureCategorySteps.push({
            blockNumber: bNum,
            seriesId: br.seriesId,
            seriesName: br.seriesName,
            ...op,
          });
        }
      }

      // Check rounds for exclusions and skips
      for (const rnd of blk.rounds || []) {
        if (rnd.roundSkippedByAdmin) {
          skippedRounds.push({
            blockNumber: bNum,
            seriesName: br.seriesName,
            roundNumber: rnd.roundNumber,
            reason: 'Skipped by admin in preview',
          });
          continue;
        }

        if (rnd.excluded) {
          excludedRounds.push({
            blockNumber: bNum,
            seriesName: br.seriesName,
            roundNumber: rnd.roundNumber,
            reason: rnd.exclusionReason || 'Excluded due to validation limit',
          });
          continue;
        }

        let importableCellsInRound = 0;
        const seenTargetKeysInRound = new Set();
        let duplicateCatName = null;

        for (const cell of rnd.cells || []) {
          if (cell.cellSkippedByAdmin || cell.status === 'skipped') continue;
          if (cell.status !== 'ok' && cell.status !== 'note') continue;
          const catItem = catByRow.get(cell.rowIndex);
          if (!catItem || catItem.resolutionStatus === 'skipped_by_admin') continue;
          const tKey =
            catItem.resolvedCategoryId ||
            (catItem.resolutionStatus === 'create_historical'
              ? `pending_${catItem.rowIndex}`
              : null);
          if (!tKey) continue;
          if (seenTargetKeysInRound.has(tKey)) {
            duplicateCatName = catItem.resolvedCategoryName || catItem.rawName;
          }
          seenTargetKeysInRound.add(tKey);
          importableCellsInRound += 1;
        }

        if (duplicateCatName) {
          rnd.excluded = true;
          rnd.exclusionReason = `Duplicate category "${duplicateCatName}" in the same round`;
          excludedRounds.push({
            blockNumber: bNum,
            seriesName: br.seriesName,
            roundNumber: rnd.roundNumber,
            reason: rnd.exclusionReason,
          });
          continue;
        }

        if (importableCellsInRound === 0) {
          rnd.excluded = true;
          rnd.exclusionReason = 'No valid importable cells in this round';
          excludedRounds.push({
            blockNumber: bNum,
            seriesName: br.seriesName,
            roundNumber: rnd.roundNumber,
            reason: rnd.exclusionReason,
          });
          continue;
        }
      }

      const plannedRounds = buildPlannedRoundsForBlock(blk, catByRow);
      const bp = {
        blockNumber: bNum,
        seriesId: br.seriesId,
        seriesName: br.seriesName,
        categoriesToEnsure,
        aliasesToSave,
        rounds: plannedRounds,
        roundChunks: [],
      };
      bp.roundChunks = materializeBlockRoundChunks(bp, new Map());

      totalRounds += plannedRounds.length;
      for (const r of plannedRounds) {
        rowsFound += Array.isArray(r.cells) ? r.cells.length : 0;
      }

      bp.roundChunks.forEach((chunkRounds, idx) => {
        if (chunkRounds.length > 0) {
          const cellCount = chunkRounds.reduce(
            (sum, r) => sum + (Array.isArray(r.cells) ? r.cells.length : 0),
            0
          );
          roundImportSteps.push({
            blockNumber: bNum,
            seriesId: br.seriesId,
            seriesName: br.seriesName,
            chunkIndex: idx + 1,
            totalChunksForBlock: bp.roundChunks.length,
            roundCount: chunkRounds.length,
            cellCount,
            rounds: chunkRounds,
            p_series: br.seriesId,
            p_rounds: chunkRounds,
            onDateConflict,
          });
        }
      });

      blockPlans.push(bp);
    }
  }

  // Count acknowledgment categories
  const acknowledgmentCounts = {
    timeTakenOverLimit: 0,
    roundTypeTruncated: 0,
    noteTruncated: 0,
    unreadableCells: 0,
    unreadableCellsSkipped: 0,
    crossCheckMismatches: 0,
    strayValues: 0,
    outOfOrderDates: 0,
    excludedRounds: excludedRounds.length,
  };

  const warningTypes = new Map();
  const addAckCategory = (key, label, detail) => {
    if (!warningTypes.has(key)) {
      warningTypes.set(key, {
        key,
        type: key,
        label,
        count: 0,
        items: [],
        details: [],
      });
    }
    const entry = warningTypes.get(key);
    entry.count += 1;
    if (detail && entry.items.length < 25) {
      entry.items.push(detail);
      entry.details.push(detail);
    }
  };

  for (const item of previewState?.combinedAttention || []) {
    if (
      item.type === 'time_taken_over_limit' ||
      item.type === 'time_taken_exceeds_limit'
    ) {
      acknowledgmentCounts.timeTakenOverLimit += 1;
      addAckCategory(
        'time_taken_over_limit',
        'Round total time > 8 hours (imported WITHOUT total time)',
        item.message
      );
    } else if (item.type === 'round_type_truncated') {
      acknowledgmentCounts.roundTypeTruncated += 1;
      addAckCategory(
        'round_type_truncated',
        'Round type > 40 characters (cut to 40 chars)',
        item.message
      );
    } else if (item.type === 'note_truncated') {
      acknowledgmentCounts.noteTruncated += 1;
      addAckCategory(
        'note_truncated',
        'Cell note > 500 characters (cut to 500 chars)',
        item.message
      );
    } else if (
      item.type === 'unreadable_score' ||
      item.type === 'unreadable_time' ||
      item.type === 'time_without_score' ||
      item.type === 'unreadable_cell'
    ) {
      acknowledgmentCounts.unreadableCells += 1;
      acknowledgmentCounts.unreadableCellsSkipped += 1;
      addAckCategory(
        'unreadable_cells_skipped',
        'Unreadable cells (skipped during import)',
        item.message
      );
    } else if (item.type === 'crosscheck_mismatch') {
      acknowledgmentCounts.crossCheckMismatches += 1;
      addAckCategory(
        'crosscheck_mismatch',
        'Summary cross-check mismatches',
        item.message
      );
    } else if (item.type === 'stray_value') {
      acknowledgmentCounts.strayValues += 1;
      addAckCategory(
        'stray_values',
        'Stray values outside category rows',
        item.message
      );
    } else if (item.type === 'out_of_order_date') {
      acknowledgmentCounts.outOfOrderDates += 1;
      addAckCategory(
        'out_of_order_dates',
        'Out-of-order round dates',
        item.message
      );
    } else if (item.type === 'student_name_differs') {
      addAckCategory(
        'student_name_differs',
        'Student name in file differs',
        item.message
      );
    } else if (
      item.type === 'db_round_date_differs' ||
      item.type === 'db_cell_conflicts'
    ) {
      addAckCategory(
        'db_conflicts',
        'Differences vs existing database rows (existing data kept)',
        item.message
      );
    }
  }

  for (const ex of excludedRounds) {
    addAckCategory(
      'excluded_rounds',
      'Excluded rounds (not imported due to date/limit issues)',
      `Block ${ex.blockNumber} (${ex.seriesName || 'Series'}) · Round ${ex.roundNumber}: ${ex.reason}`
    );
  }

  const acknowledgments = Array.from(warningTypes.values());

  if (totalRounds === 0 && blockingReasons.length === 0) {
    blockingReasons.push(
      'No valid importable rounds remain after applying exclusions and skips.'
    );
  }

  // Run pre-flight validatePayload across all planned chunks
  const payloadProblems = [];
  for (const bp of blockPlans) {
    for (const chunk of bp.roundChunks) {
      const probs = validatePayload(chunk, { todayIST });
      for (const p of probs) {
        payloadProblems.push({
          ...p,
          blockNumber: bp.blockNumber,
        });
      }
    }
  }
  if (payloadProblems.length > 0) {
    for (const p of payloadProblems) {
      blockingReasons.push(p.message);
    }
  }

  // Prepare bounded edits list for p_summary (at most 500 entries + total count)
  const fullEditsList = Array.isArray(previewState?.editsList)
    ? previewState.editsList
    : Array.isArray(effectiveParsed?.editsList)
      ? effectiveParsed.editsList
      : [];
  const boundedEdits = fullEditsList.slice(0, MAX_RECORDED_EDITS);
  const editsTruncated = fullEditsList.length > MAX_RECORDED_EDITS;

  const summaryPayload = {
    source_file_name: fileName.slice(0, 260),
    date_format_used: effectiveParsed?.resolvedDateFormat || 'DD/MM',
    on_date_conflict: onDateConflict,
    blocks: (previewState?.blockReports || []).map((br) => ({
      block_number: br.blockNumber,
      series_id: br.seriesId,
      series_name: br.seriesName,
      new_rounds: br.dataComparison.summaryCounts.rounds.newRounds,
      existing_rounds:
        br.dataComparison.summaryCounts.rounds.existingIdentical +
        br.dataComparison.summaryCounts.rounds.existingAddsCells +
        br.dataComparison.summaryCounts.rounds.existingWithConflicts,
      new_cells: br.dataComparison.summaryCounts.cells.newCells,
    })),
    excluded_rounds: excludedRounds,
    skipped_rounds: skippedRounds,
    acknowledgments: acknowledgments.map((a) => ({
      key: a.key,
      label: a.label,
      count: a.count,
    })),
    edits: boundedEdits,
    edits_total_count: fullEditsList.length,
    edits_truncated: editsTruncated,
  };

  const readyToImport = blockingReasons.length === 0 && totalRounds > 0;
  const studentNameInFile = effectiveParsed?.studentNameInFile || null;
  const studentNameMismatch = Boolean(
    studentNameInFile &&
      selectedStudent &&
      effectiveParsed?.studentNameMatchesSelected === false
  );

  return {
    readyToImport,
    canExecute: readyToImport,
    ready: readyToImport,
    blockingReasons,
    payloadProblems,
    validationProblems: payloadProblems,
    requiresAcknowledgment: acknowledgments.length > 0,
    acknowledgments,
    acknowledgmentCounts,
    excludedRounds,
    skippedRounds,
    editsList: fullEditsList,
    edits: boundedEdits,
    editsTotalCount: fullEditsList.length,
    editsTruncated,
    totalRounds,
    rowsFound,
    rowsFoundCount: rowsFound,
    studentId: selectedStudent?.id || null,
    studentName: selectedStudent?.full_name || '',
    studentCode: selectedStudent?.student_code || '',
    fileName,
    nameInFile: studentNameInFile,
    studentNameInFile,
    studentNameMismatch,
    markVerified,
    onDateConflict,
    summaryPayload,
    summaryJson: summaryPayload,
    blockPlans,
    ensureCategorySteps,
    aliasSteps,
    roundImportSteps,
    roundCalls: roundImportSteps,
  };
}

/**
 * Builds the import payload directly from `(parsed, editState, options)` or `(parsed, options)`.
 * Used by unit tests and preview inspection to verify the exact payload sent to `admin_import_rounds`
 * and `admin_start_import` after edits.
 */
export function buildImportPayload(
  parsedOrPreviewState,
  editStateOrOptions = {},
  maybeOptions = {}
) {
  let previewState = parsedOrPreviewState;
  let options = editStateOrOptions || {};

  const isRawParsed =
    parsedOrPreviewState &&
    Array.isArray(parsedOrPreviewState.blocks) &&
    !Array.isArray(parsedOrPreviewState.blockReports);

  if (isRawParsed) {
    const isEditStateArg =
      editStateOrOptions &&
      (editStateOrOptions.rounds !== undefined ||
        editStateOrOptions.cells !== undefined ||
        editStateOrOptions.roundEdits !== undefined ||
        editStateOrOptions.cellEdits !== undefined);
    const editState = isEditStateArg
      ? editStateOrOptions
      : editStateOrOptions?.editState || createEmptyEditState();
    options = isEditStateArg ? maybeOptions || {} : editStateOrOptions || {};

    const defaultSeries = options.roundSeries || [
      { id: 'ser-old', name: 'Old simulator', is_current: false, sort_order: 1 },
      { id: 'ser-new', name: 'New simulator', is_current: true, sort_order: 2 },
    ];

    const defaultBlockUiState = options.blockUiState || {};
    for (const blk of parsedOrPreviewState.blocks) {
      if (!defaultBlockUiState[blk.blockNumber]) {
        const sug = suggestSeriesForBlock(blk, defaultSeries);
        const adminMappings = {};
        for (const cat of blk.categories || []) {
          if (cat.matchStatus === 'unmatched') {
            adminMappings[cat.rawKey] = { action: 'create_historical' };
          }
        }
        defaultBlockUiState[blk.blockNumber] = {
          seriesId: sug.suggestedSeriesId || defaultSeries[0]?.id || 'ser-old',
          confirmed: true,
          adminMappings,
        };
      }
    }

    previewState = buildImportPreviewState(parsedOrPreviewState, {
      ...options,
      roundSeries: defaultSeries,
      blockUiState: defaultBlockUiState,
      editState,
    });
  }

  const plan = buildImportExecutionPlan(
    previewState.effectiveParsed,
    previewState,
    {
      selectedStudent: options.selectedStudent || {
        id: 'stu-1',
        student_code: 'STU101',
        full_name: 'TEST STUDENT',
      },
      fileName: options.fileName || 'sheet.csv',
      markVerified: Boolean(options.markVerified),
      onDateConflict: options.onDateConflict || 'skip',
      todayIST: options.todayIST || previewState?.todayIST,
    }
  );

  const allRounds = (plan.blockPlans || []).flatMap((bp) => bp.rounds || []);

  return {
    ...plan,
    rounds: allRounds,
    previewState,
  };
}
