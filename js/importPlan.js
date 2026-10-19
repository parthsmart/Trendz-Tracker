/**
 * Trendz Tracker — Phase 4c-2a & 4c-2b CSV Import Planner, Resolver & Comparison Engine (js/importPlan.js)
 *
 * STRICT ARCHITECTURAL RULES:
 * - 100% pure JavaScript functions (no DOM, no window/document, no import.meta.env).
 * - Runs identically in the browser (`js/import.js`) and in Node.js (`node --test`).
 * - Handles:
 *   1. Simulator series suggestion & validation per block (Old simulator vs New simulator,
 *      block label hint association, round range, date range, confirmation check, and
 *      duplicate-series blocking check).
 *   2. Category resolution per block with strict priority:
 *      (a) Database `category_aliases` (alias = lowercase name with all whitespace removed)
 *      (b) Built-in aliases ("calender" -> Calendar, "timeelapse" -> Time Elapsed)
 *      (c) Exact match on `categories.name` (matching key = lowercase with all whitespace removed)
 *      Plus `category_series` membership check and duplicate target category blocking check.
 *   3. Comparison with existing student data (`student_rounds` and `results`) identified by
 *      (student, series, round_number), including round metadata diffs and cell-level status
 *      (new, identical, unverified conflict, protected verified/corrected conflict, db_only).
 *   4. Phase 4c-2b import execution planning and RPC payload chunking
 *      (1..100 rounds and at most 3000 cells per `admin_import_rounds` call).
 */

import { BUILT_IN_CATEGORY_ALIASES, formatSecondsDisplay } from './importParser.js';

/**
 * Maximum rounds and cells accepted per single `admin_import_rounds` RPC call.
 */
export const MAX_ROUNDS_PER_RPC_CALL = 100;
export const MAX_CELLS_PER_RPC_CALL = 3000;

/**
 * Normalises a string into a matching key: lowercase with all whitespace removed.
 *
 * @param {string} name
 * @returns {string}
 */
export function toMatchingKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Marker category keys that suggest a specific simulator series for a block.
 * - "currency" or "missingfigures" -> suggests "Old simulator"
 * - "approximation" or "hcfandlcm" -> suggests "New simulator"
 */
export const OLD_SIMULATOR_MARKER_KEYS = Object.freeze(['currency', 'missingfigures']);
export const NEW_SIMULATOR_MARKER_KEYS = Object.freeze(['approximation', 'hcfandlcm']);

/**
 * Suggests a simulator series (`round_series` row) for a parsed block based on its category keys.
 * Pre-selects a SUGGESTION only:
 * - A block containing a category whose key is "currency" or "missingfigures" suggests "Old simulator".
 * - A block containing a category whose key is "approximation" or "hcfandlcm" suggests "New simulator".
 * - Otherwise nothing is suggested (null).
 *
 * @param {Array<{sheetName?: string, rawKey?: string}>} blockCategories
 * @param {Array<{id: string, name: string, sort_order?: number, is_current?: boolean}>} roundSeries
 * @returns {{
 *   suggestedSeriesId: string|null,
 *   suggestedSeriesName: string|null,
 *   markerKeysFound: string[],
 *   suggestionReason: string|null
 * }}
 */
export function suggestSeriesForBlock(blockCategories = [], roundSeries = []) {
  const keysInBlock = new Set();
  for (const cat of blockCategories) {
    const key = cat.rawKey ? String(cat.rawKey) : toMatchingKey(cat.sheetName);
    if (key) keysInBlock.add(key);
  }

  const matchedOldMarkers = OLD_SIMULATOR_MARKER_KEYS.filter((k) => keysInBlock.has(k));
  const matchedNewMarkers = NEW_SIMULATOR_MARKER_KEYS.filter((k) => keysInBlock.has(k));

  const findSeriesByTargetKey = (targetKey) =>
    roundSeries.find((s) => toMatchingKey(s.name) === targetKey) ||
    roundSeries.find((s) => toMatchingKey(s.name).includes(targetKey)) ||
    null;

  if (matchedOldMarkers.length > 0 && matchedNewMarkers.length === 0) {
    const oldSer = findSeriesByTargetKey('oldsimulator');
    if (oldSer) {
      return {
        suggestedSeriesId: oldSer.id,
        suggestedSeriesName: oldSer.name,
        markerKeysFound: matchedOldMarkers,
        suggestionReason: `Suggested "${oldSer.name}" because block contains ${matchedOldMarkers.join(', ')}`,
      };
    }
  }

  if (matchedNewMarkers.length > 0 && matchedOldMarkers.length === 0) {
    const newSer = findSeriesByTargetKey('newsimulator');
    if (newSer) {
      return {
        suggestedSeriesId: newSer.id,
        suggestedSeriesName: newSer.name,
        markerKeysFound: matchedNewMarkers,
        suggestionReason: `Suggested "${newSer.name}" because block contains ${matchedNewMarkers.join(', ')}`,
      };
    }
  }

  return {
    suggestedSeriesId: null,
    suggestedSeriesName: null,
    markerKeysFound: [],
    suggestionReason: null,
  };
}

/**
 * Extracts block metadata to display next to the Simulator Series dropdown:
 * - Block label hint from the file (handles hints placed in the gap column just before a block)
 * - Block's round range (e.g. "Rounds 1–2 (2 rounds)")
 * - Block's date range (minDate to maxDate)
 *
 * @param {Object} block - Parsed block object from parseScoreSheetCsv
 * @param {Array<Object>} allBlocks - All parsed blocks in the sheet
 * @param {Array<{text: string, ref: string, row: number, col: number}>} globalLabelHints - Top-row hints from parser
 * @returns {{
 *   blockHints: Array<{text: string, ref: string, row: number, col: number}>,
 *   roundRange: { minRound: number|null, maxRound: number|null, count: number, text: string },
 *   dateRange: { minDate: string|null, maxDate: string|null, text: string }
 * }}
 */
export function getBlockHeaderMetadata(block, allBlocks = [], globalLabelHints = []) {
  // 1. Round range
  const roundNums = (block.rounds || [])
    .map((r) => Number(r.roundNumber))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  let roundRange;
  if (roundNums.length === 0) {
    roundRange = { minRound: null, maxRound: null, count: 0, text: 'No rounds' };
  } else {
    const minRound = roundNums[0];
    const maxRound = roundNums[roundNums.length - 1];
    const count = roundNums.length;
    const text =
      minRound === maxRound
        ? `Round ${minRound} (1 round)`
        : `Rounds ${minRound}–${maxRound} (${count} rounds)`;
    roundRange = { minRound, maxRound, count, text };
  }

  // 2. Date range
  const validDates = (block.rounds || [])
    .map((r) => r.dateISO)
    .filter(Boolean)
    .sort();
  const minDate = validDates.length > 0 ? validDates[0] : block.dateRange?.minDate || null;
  const maxDate =
    validDates.length > 0 ? validDates[validDates.length - 1] : block.dateRange?.maxDate || null;
  const dateRangeText =
    minDate && maxDate
      ? minDate === maxDate
        ? minDate
        : `${minDate} to ${maxDate}`
      : 'No valid dates';

  // 3. Associate top-row label hints with the block they introduce
  // A label like "NEW SIMULATOR" is often placed in the gap column between Block k-1's last round
  // and Block k's INDEX/Category columns.
  const blockHints = [];
  if (Array.isArray(globalLabelHints) && globalLabelHints.length > 0 && allBlocks.length > 0) {
    const blkIdx = allBlocks.findIndex((b) => b.blockNumber === block.blockNumber);
    const prevBlock = blkIdx > 0 ? allBlocks[blkIdx - 1] : null;
    const prevLastTimeCol = prevBlock ? getLastOccupiedColOfBlock(prevBlock) : -1;
    const currLastTimeCol =
      blkIdx === allBlocks.length - 1 ? Infinity : getLastOccupiedColOfBlock(block);

    for (const h of globalLabelHints) {
      if (blkIdx === 0) {
        if (h.col <= currLastTimeCol) {
          blockHints.push(h);
        }
      } else {
        if (h.col > prevLastTimeCol && h.col <= currLastTimeCol) {
          blockHints.push(h);
        }
      }
    }
  } else if (Array.isArray(block.labelHints)) {
    blockHints.push(...block.labelHints);
  }

  return {
    blockHints,
    roundRange,
    dateRange: {
      minDate,
      maxDate,
      text: dateRangeText,
    },
  };
}

/**
 * Helper to find the rightmost round column (timeCol) of a block.
 */
function getLastOccupiedColOfBlock(blk) {
  const cands = blk.candidateRounds || blk.rounds || [];
  let maxCol = blk.categoryCol ?? 0;
  for (const r of cands) {
    if (typeof r.timeCol === 'number' && r.timeCol > maxCol) maxCol = r.timeCol;
    else if (typeof r.scoreCol === 'number' && r.scoreCol + 1 > maxCol) maxCol = r.scoreCol + 1;
  }
  return maxCol;
}

/**
 * Validates the simulator series selection and confirmation across all blocks.
 * Rules:
 * - Every block must have a selected series.
 * - The admin must confirm every block.
 * - Two blocks must never use the same series (blocking error).
 *
 * @param {Array<{blockNumber: number, seriesId: string|null, confirmed: boolean}>} blockStates
 * @param {Array<{id: string, name: string}>} roundSeries
 * @returns {{
 *   valid: boolean,
 *   errors: Array<{severity: 'error', type: string, blockNumber: number|null, message: string}>,
 *   duplicateSeriesIds: string[]
 * }}
 */
export function validateBlockSeriesSelections(blockStates = [], roundSeries = []) {
  const seriesById = new Map((roundSeries || []).map((s) => [s.id, s]));
  const errors = [];
  const bySeriesId = new Map();

  for (const st of blockStates) {
    const seriesId = st.seriesId ? String(st.seriesId).trim() : '';
    const serObj = seriesById.get(seriesId);
    const serName = serObj ? serObj.name : seriesId;

    if (!seriesId) {
      errors.push({
        severity: 'error',
        type: 'unselected_series',
        blockNumber: st.blockNumber,
        message: `Block ${st.blockNumber}: No simulator series selected. Please choose and confirm a simulator series for Block ${st.blockNumber}.`,
      });
    } else {
      if (!bySeriesId.has(seriesId)) bySeriesId.set(seriesId, []);
      bySeriesId.get(seriesId).push(st.blockNumber);

      if (!st.confirmed) {
        errors.push({
          severity: 'error',
          type: 'unconfirmed_series',
          blockNumber: st.blockNumber,
          message: `Block ${st.blockNumber}: Simulator series "${serName}" is unconfirmed. Please confirm the simulator series for Block ${st.blockNumber}.`,
        });
      }
    }
  }

  const duplicateSeriesIds = [];
  for (const [seriesId, blockNums] of bySeriesId.entries()) {
    if (blockNums.length > 1) {
      duplicateSeriesIds.push(seriesId);
      const serName = seriesById.get(seriesId)?.name || seriesId;
      const blocksLabel = blockNums.map((n) => `Block ${n}`).join(' and ');
      errors.push({
        severity: 'error',
        type: 'duplicate_series',
        blockNumber: null,
        message: `Blocking error: ${blocksLabel} cannot use the same simulator series ("${serName}"). Each block must use a distinct series.`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    duplicateSeriesIds,
  };
}

/**
 * Resolves all categories in a single block using the strict Phase 4c-2a priority order:
 * 1. `category_aliases` from the database (alias = lowercase name with all whitespace removed)
 * 2. Built-in aliases ("calender" -> Calendar, "timeelapse" -> Time Elapsed)
 * 3. Exact match on `categories.name` (matching key = lowercase with all whitespace removed)
 *
 * Also checks:
 * - Whether each resolved category belongs to the block's selected `seriesId` in `category_series`
 * - Which categories in the block's selected `seriesId` are absent from the block
 * - Duplicate target category mappings within the same block (blocking error)
 *
 * @param {Array<Object>} blockCategories - `blk.categories` from `parseScoreSheetCsv`
 * @param {Object} options
 * @param {Array<{id: string, name: string, section?: string, active?: boolean, sort_order?: number}>} [options.roundCategories=[]]
 * @param {Array<{alias: string, category_id: string}>} [options.categoryAliases=[]]
 * @param {Array<{category_id: string, series_id: string, sort_order?: number}>} [options.categorySeries=[]]
 * @param {string|null} [options.seriesId=null] - Selected simulator series ID for this block
 * @param {string|null} [options.seriesName=null] - Selected simulator series display name
 * @param {Object} [options.adminMappings={}] - Per-rawKey admin mapping overrides `{ [rawKey]: { action, targetCategoryId, saveAlias } }`
 * @param {number} [options.blockNumber=1]
 * @returns {Object} Detailed category resolution result for the block
 */
export function resolveBlockCategories(blockCategories = [], options = {}) {
  const {
    roundCategories = [],
    categoryAliases = [],
    categorySeries = [],
    seriesId = null,
    seriesName = null,
    adminMappings = {},
    blockNumber = 1,
  } = options;

  // 1. Build lookup maps for DB round categories
  const dbCatById = new Map();
  const dbCatByKey = new Map();

  for (const cat of roundCategories) {
    if (!cat || !cat.id) continue;
    dbCatById.set(cat.id, cat);
    const key = toMatchingKey(cat.name);
    if (key && !dbCatByKey.has(key)) {
      dbCatByKey.set(key, cat);
    }
  }

  // 2. Build lookup map for DB category_aliases (Priority 1)
  const dbAliasByKey = new Map();
  for (const al of categoryAliases) {
    if (!al || !al.alias || !al.category_id) continue;
    const key = toMatchingKey(al.alias);
    const targetCat = dbCatById.get(al.category_id);
    if (key && targetCat) {
      dbAliasByKey.set(key, {
        alias: key,
        category_id: al.category_id,
        category: targetCat,
      });
    }
  }

  // 3. Build series membership map for the selected seriesId
  const seriesMembershipMap = new Map();
  if (seriesId) {
    for (const cs of categorySeries) {
      if (cs && cs.series_id === seriesId && cs.category_id) {
        seriesMembershipMap.set(cs.category_id, cs.sort_order ?? 0);
      }
    }
  }

  const resolvedRows = [];
  const targetCategoryCount = new Map(); // category_id -> array of sheet category names

  for (const cat of blockCategories) {
    const rawKey = cat.rawKey ? String(cat.rawKey) : toMatchingKey(cat.sheetName);

    // Priority 1: Database category_aliases
    // Priority 2: Built-in aliases ("calender" -> Calendar, "timeelapse" -> Time Elapsed)
    // Priority 3: Exact match on categories.name (by matching key)
    let autoMatchType = 'unmatched'; // 'db_alias' | 'builtin_alias' | 'exact' | 'unmatched'
    let autoMatchedCategory = null;
    let aliasUsed = null;

    if (dbAliasByKey.has(rawKey)) {
      const hit = dbAliasByKey.get(rawKey);
      autoMatchType = 'db_alias';
      autoMatchedCategory = hit.category;
      aliasUsed = hit.alias;
    } else if (BUILT_IN_CATEGORY_ALIASES[rawKey]) {
      const builtinTargetKey = BUILT_IN_CATEGORY_ALIASES[rawKey];
      const hitCat = dbCatByKey.get(builtinTargetKey) || null;
      if (hitCat) {
        autoMatchType = 'builtin_alias';
        autoMatchedCategory = hitCat;
        aliasUsed = rawKey;
      }
    } else if (dbCatByKey.has(rawKey)) {
      autoMatchType = 'exact';
      autoMatchedCategory = dbCatByKey.get(rawKey);
    }

    // Apply any admin mapping choice for unmatched categories (or explicit override)
    const adminChoice = adminMappings[rawKey] || null;
    let effectiveStatus = autoMatchType; // 'db_alias' | 'builtin_alias' | 'exact' | 'mapped_existing' | 'create_historical' | 'skipped' | 'unmatched'
    let resolvedCategory = autoMatchedCategory;
    let mappingAction = autoMatchedCategory ? 'matched' : 'unmatched';
    let saveAlias = adminChoice?.saveAlias !== undefined ? Boolean(adminChoice.saveAlias) : true;

    if (autoMatchType === 'unmatched') {
      if (adminChoice) {
        if (adminChoice.action === 'map' && adminChoice.targetCategoryId) {
          const targetCat = dbCatById.get(adminChoice.targetCategoryId) || null;
          if (targetCat) {
            effectiveStatus = 'mapped_existing';
            resolvedCategory = targetCat;
            mappingAction = 'map';
          }
        } else if (adminChoice.action === 'create_historical') {
          effectiveStatus = 'create_historical';
          resolvedCategory = null;
          mappingAction = 'create_historical';
        } else if (adminChoice.action === 'skip') {
          effectiveStatus = 'skipped';
          resolvedCategory = null;
          mappingAction = 'skip';
        }
      }
    } else if (adminChoice && adminChoice.action === 'skip') {
      effectiveStatus = 'skipped';
      resolvedCategory = null;
      mappingAction = 'skip';
    } else if (adminChoice && adminChoice.action === 'map' && adminChoice.targetCategoryId) {
      const targetCat = dbCatById.get(adminChoice.targetCategoryId) || null;
      if (targetCat) {
        effectiveStatus =
          targetCat.id === autoMatchedCategory?.id ? autoMatchType : 'mapped_existing';
        resolvedCategory = targetCat;
        mappingAction = 'map';
      }
    }

    const inSelectedSeries =
      seriesId && resolvedCategory ? seriesMembershipMap.has(resolvedCategory.id) : null;
    const seriesSortOrder =
      seriesId && resolvedCategory && seriesMembershipMap.has(resolvedCategory.id)
        ? seriesMembershipMap.get(resolvedCategory.id)
        : null;

    if (resolvedCategory && effectiveStatus !== 'skipped') {
      if (!targetCategoryCount.has(resolvedCategory.id)) {
        targetCategoryCount.set(resolvedCategory.id, []);
      }
      targetCategoryCount.get(resolvedCategory.id).push(cat.sheetName);
    }

    resolvedRows.push({
      rowIndex: cat.rowIndex,
      indexLabel: cat.indexLabel,
      sheetName: cat.sheetName,
      ref: cat.ref,
      rawKey,
      isSurpriseTask: Boolean(cat.isSurpriseTask),
      autoMatchType,
      autoMatchedCategory: autoMatchedCategory
        ? {
            id: autoMatchedCategory.id,
            name: autoMatchedCategory.name,
            active: autoMatchedCategory.active !== false,
          }
        : null,
      aliasUsed,
      effectiveStatus,
      mappingAction,
      saveAlias,
      resolvedCategory: resolvedCategory
        ? {
            id: resolvedCategory.id,
            name: resolvedCategory.name,
            active: resolvedCategory.active !== false,
          }
        : null,
      inSelectedSeries,
      seriesSortOrder,
      duplicateTargetError: false,
    });
  }

  // 4. Detect duplicate target categories within the same block
  const errors = [];
  const warnings = [];

  for (const [catId, sheetNames] of targetCategoryCount.entries()) {
    if (sheetNames.length > 1) {
      const dbCat = dbCatById.get(catId);
      const targetName = dbCat ? dbCat.name : catId;
      for (const row of resolvedRows) {
        if (row.resolvedCategory?.id === catId) {
          row.duplicateTargetError = true;
        }
      }
      errors.push({
        severity: 'error',
        type: 'duplicate_category_target',
        blockNumber,
        roundNumber: null,
        ref: null,
        message: `Blocking error in Block ${blockNumber}: Sheet categories ${sheetNames
          .map((n) => `"${n}"`)
          .join(' and ')} resolve to the same database category "${targetName}".`,
      });
    }
  }

  // 5. Check for unresolved unmatched categories and categories not in the selected simulator series
  for (const row of resolvedRows) {
    if (row.effectiveStatus === 'unmatched') {
      warnings.push({
        severity: 'warning',
        type: 'unmatched_category',
        blockNumber,
        roundNumber: null,
        ref: row.ref,
        message: `Block ${blockNumber}: Category "${row.sheetName}" (${row.ref}) does not match any database alias, built-in alias, or round category. Choose a resolution below.`,
      });
    } else if (seriesId && row.resolvedCategory && row.inSelectedSeries === false) {
      warnings.push({
        severity: 'warning',
        type: 'category_not_in_series',
        blockNumber,
        roundNumber: null,
        ref: row.ref,
        message: `Block ${blockNumber}: Category "${row.sheetName}" → "${row.resolvedCategory.name}" (${row.ref}) is not linked to "${seriesName || 'selected series'}" in category_series (will be linked on import).`,
      });
    }
  }

  // 6. Compute absent categories for this block
  const resolvedIdsSet = new Set(
    resolvedRows
      .filter((r) => r.resolvedCategory && r.effectiveStatus !== 'skipped')
      .map((r) => r.resolvedCategory.id)
  );

  let absentCategories = [];
  if (seriesId && seriesMembershipMap.size > 0) {
    const seriesEntries = categorySeries
      .filter((cs) => cs.series_id === seriesId && dbCatById.has(cs.category_id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    absentCategories = seriesEntries
      .filter((cs) => !resolvedIdsSet.has(cs.category_id))
      .map((cs) => {
        const c = dbCatById.get(cs.category_id);
        return {
          id: c.id,
          name: c.name,
          active: c.active !== false,
          sort_order: cs.sort_order ?? c.sort_order ?? 0,
        };
      });
  } else {
    absentCategories = roundCategories
      .filter((c) => c && c.id && !resolvedIdsSet.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        active: c.active !== false,
        sort_order: c.sort_order ?? 0,
      }));
  }

  const counts = {
    total: resolvedRows.length,
    exact: resolvedRows.filter((r) => r.effectiveStatus === 'exact').length,
    dbAlias: resolvedRows.filter((r) => r.effectiveStatus === 'db_alias').length,
    builtinAlias: resolvedRows.filter((r) => r.effectiveStatus === 'builtin_alias').length,
    mappedExisting: resolvedRows.filter((r) => r.effectiveStatus === 'mapped_existing').length,
    createHistorical: resolvedRows.filter((r) => r.effectiveStatus === 'create_historical').length,
    skipped: resolvedRows.filter((r) => r.effectiveStatus === 'skipped').length,
    unmatched: resolvedRows.filter((r) => r.effectiveStatus === 'unmatched').length,
    notInSelectedSeries: resolvedRows.filter(
      (r) => seriesId && r.resolvedCategory && r.inSelectedSeries === false
    ).length,
  };

  return {
    categories: resolvedRows,
    absentCategories,
    counts,
    errors,
    warnings,
  };
}

/**
 * Formats a database result row into a compact human-readable string (e.g. "19/20 · 0:50").
 *
 * @param {Object|null} dbResult
 * @returns {string}
 */
export function formatDbResultDisplay(dbResult) {
  if (!dbResult) return '—';
  if (dbResult.note && (dbResult.correct === null || dbResult.correct === undefined)) {
    return `Note: "${dbResult.note}"`;
  }
  if (
    dbResult.correct !== null &&
    dbResult.correct !== undefined &&
    dbResult.total !== null &&
    dbResult.total !== undefined
  ) {
    const scorePart = `${dbResult.correct}/${dbResult.total}`;
    const timePart =
      dbResult.time_seconds !== null && dbResult.time_seconds !== undefined
        ? ` · ${formatSecondsDisplay(dbResult.time_seconds, false)}`
        : '';
    const notePart = dbResult.note ? ` (${dbResult.note})` : '';
    return `${scorePart}${timePart}${notePart}`;
  }
  return '—';
}

/**
 * Formats a parsed CSV cell into a compact human-readable string (e.g. "75/75 · 1:15").
 *
 * @param {Object|null} cell
 * @returns {string}
 */
export function formatSheetCellDisplay(cell) {
  if (!cell) return '—';
  if (cell.status === 'empty') return '— (Empty)';
  if (cell.status === 'note') return `Note: "${cell.note}"`;
  if (cell.status === 'unreadable') {
    const rawS = String(cell.rawScore ?? '').trim();
    const rawT = String(cell.rawTime ?? '').trim();
    return `Unreadable (${[rawS, rawT].filter(Boolean).join(', ')})`;
  }
  if (cell.correct !== null && cell.total !== null) {
    const scorePart = `${cell.correct}/${cell.total}`;
    const timePart =
      cell.timeSeconds !== null && cell.timeSeconds !== undefined
        ? ` · ${formatSecondsDisplay(cell.timeSeconds, false)}`
        : '';
    return `${scorePart}${timePart}`;
  }
  return '—';
}

/**
 * Compares a single block's rounds and cells against the selected student's existing
 * `student_rounds` and `results` in the database for the block's selected `seriesId`.
 *
 * A round is identified by `(student_id, series_id, round_number)`.
 *
 * @param {Object} block - Parsed block from `parseScoreSheetCsv`
 * @param {Array<Object>} resolvedCategories - Output `categories` from `resolveBlockCategories`
 * @param {Object} options
 * @param {string|null} [options.studentId=null]
 * @param {string|null} [options.seriesId=null]
 * @param {string|null} [options.seriesName=null]
 * @param {Array<Object>} [options.existingStudentRounds=[]]
 * @param {Array<Object>} [options.existingResults=[]]
 * @param {Array<Object>} [options.roundCategories=[]]
 * @returns {Object} Block comparison report
 */
export function compareBlockWithExistingData(block, resolvedCategories = [], options = {}) {
  const {
    studentId = null,
    seriesId = null,
    seriesName = null,
    existingStudentRounds = [],
    existingResults = [],
    roundCategories = [],
  } = options;

  const dbCatById = new Map((roundCategories || []).map((c) => [c.id, c]));
  const resolvedByRowIndex = new Map((resolvedCategories || []).map((rc) => [rc.rowIndex, rc]));

  // Filter existing rounds for (studentId, seriesId)
  const studentSeriesRounds =
    studentId && seriesId
      ? (existingStudentRounds || []).filter(
          (sr) => sr.student_id === studentId && sr.series_id === seriesId
        )
      : [];

  const existingRoundByNum = new Map();
  const existingRoundsByDate = new Map();
  for (const sr of studentSeriesRounds) {
    const rNum = Number(sr.round_number);
    existingRoundByNum.set(rNum, sr);
    if (sr.round_date) {
      if (!existingRoundsByDate.has(sr.round_date)) {
        existingRoundsByDate.set(sr.round_date, []);
      }
      existingRoundsByDate.get(sr.round_date).push(sr);
    }
  }

  // Index existing results by student_round_id -> Map<category_id, resultRow>
  const resultsByRoundId = new Map();
  for (const res of existingResults || []) {
    if (!res || !res.student_round_id) continue;
    if (studentId && res.student_id && res.student_id !== studentId) continue;
    if (!resultsByRoundId.has(res.student_round_id)) {
      resultsByRoundId.set(res.student_round_id, new Map());
    }
    resultsByRoundId.get(res.student_round_id).set(res.category_id, res);
  }

  const sheetRoundNums = new Set();
  const roundComparisons = [];
  const warnings = [];
  const infos = [];

  const summaryCounts = {
    rounds: {
      totalInSheet: (block.rounds || []).length,
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
      emptyCells: 0,
      skippedCells: 0,
      unreadableCells: 0,
      unresolvedCategoryCells: 0,
    },
  };

  for (const rnd of block.rounds || []) {
    const rNum = Number(rnd.roundNumber);
    sheetRoundNums.add(rNum);

    const existingRound = existingRoundByNum.get(rNum) || null;
    const dbRoundResultsMap = existingRound
      ? resultsByRoundId.get(existingRound.id) || new Map()
      : new Map();

    // Check if another DB round in the same series (with a DIFFERENT round_number) shares this date
    const sameDateOtherDbRounds =
      rnd.dateISO && existingRoundsByDate.has(rnd.dateISO)
        ? existingRoundsByDate
            .get(rnd.dateISO)
            .filter((sr) => Number(sr.round_number) !== rNum)
            .map((sr) => ({
              id: sr.id,
              roundNumber: Number(sr.round_number),
              roundDate: sr.round_date,
            }))
        : [];

    if (sameDateOtherDbRounds.length > 0) {
      const otherLabel = sameDateOtherDbRounds.map((o) => `Round ${o.roundNumber}`).join(', ');
      warnings.push({
        severity: 'warning',
        type: 'db_duplicate_date',
        blockNumber: block.blockNumber,
        roundNumber: rNum,
        ref: rnd.dateRef,
        message: `Block ${block.blockNumber} · Round ${rNum}: Date ${rnd.dateISO} already exists in the database for ${otherLabel} in "${seriesName || 'this series'}".`,
      });
    }

    // Round-level metadata comparison when round exists in DB
    let metadataDiffs = [];
    let dateDiffers = false;
    let typeDiffers = false;
    let timeTakenDiffers = false;
    let timeTakenAdded = false;

    if (existingRound) {
      if (rnd.dateISO && existingRound.round_date && rnd.dateISO !== existingRound.round_date) {
        dateDiffers = true;
        metadataDiffs.push({
          field: 'round_date',
          label: 'Date',
          sheetValue: rnd.dateISO,
          dbValue: existingRound.round_date,
        });
      }

      const sheetType = rnd.summary?.roundType ? String(rnd.summary.roundType).trim() : null;
      const dbType = existingRound.round_type ? String(existingRound.round_type).trim() : null;
      if (sheetType && dbType && sheetType.toLowerCase() !== dbType.toLowerCase()) {
        typeDiffers = true;
        metadataDiffs.push({
          field: 'round_type',
          label: 'Round Type',
          sheetValue: sheetType,
          dbValue: dbType,
        });
      }

      const sheetSecs =
        rnd.summary?.timeTakenSeconds !== undefined ? rnd.summary.timeTakenSeconds : null;
      const dbSecs =
        existingRound.time_taken_seconds !== undefined ? existingRound.time_taken_seconds : null;

      if (sheetSecs !== null && dbSecs !== null && Number(sheetSecs) !== Number(dbSecs)) {
        timeTakenDiffers = true;
        metadataDiffs.push({
          field: 'time_taken_seconds',
          label: 'Time Taken',
          sheetValue: formatSecondsDisplay(sheetSecs, true),
          dbValue: formatSecondsDisplay(dbSecs, true),
        });
      } else if (sheetSecs !== null && dbSecs === null) {
        timeTakenAdded = true;
      }
    }

    // Cell-by-cell comparison
    const visitedDbCatIds = new Set();
    const cellComparisons = [];

    let roundNewCells = 0;
    let roundIdenticalCells = 0;
    let roundConflictCells = 0;
    let roundProtectedConflictCells = 0;
    let roundDbOnlyCells = 0;
    let roundEmptyCells = 0;
    let roundSkippedCells = 0;
    let roundUnreadableCells = 0;
    let roundUnresolvedCategoryCells = 0;

    for (const cell of rnd.cells || []) {
      const catRes = resolvedByRowIndex.get(cell.rowIndex) || null;
      const resolvedCatId = catRes?.resolvedCategory?.id || null;
      if (resolvedCatId) {
        visitedDbCatIds.add(resolvedCatId);
      }

      const dbRes =
        existingRound && resolvedCatId ? dbRoundResultsMap.get(resolvedCatId) || null : null;
      const isVerified = Boolean(
        dbRes && (dbRes.verified === true || dbRes.verified_at || dbRes.verified_by)
      );
      const isCorrected = Boolean(dbRes && (dbRes.corrected_at || dbRes.corrected_by));
      const isProtected = isVerified || isCorrected;

      let comparisonStatus = 'empty';
      let diffFields = [];

      if (catRes && catRes.effectiveStatus === 'skipped') {
        comparisonStatus = 'skipped';
        roundSkippedCells += 1;
        summaryCounts.cells.skippedCells += 1;
      } else if (cell.status === 'unreadable') {
        comparisonStatus = 'unreadable';
        roundUnreadableCells += 1;
        summaryCounts.cells.unreadableCells += 1;
      } else if (catRes && catRes.effectiveStatus === 'unmatched') {
        if (cell.status === 'empty') {
          comparisonStatus = 'empty';
          roundEmptyCells += 1;
          summaryCounts.cells.emptyCells += 1;
        } else {
          comparisonStatus = 'unresolved_category';
          roundUnresolvedCategoryCells += 1;
          summaryCounts.cells.unresolvedCategoryCells += 1;
        }
      } else if (cell.status === 'empty') {
        if (dbRes) {
          comparisonStatus = 'db_only';
          roundDbOnlyCells += 1;
          summaryCounts.cells.dbOnlyCells += 1;
        } else {
          comparisonStatus = 'empty';
          roundEmptyCells += 1;
          summaryCounts.cells.emptyCells += 1;
        }
      } else if (cell.status === 'ok' || cell.status === 'note') {
        if (!dbRes) {
          comparisonStatus = 'new';
          roundNewCells += 1;
          summaryCounts.cells.newCells += 1;
        } else {
          const sameCorrect = (cell.correct ?? null) === (dbRes.correct ?? null);
          const sameTotal = (cell.total ?? null) === (dbRes.total ?? null);
          const sameTime = (cell.timeSeconds ?? null) === (dbRes.time_seconds ?? null);
          const sameNote = String(cell.note ?? '') === String(dbRes.note ?? '');

          if (!sameCorrect || !sameTotal) diffFields.push('score');
          if (!sameTime) diffFields.push('time');
          if (!sameNote) diffFields.push('note');

          if (diffFields.length === 0) {
            comparisonStatus = 'identical';
            roundIdenticalCells += 1;
            summaryCounts.cells.identicalCells += 1;
          } else if (isProtected) {
            comparisonStatus = 'protected_conflict';
            roundProtectedConflictCells += 1;
            summaryCounts.cells.protectedConflictCells += 1;
          } else {
            comparisonStatus = 'conflict';
            roundConflictCells += 1;
            summaryCounts.cells.conflictCells += 1;
          }
        }
      }

      cellComparisons.push({
        rowIndex: cell.rowIndex,
        scoreRef: cell.scoreRef,
        timeRef: cell.timeRef,
        sheetCategoryName: cell.categoryName,
        resolvedCategoryName:
          catRes?.resolvedCategory?.name ||
          (catRes?.effectiveStatus === 'create_historical'
            ? `${cell.categoryName} (New Inactive)`
            : null),
        resolvedCategoryId: resolvedCatId,
        categoryStatus: catRes?.effectiveStatus || 'unmatched',
        cellStatus: cell.status,
        comparisonStatus,
        diffFields,
        sheetDisplay: formatSheetCellDisplay(cell),
        dbDisplay: formatDbResultDisplay(dbRes),
        dbResult: dbRes
          ? {
              id: dbRes.id,
              correct: dbRes.correct ?? null,
              total: dbRes.total ?? null,
              time_seconds: dbRes.time_seconds ?? null,
              note: dbRes.note ?? null,
              verified: isVerified,
              corrected: isCorrected,
              flagged: Boolean(dbRes.flagged),
            }
          : null,
        isVerified,
        isCorrected,
        isProtected,
      });
    }

    // Check if the existing DB round has any results in categories NOT present in the CSV block
    const dbOnlyExtraResults = [];
    if (existingRound) {
      for (const [catId, dbRes] of dbRoundResultsMap.entries()) {
        if (!visitedDbCatIds.has(catId)) {
          const catObj = dbCatById.get(catId);
          const isVerified = Boolean(
            dbRes.verified === true || dbRes.verified_at || dbRes.verified_by
          );
          const isCorrected = Boolean(dbRes.corrected_at || dbRes.corrected_by);
          dbOnlyExtraResults.push({
            categoryId: catId,
            categoryName: catObj ? catObj.name : 'Other Category',
            dbDisplay: formatDbResultDisplay(dbRes),
            isVerified,
            isCorrected,
            dbResult: dbRes,
          });
          roundDbOnlyCells += 1;
          summaryCounts.cells.dbOnlyCells += 1;
        }
      }
    }

    // Classify overall round comparison status
    let roundComparisonStatus = 'new'; // 'new' | 'identical' | 'adds_cells' | 'conflict'
    if (!existingRound) {
      roundComparisonStatus = 'new';
      summaryCounts.rounds.newRounds += 1;
    } else if (
      roundConflictCells > 0 ||
      roundProtectedConflictCells > 0 ||
      dateDiffers ||
      typeDiffers ||
      timeTakenDiffers
    ) {
      roundComparisonStatus = 'conflict';
      summaryCounts.rounds.existingWithConflicts += 1;

      const diffSummaryParts = [];
      if (metadataDiffs.length > 0) {
        diffSummaryParts.push(
          metadataDiffs
            .map((m) => `${m.label} (Sheet: ${m.sheetValue} vs DB: ${m.dbValue})`)
            .join(', ')
        );
      }
      if (roundConflictCells > 0) {
        diffSummaryParts.push(
          `${roundConflictCells} unverified cell conflict${roundConflictCells === 1 ? '' : 's'}`
        );
      }
      if (roundProtectedConflictCells > 0) {
        diffSummaryParts.push(
          `${roundProtectedConflictCells} protected (verified/corrected) cell difference${
            roundProtectedConflictCells === 1 ? '' : 's'
          }`
        );
      }

      warnings.push({
        severity: 'warning',
        type: 'existing_round_conflict',
        blockNumber: block.blockNumber,
        roundNumber: rNum,
        ref: rnd.headerRef,
        message: `Block ${block.blockNumber} · Round ${rNum} (exists in "${
          seriesName || 'selected series'
        }"): ${diffSummaryParts.join('; ')}.`,
      });
    } else if (roundNewCells > 0 || timeTakenAdded) {
      roundComparisonStatus = 'adds_cells';
      summaryCounts.rounds.existingAddsCells += 1;
    } else {
      roundComparisonStatus = 'identical';
      summaryCounts.rounds.existingIdentical += 1;
    }

    roundComparisons.push({
      roundNumber: rNum,
      headerRef: rnd.headerRef,
      roundComparisonStatus,
      existingRound: existingRound
        ? {
            id: existingRound.id,
            round_number: Number(existingRound.round_number),
            round_date: existingRound.round_date,
            round_type: existingRound.round_type,
            time_taken_seconds: existingRound.time_taken_seconds ?? null,
            import_batch_id: existingRound.import_batch_id ?? null,
          }
        : null,
      metadataDiffs,
      dateDiffers,
      typeDiffers,
      timeTakenDiffers,
      timeTakenAdded,
      sameDateOtherDbRounds,
      counts: {
        newCells: roundNewCells,
        identicalCells: roundIdenticalCells,
        conflictCells: roundConflictCells,
        protectedConflictCells: roundProtectedConflictCells,
        dbOnlyCells: roundDbOnlyCells,
        emptyCells: roundEmptyCells,
        skippedCells: roundSkippedCells,
        unreadableCells: roundUnreadableCells,
        unresolvedCategoryCells: roundUnresolvedCategoryCells,
      },
      cells: cellComparisons,
      dbOnlyExtraResults,
    });
  }

  // Find rounds in DB for this (student, series) that do NOT appear in the CSV block at all
  const dbOnlyRounds = studentSeriesRounds
    .filter((sr) => !sheetRoundNums.has(Number(sr.round_number)))
    .sort((a, b) => Number(a.round_number) - Number(b.round_number))
    .map((sr) => {
      const rMap = resultsByRoundId.get(sr.id) || new Map();
      return {
        id: sr.id,
        roundNumber: Number(sr.round_number),
        roundDate: sr.round_date,
        roundType: sr.round_type,
        scoresCount: rMap.size,
      };
    });

  summaryCounts.rounds.dbOnlyRounds = dbOnlyRounds.length;

  if (dbOnlyRounds.length > 0) {
    const rList = dbOnlyRounds.map((r) => `Round ${r.roundNumber} (${r.roundDate})`).join(', ');
    infos.push({
      severity: 'info',
      type: 'db_only_rounds',
      blockNumber: block.blockNumber,
      roundNumber: null,
      ref: null,
      message: `Block ${block.blockNumber}: ${dbOnlyRounds.length} existing round${
        dbOnlyRounds.length === 1 ? '' : 's'
      } in "${seriesName || 'selected series'}" (${rList}) are in the database only and will remain untouched.`,
    });
  }

  return {
    blockNumber: block.blockNumber,
    seriesId,
    seriesName,
    studentId,
    summaryCounts,
    rounds: roundComparisons,
    dbOnlyRounds,
    warnings,
    infos,
  };
}

/**
 * Full Phase 4c-2a/2b orchestrator:
 * Combines simulator suggestion & validation, per-block category resolution, and
 * existing student round/result comparison across all blocks of a parsed CSV sheet.
 *
 * @param {Object} parsed - Output from `parseScoreSheetCsv`
 * @param {Object} options
 * @param {Object|null} [options.selectedStudent=null]
 * @param {Array<Object>} [options.roundSeries=[]]
 * @param {Array<Object>} [options.categorySeries=[]]
 * @param {Array<Object>} [options.roundCategories=[]]
 * @param {Array<Object>} [options.categoryAliases=[]]
 * @param {Array<Object>} [options.existingStudentRounds=[]]
 * @param {Array<Object>} [options.existingResults=[]]
 * @param {Object} [options.blockUiState={}] - Keyed by blockNumber: `{ seriesId, confirmed, adminMappings }`
 * @returns {Object} Complete Phase 4c-2a/2b resolution & comparison state
 */
export function buildImportPreviewState(parsed, options = {}) {
  const {
    selectedStudent = null,
    roundSeries = [],
    categorySeries = [],
    roundCategories = [],
    categoryAliases = [],
    existingStudentRounds = [],
    existingResults = [],
    blockUiState = {},
  } = options;

  if (!parsed || !parsed.ok) {
    return {
      ok: false,
      blockReports: [],
      seriesValidation: { valid: false, errors: [], duplicateSeriesIds: [] },
      overallComparison: null,
      combinedAttention: parsed?.needsAttention || [],
    };
  }

  const seriesById = new Map((roundSeries || []).map((s) => [s.id, s]));
  const blockSelectionList = [];
  const blockReports = [];
  const skippedCellRefs = new Set();

  // 1. Prepare each block's series suggestion, header metadata, selection, and confirmation state
  for (const blk of parsed.blocks || []) {
    const suggestion = suggestSeriesForBlock(blk.categories, roundSeries);
    const headerMeta = getBlockHeaderMetadata(blk, parsed.blocks, parsed.labelHints);
    const uiState = blockUiState[blk.blockNumber] || {};

    const effectiveSeriesId =
      uiState.seriesId !== undefined ? uiState.seriesId : suggestion.suggestedSeriesId || '';
    const confirmed = Boolean(uiState.confirmed && effectiveSeriesId);
    const selectedSeriesObj = effectiveSeriesId ? seriesById.get(effectiveSeriesId) || null : null;

    blockSelectionList.push({
      blockNumber: blk.blockNumber,
      seriesId: effectiveSeriesId,
      confirmed,
    });

    const categoryResolution = resolveBlockCategories(blk.categories, {
      roundCategories,
      categoryAliases,
      categorySeries,
      seriesId: effectiveSeriesId || null,
      seriesName: selectedSeriesObj ? selectedSeriesObj.name : null,
      adminMappings: uiState.adminMappings || {},
      blockNumber: blk.blockNumber,
    });

    // Track cell refs belonging to skipped categories so unreadable cells in skipped categories do not block import
    const skippedRowIndices = new Set(
      categoryResolution.categories
        .filter((c) => c.effectiveStatus === 'skipped')
        .map((c) => c.rowIndex)
    );
    if (skippedRowIndices.size > 0) {
      for (const rnd of blk.rounds || []) {
        for (const cell of rnd.cells || []) {
          if (skippedRowIndices.has(cell.rowIndex)) {
            if (cell.scoreRef) skippedCellRefs.add(cell.scoreRef);
            if (cell.timeRef) skippedCellRefs.add(cell.timeRef);
          }
        }
      }
    }

    const dataComparison = compareBlockWithExistingData(blk, categoryResolution.categories, {
      studentId: selectedStudent ? selectedStudent.id : null,
      seriesId: effectiveSeriesId || null,
      seriesName: selectedSeriesObj ? selectedSeriesObj.name : null,
      existingStudentRounds,
      existingResults,
      roundCategories,
    });

    blockReports.push({
      blockNumber: blk.blockNumber,
      suggestion,
      headerMeta,
      seriesId: effectiveSeriesId || '',
      seriesName: selectedSeriesObj ? selectedSeriesObj.name : null,
      confirmed,
      duplicateSeriesError: false,
      categoryResolution,
      dataComparison,
    });
  }

  // 2. Validate series selections across blocks (unselected, unconfirmed, or duplicate series)
  const seriesValidation = validateBlockSeriesSelections(blockSelectionList, roundSeries);
  const dupSet = new Set(seriesValidation.duplicateSeriesIds);
  for (const rep of blockReports) {
    if (rep.seriesId && dupSet.has(rep.seriesId)) {
      rep.duplicateSeriesError = true;
    }
  }

  // 3. Aggregate overall comparison metrics across all blocks
  const overallComparison = {
    rounds: {
      totalInSheet: 0,
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
      emptyCells: 0,
      skippedCells: 0,
      unreadableCells: 0,
      unresolvedCategoryCells: 0,
    },
  };

  for (const rep of blockReports) {
    const rc = rep.dataComparison.summaryCounts.rounds;
    const cc = rep.dataComparison.summaryCounts.cells;

    overallComparison.rounds.totalInSheet += rc.totalInSheet;
    overallComparison.rounds.newRounds += rc.newRounds;
    overallComparison.rounds.existingIdentical += rc.existingIdentical;
    overallComparison.rounds.existingAddsCells += rc.existingAddsCells;
    overallComparison.rounds.existingWithConflicts += rc.existingWithConflicts;
    overallComparison.rounds.dbOnlyRounds += rc.dbOnlyRounds;

    overallComparison.cells.newCells += cc.newCells;
    overallComparison.cells.identicalCells += cc.identicalCells;
    overallComparison.cells.conflictCells += cc.conflictCells;
    overallComparison.cells.protectedConflictCells += cc.protectedConflictCells;
    overallComparison.cells.dbOnlyCells += cc.dbOnlyCells;
    overallComparison.cells.emptyCells += cc.emptyCells;
    overallComparison.cells.skippedCells += cc.skippedCells;
    overallComparison.cells.unreadableCells += cc.unreadableCells;
    overallComparison.cells.unresolvedCategoryCells += cc.unresolvedCategoryCells;
  }

  // 4. Build combined Needs Attention list (merging 4c-1 parser items with 4c-2a series/category/comparison items)
  // Filter out generic 4c-1 `unmatched_category` warnings and any unreadable cell warning/error on a skipped category
  const unreadableItemTypes = new Set([
    'unreadable_cell',
    'unreadable_score',
    'unreadable_time',
    'time_without_score',
  ]);
  const baseAttention = (parsed.needsAttention || []).filter((item) => {
    if (item.type === 'unmatched_category') return false;
    if (unreadableItemTypes.has(item.type) && item.ref && skippedCellRefs.has(item.ref)) {
      return false;
    }
    return true;
  });

  const combinedAttention = [...seriesValidation.errors];
  for (const rep of blockReports) {
    combinedAttention.push(...rep.categoryResolution.errors);
    combinedAttention.push(...rep.categoryResolution.warnings);
    combinedAttention.push(...rep.dataComparison.warnings);
    combinedAttention.push(...rep.dataComparison.infos);
  }
  combinedAttention.push(...baseAttention);

  return {
    ok: true,
    blockReports,
    seriesValidation,
    overallComparison,
    combinedAttention,
  };
}

/**
 * Splits an array of round payloads into chunks satisfying `admin_import_rounds` limits:
 * - 1 to `maxRoundsPerCall` (100) rounds per call
 * - At most `maxCellsPerCall` (3000) cells per call
 *
 * @param {Array<{round_number: number, round_date: string, round_type: string, time_taken_seconds: number|null, cells: Array<Object>}>} rounds
 * @param {Object} [options={}]
 * @param {number} [options.maxRoundsPerCall=100]
 * @param {number} [options.maxCellsPerCall=3000]
 * @returns {Array<Array<Object>>} Array of round chunks
 */
export function chunkRoundsForImport(rounds = [], options = {}) {
  const maxRounds = Math.max(1, Number(options.maxRoundsPerCall) || MAX_ROUNDS_PER_RPC_CALL);
  const maxCells = Math.max(1, Number(options.maxCellsPerCall) || MAX_CELLS_PER_RPC_CALL);

  if (!Array.isArray(rounds) || rounds.length === 0) {
    return [];
  }

  const chunks = [];
  let currentChunk = [];
  let currentCells = 0;

  for (const rnd of rounds) {
    const rndCellsCount = Array.isArray(rnd.cells) ? rnd.cells.length : 0;

    if (
      currentChunk.length > 0 &&
      (currentChunk.length + 1 > maxRounds || currentCells + rndCellsCount > maxCells)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCells = 0;
    }

    currentChunk.push(rnd);
    currentCells += rndCellsCount;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Database limit constants for `admin_import_rounds`
 */
export const DB_MAX_ROUND_NUMBER = 100000;
export const DB_MIN_ROUND_DATE_ISO = '2020-01-01';
export const DB_MAX_ROUND_TYPE_LEN = 40;
export const DB_MAX_ROUND_TIME_TAKEN_SECONDS = 28800; // 8:00:00
export const DB_MAX_CELL_TIME_SECONDS = 14400; // 4:00:00
export const DB_MAX_NOTE_LEN = 500;

/**
 * Validates a round import payload (either an array of rounds for `admin_import_rounds`,
 * an object `{ rounds }` / `{ p_rounds }`, or a full execution plan `{ blockPlans }`)
 * against all PostgreSQL `admin_import_rounds` constraints before calling the database.
 *
 * Returns a list of problems where each item names `round_number`, `field`, and `value`.
 * If the returned array is non-empty, the caller MUST NOT call the database.
 *
 * @param {Array<Object>|Object} payload
 * @param {Object} [options={}]
 * @param {string} [options.todayIST] - YYYY-MM-DD in Asia/Kolkata
 * @returns {Array<{round_number: number|null, roundNumber: number|null, field: string, value: any, message: string}>}
 */
export function validatePayload(payload, options = {}) {
  const todayIST =
    options.todayIST ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

  const problems = [];

  const pushProblem = (roundNum, field, value, message) => {
    problems.push({
      round_number: roundNum ?? null,
      roundNumber: roundNum ?? null,
      field,
      value,
      message,
    });
  };

  // Support validating a full execution plan with multiple chunks/blockPlans
  if (payload && !Array.isArray(payload) && Array.isArray(payload.blockPlans)) {
    for (const bp of payload.blockPlans) {
      const chunks = Array.isArray(bp.chunks)
        ? bp.chunks
        : chunkRoundsForImport(bp.rounds || []);
      for (const ch of chunks) {
        const subProblems = validatePayload(ch, { todayIST });
        problems.push(...subProblems);
      }
    }
    return problems;
  }

  const rounds = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.p_rounds)
    ? payload.p_rounds
    : Array.isArray(payload?.rounds)
    ? payload.rounds
    : null;

  if (!Array.isArray(rounds) || rounds.length === 0) {
    pushProblem(
      null,
      'rounds',
      rounds ? rounds.length : payload,
      'Payload must contain between 1 and 100 rounds.'
    );
    return problems;
  }

  if (rounds.length > MAX_ROUNDS_PER_RPC_CALL) {
    pushProblem(
      null,
      'rounds',
      rounds.length,
      `Payload has ${rounds.length} rounds, exceeding the maximum of ${MAX_ROUNDS_PER_RPC_CALL} rounds per call.`
    );
  }

  let totalCellsInCall = 0;

  for (const rnd of rounds) {
    const rNum = rnd?.round_number ?? null;

    // 1. round_number: integer 1 to 100000
    if (!Number.isInteger(rNum) || rNum < 1 || rNum > DB_MAX_ROUND_NUMBER) {
      pushProblem(
        rNum,
        'round_number',
        rNum,
        `Round ${rNum ?? '?'}: round_number (${rNum}) must be an integer from 1 to ${DB_MAX_ROUND_NUMBER}.`
      );
    }

    // 2. round_date: YYYY-MM-DD between 2020-01-01 and today_ist()
    const rDate = rnd?.round_date ?? null;
    const isIsoFormat = typeof rDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rDate);
    if (!isIsoFormat || rDate < DB_MIN_ROUND_DATE_ISO || rDate > todayIST) {
      pushProblem(
        rNum,
        'round_date',
        rDate,
        `Round ${rNum ?? '?'}: round_date (${rDate}) must be YYYY-MM-DD between ${DB_MIN_ROUND_DATE_ISO} and ${todayIST}.`
      );
    }

    // 3. round_type: string, at most 40 characters
    const rType = rnd?.round_type;
    if (typeof rType !== 'string' || rType.trim().length === 0 || rType.length > DB_MAX_ROUND_TYPE_LEN) {
      pushProblem(
        rNum,
        'round_type',
        rType,
        `Round ${rNum ?? '?'}: round_type (${JSON.stringify(rType)}) must be 1 to ${DB_MAX_ROUND_TYPE_LEN} characters.`
      );
    }

    // 4. time_taken_seconds: null or integer 0 to 28800
    const rTime = rnd?.time_taken_seconds;
    if (
      rTime !== null &&
      rTime !== undefined &&
      (!Number.isInteger(rTime) || rTime < 0 || rTime > DB_MAX_ROUND_TIME_TAKEN_SECONDS)
    ) {
      pushProblem(
        rNum,
        'time_taken_seconds',
        rTime,
        `Round ${rNum ?? '?'}: time_taken_seconds (${rTime}) must be null or 0 to ${DB_MAX_ROUND_TIME_TAKEN_SECONDS}.`
      );
    }

    // 5. Cells validation
    const cells = Array.isArray(rnd?.cells) ? rnd.cells : [];
    totalCellsInCall += cells.length;

    const seenCategoryIds = new Set();

    for (const cell of cells) {
      // 5a. category_id present and at most once per round
      const catId = cell?.category_id ?? null;
      if (!catId || typeof catId !== 'string') {
        pushProblem(
          rNum,
          'category_id',
          catId,
          `Round ${rNum ?? '?'}: cell is missing a valid category_id.`
        );
      } else if (seenCategoryIds.has(catId)) {
        pushProblem(
          rNum,
          'category_id',
          catId,
          `Round ${rNum ?? '?'}: duplicate category_id "${catId}" in the same round.`
        );
      } else {
        seenCategoryIds.add(catId);
      }

      // 5b. correct and total both present (0 <= correct <= total, total >= 1), or both absent with a note (<= 500 chars)
      const hasCorrect = cell?.correct !== null && cell?.correct !== undefined;
      const hasTotal = cell?.total !== null && cell?.total !== undefined;
      const hasNote = typeof cell?.note === 'string' && cell.note.trim().length > 0;

      if (cell?.note !== null && cell?.note !== undefined) {
        if (typeof cell.note !== 'string' || cell.note.length > DB_MAX_NOTE_LEN) {
          pushProblem(
            rNum,
            'note',
            cell.note,
            `Round ${rNum ?? '?'}: cell note exceeds ${DB_MAX_NOTE_LEN} characters.`
          );
        }
      }

      if (hasCorrect && hasTotal) {
        if (!Number.isInteger(cell.total) || cell.total < 1) {
          pushProblem(
            rNum,
            'total',
            cell.total,
            `Round ${rNum ?? '?'}: cell total (${cell.total}) must be an integer >= 1.`
          );
        }
        if (
          !Number.isInteger(cell.correct) ||
          cell.correct < 0 ||
          (Number.isInteger(cell.total) && cell.total >= 1 && cell.correct > cell.total)
        ) {
          pushProblem(
            rNum,
            'correct',
            cell.correct,
            `Round ${rNum ?? '?'}: cell correct (${cell.correct}) must be between 0 and total (${cell.total}).`
          );
        }
      } else if (!hasCorrect && !hasTotal) {
        if (!hasNote) {
          pushProblem(
            rNum,
            'note',
            cell?.note ?? null,
            `Round ${rNum ?? '?'}: cell without correct/total scores must have a non-empty note.`
          );
        }
      } else {
        // One of correct/total is present and the other is absent
        if (!hasCorrect) {
          pushProblem(
            rNum,
            'correct',
            cell?.correct ?? null,
            `Round ${rNum ?? '?'}: cell has total (${cell.total}) but correct is missing.`
          );
        } else {
          pushProblem(
            rNum,
            'total',
            cell?.total ?? null,
            `Round ${rNum ?? '?'}: cell has correct (${cell.correct}) but total is missing.`
          );
        }
      }

      // 5c. time_seconds: null or integer 0 to 14400
      const cTime = cell?.time_seconds;
      if (
        cTime !== null &&
        cTime !== undefined &&
        (!Number.isInteger(cTime) || cTime < 0 || cTime > DB_MAX_CELL_TIME_SECONDS)
      ) {
        pushProblem(
          rNum,
          'time_seconds',
          cTime,
          `Round ${rNum ?? '?'}: cell time_seconds (${cTime}) must be null or 0 to ${DB_MAX_CELL_TIME_SECONDS}.`
        );
      }
    }
  }

  if (totalCellsInCall > MAX_CELLS_PER_RPC_CALL) {
    pushProblem(
      null,
      'cells',
      totalCellsInCall,
      `Payload has ${totalCellsInCall} cells, exceeding the maximum of ${MAX_CELLS_PER_RPC_CALL} cells per call.`
    );
  }

  return problems;
}

/**
 * Builds the complete Phase 4c-2b / 4c-2c execution plan for saving a parsed and resolved CSV import.
 *
 * Mirrors all database limits:
 * - Time Taken > 28,800s -> warning + `time_taken_seconds = null` in payload + counted in `acknowledgments`.
 * - Cell time > 14,400s -> unreadable cell (not imported) + counted in `acknowledgments`.
 * - Note > 500 chars -> cut to 500 chars with a warning.
 * - Round type > 40 chars -> cut to 40 chars with a warning.
 * - Any round breaking round_number (1..100000), round_date (2020-01-01..today_ist()), or missing/unreadable date
 *   is excluded (`excludedRounds`) instead of failing the whole import.
 *
 * @param {Object} parsed - Output from `parseScoreSheetCsv`
 * @param {Object} previewState - Output from `buildImportPreviewState`
 * @param {Object} [options={}]
 * @param {Object|null} [options.selectedStudent=null]
 * @param {string} [options.fileName='']
 * @param {boolean} [options.markVerified=false]
 * @param {'skip'|'use_existing'} [options.onDateConflict='use_existing']
 * @param {string} [options.todayIST]
 * @returns {Object} Structured execution plan
 */
export function buildImportExecutionPlan(parsed, previewState, options = {}) {
  const {
    selectedStudent = null,
    fileName = '',
    markVerified = false,
    onDateConflict = 'use_existing',
  } = options;

  const todayIST =
    options.todayIST ||
    parsed?.todayIST ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

  const normalizedConflictPolicy = onDateConflict === 'skip' ? 'skip' : 'use_existing';
  const blockingReasons = [];

  if (!parsed || !parsed.ok || !previewState || !previewState.ok) {
    blockingReasons.push('No valid score sheet is currently loaded.');
    return {
      readyToImport: false,
      blockingReasons,
      studentId: null,
      fileName: String(fileName || ''),
      nameInFile: null,
      studentNameMismatch: false,
      markVerified: Boolean(markVerified),
      onDateConflict: normalizedConflictPolicy,
      rowsFound: 0,
      totalRounds: 0,
      excludedRounds: [],
      acknowledgments: [],
      acknowledgmentCounts: {
        timeTakenOverLimit: 0,
        unreadableCellsSkipped: 0,
        roundTypesTruncated: 0,
        notesTruncated: 0,
        excludedRounds: 0,
      },
      blockPlans: [],
      summaryPayload: {},
    };
  }

  if (!selectedStudent || !selectedStudent.id) {
    blockingReasons.push('No student is selected in Step 1.');
  }

  // Sheet-level and block-level blocking errors:
  // - Series unconfirmed / missing / duplicated across blocks
  // - Duplicate category target within a block
  // - Mixed date formats in Auto mode
  // Note: Per-round date/number limit violations exclude that round (`excludedRounds`),
  // and unreadable cells are skipped (`unreadableCellsSkipped`), rather than failing the whole import.
  const roundExclusionErrorTypes = new Set([
    'missing_date',
    'unreadable_date',
    'future_date',
    'before_2020',
    'round_excluded',
    'unreadable_score',
    'unreadable_time',
    'time_without_score',
    'unreadable_cell',
  ]);

  const attentionErrors = (previewState.combinedAttention || []).filter(
    (item) => item.severity === 'error' && !roundExclusionErrorTypes.has(item.type)
  );
  for (const err of attentionErrors) {
    blockingReasons.push(err.message);
  }

  // Also check if any block still has unresolved `unmatched` categories
  for (const rep of previewState.blockReports || []) {
    for (const cat of rep.categoryResolution?.categories || []) {
      if (cat.effectiveStatus === 'unmatched') {
        blockingReasons.push(
          `Block ${rep.blockNumber}: Category "${cat.sheetName}" (${cat.ref}) is still unmatched. Choose a target category, "Create as historical", or "Skip".`
        );
      }
    }
  }

  // Build per-block plans, tracking excluded rounds and acknowledgment counts
  const blockPlans = [];
  const excludedRounds = [];
  const acknowledgmentCounts = {
    timeTakenOverLimit: 0,
    unreadableCellsSkipped: 0,
    roundTypesTruncated: 0,
    notesTruncated: 0,
    excludedRounds: 0,
  };

  let totalRowsFound = 0;
  let totalRoundsCount = 0;
  let hasDateConflictsWithDb = false;

  for (const blk of parsed.blocks || []) {
    const rep = (previewState.blockReports || []).find((r) => r.blockNumber === blk.blockNumber);
    if (!rep) continue;

    const resolvedByRowIndex = new Map(
      (rep.categoryResolution?.categories || []).map((c) => [c.rowIndex, c])
    );

    // 1. Categories to ensure via `admin_import_ensure_category`
    const categoriesToEnsure = [];
    // 2. Aliases to save in `category_aliases`
    const aliasesToSave = [];

    for (const cat of rep.categoryResolution?.categories || []) {
      if (cat.effectiveStatus === 'skipped' || cat.effectiveStatus === 'unmatched') {
        continue;
      }

      if (cat.effectiveStatus === 'create_historical') {
        categoriesToEnsure.push({
          rowIndex: cat.rowIndex,
          rawKey: cat.rawKey,
          sheetName: cat.sheetName,
          mode: 'create_historical',
          p_category: null,
          p_new_name: cat.sheetName,
        });
      } else if (cat.resolvedCategory?.id) {
        if (cat.inSelectedSeries === false || cat.effectiveStatus === 'mapped_existing') {
          categoriesToEnsure.push({
            rowIndex: cat.rowIndex,
            rawKey: cat.rawKey,
            sheetName: cat.sheetName,
            mode: 'link_existing',
            p_category: cat.resolvedCategory.id,
            p_new_name: null,
          });
        }

        if (cat.effectiveStatus === 'mapped_existing' && cat.saveAlias !== false) {
          aliasesToSave.push({
            alias: cat.rawKey,
            category_id: cat.resolvedCategory.id,
            sheetName: cat.sheetName,
            targetCategoryName: cat.resolvedCategory.name,
            rowIndex: cat.rowIndex,
          });
        }
      }
    }

    // 3. Build planned rounds and cells for this block, excluding rounds that break DB limits
    const plannedRounds = [];
    const blockExcludedRounds = [];
    let blockCellsCount = 0;

    for (const rnd of blk.rounds || []) {
      const rNum = Number(rnd.roundNumber);
      const rDate = rnd.dateISO;

      // Check round-level limits: round_number 1..100000 and round_date YYYY-MM-DD in 2020-01-01..todayIST
      let exclusionReason = null;
      if (!Number.isInteger(rNum) || rNum < 1 || rNum > DB_MAX_ROUND_NUMBER) {
        exclusionReason = `Round number ${rnd.roundNumber} is outside 1..100,000`;
      } else if (!rDate || !/^\d{4}-\d{2}-\d{2}$/.test(rDate)) {
        exclusionReason = rnd.dateError || `Missing or unreadable round date (${rnd.rawDate || 'empty'})`;
      } else if (rDate < DB_MIN_ROUND_DATE_ISO) {
        exclusionReason = `Round date ${rDate} is before ${DB_MIN_ROUND_DATE_ISO}`;
      } else if (rDate > todayIST) {
        exclusionReason = `Round date ${rDate} is after today (${todayIST})`;
      } else if (rnd.excluded) {
        exclusionReason = rnd.exclusionReason || 'Excluded due to round limit';
      }

      if (exclusionReason) {
        const exItem = {
          blockNumber: blk.blockNumber,
          seriesId: rep.seriesId,
          seriesName: rep.seriesName,
          roundNumber: rNum,
          dateISO: rDate,
          rawDate: rnd.rawDate || '',
          ref: rnd.dateRef || rnd.headerRef || null,
          reason: exclusionReason,
        };
        blockExcludedRounds.push(exItem);
        excludedRounds.push(exItem);
        acknowledgmentCounts.excludedRounds += 1;
        continue;
      }

      if (rnd.summary?.timeTakenOverLimit) {
        acknowledgmentCounts.timeTakenOverLimit += 1;
      }
      if (rnd.summary?.roundTypeTruncated) {
        acknowledgmentCounts.roundTypesTruncated += 1;
      }

      const rComp = (rep.dataComparison?.rounds || []).find(
        (rc) => Number(rc.roundNumber) === rNum
      );
      if (rComp && (rComp.dateDiffers || (rComp.sameDateOtherDbRounds || []).length > 0)) {
        hasDateConflictsWithDb = true;
      }

      const cells = [];
      for (const cell of rnd.cells || []) {
        const catRes = resolvedByRowIndex.get(cell.rowIndex);
        if (!catRes || catRes.effectiveStatus === 'skipped' || catRes.effectiveStatus === 'unmatched') {
          continue;
        }
        if (cell.status === 'unreadable') {
          acknowledgmentCounts.unreadableCellsSkipped += 1;
          continue;
        }
        if (cell.status !== 'ok' && cell.status !== 'note') {
          continue;
        }

        // Enforce cell time <= 14400s
        if (
          cell.timeSeconds !== null &&
          cell.timeSeconds !== undefined &&
          (Number(cell.timeSeconds) < 0 || Number(cell.timeSeconds) > DB_MAX_CELL_TIME_SECONDS)
        ) {
          acknowledgmentCounts.unreadableCellsSkipped += 1;
          continue;
        }

        let noteVal = cell.note ? String(cell.note) : null;
        if (noteVal && noteVal.length > DB_MAX_NOTE_LEN) {
          noteVal = noteVal.slice(0, DB_MAX_NOTE_LEN);
          acknowledgmentCounts.notesTruncated += 1;
        } else if (cell.noteTruncated) {
          acknowledgmentCounts.notesTruncated += 1;
        }

        cells.push({
          rowIndex: cell.rowIndex,
          rawKey: catRes.rawKey,
          category_id: catRes.resolvedCategory?.id || null,
          correct: cell.status === 'ok' ? Number(cell.correct) : null,
          total: cell.status === 'ok' ? Number(cell.total) : null,
          time_seconds:
            cell.timeSeconds !== null && cell.timeSeconds !== undefined
              ? Number(cell.timeSeconds)
              : null,
          note: noteVal,
        });
      }

      // Sanitize round_type (max 40 chars) and time_taken_seconds (null if > 28800 or < 0)
      let rawRoundType = rnd.summary?.roundType ? String(rnd.summary.roundType).trim() : 'Category wise';
      if (!rawRoundType) rawRoundType = 'Category wise';
      if (rawRoundType.length > DB_MAX_ROUND_TYPE_LEN) {
        rawRoundType = rawRoundType.slice(0, DB_MAX_ROUND_TYPE_LEN);
        if (!rnd.summary?.roundTypeTruncated) {
          acknowledgmentCounts.roundTypesTruncated += 1;
        }
      }

      let sanitizedTimeTaken =
        rnd.summary?.timeTakenSeconds !== null && rnd.summary?.timeTakenSeconds !== undefined
          ? Number(rnd.summary.timeTakenSeconds)
          : null;
      if (
        sanitizedTimeTaken !== null &&
        (!Number.isInteger(sanitizedTimeTaken) ||
          sanitizedTimeTaken < 0 ||
          sanitizedTimeTaken > DB_MAX_ROUND_TIME_TAKEN_SECONDS)
      ) {
        sanitizedTimeTaken = null;
        if (!rnd.summary?.timeTakenOverLimit) {
          acknowledgmentCounts.timeTakenOverLimit += 1;
        }
      }

      blockCellsCount += cells.length;
      plannedRounds.push({
        round_number: rNum,
        round_date: rDate,
        round_type: rawRoundType,
        time_taken_seconds: sanitizedTimeTaken,
        cells,
      });
    }

    totalRowsFound += blockCellsCount;
    totalRoundsCount += plannedRounds.length;

    blockPlans.push({
      blockNumber: blk.blockNumber,
      seriesId: rep.seriesId,
      seriesName: rep.seriesName,
      categoriesToEnsure,
      aliasesToSave,
      rounds: plannedRounds,
      excludedRounds: blockExcludedRounds,
      totalCells: blockCellsCount,
    });
  }

  if (totalRoundsCount === 0) {
    blockingReasons.push('No valid rounds found to import.');
  }

  // Build human-readable acknowledgment items with their counts
  const acknowledgments = [];
  if (acknowledgmentCounts.timeTakenOverLimit > 0) {
    acknowledgments.push({
      type: 'time_taken_over_limit',
      count: acknowledgmentCounts.timeTakenOverLimit,
      label: `${acknowledgmentCounts.timeTakenOverLimit} round${
        acknowledgmentCounts.timeTakenOverLimit === 1 ? '' : 's'
      } with total time over 8 hours will be imported WITHOUT a total time`,
    });
  }
  if (acknowledgmentCounts.unreadableCellsSkipped > 0) {
    acknowledgments.push({
      type: 'unreadable_cells_skipped',
      count: acknowledgmentCounts.unreadableCellsSkipped,
      label: `${acknowledgmentCounts.unreadableCellsSkipped} unreadable cell${
        acknowledgmentCounts.unreadableCellsSkipped === 1 ? '' : 's'
      } will not be imported`,
    });
  }
  if (acknowledgmentCounts.roundTypesTruncated > 0) {
    acknowledgments.push({
      type: 'round_types_truncated',
      count: acknowledgmentCounts.roundTypesTruncated,
      label: `${acknowledgmentCounts.roundTypesTruncated} round type${
        acknowledgmentCounts.roundTypesTruncated === 1 ? '' : 's'
      } longer than 40 characters will be cut to 40 characters`,
    });
  }
  if (acknowledgmentCounts.notesTruncated > 0) {
    acknowledgments.push({
      type: 'notes_truncated',
      count: acknowledgmentCounts.notesTruncated,
      label: `${acknowledgmentCounts.notesTruncated} note${
        acknowledgmentCounts.notesTruncated === 1 ? '' : 's'
      } longer than 500 characters will be cut to 500 characters`,
    });
  }
  if (acknowledgmentCounts.excludedRounds > 0) {
    acknowledgments.push({
      type: 'excluded_rounds',
      count: acknowledgmentCounts.excludedRounds,
      label: `${acknowledgmentCounts.excludedRounds} round${
        acknowledgmentCounts.excludedRounds === 1 ? '' : 's'
      } breaking date or round number limits will be excluded`,
    });
  }

  const nameInFile = parsed.primaryStudentName ? String(parsed.primaryStudentName).trim() : null;
  const studentNameMismatch = Boolean(
    selectedStudent &&
      nameInFile &&
      nameInFile.toLowerCase() !== String(selectedStudent.full_name || '').trim().toLowerCase()
  );

  const summaryPayload = {
    blocks: blockPlans.map((bp) => ({
      block_number: bp.blockNumber,
      series_id: bp.seriesId,
      series_name: bp.seriesName,
      rounds_count: bp.rounds.length,
      excluded_rounds_count: bp.excludedRounds.length,
      cells_count: bp.totalCells,
      categories_ensured: bp.categoriesToEnsure.length,
      aliases_saved: bp.aliasesToSave.length,
    })),
    date_format: parsed.resolvedDateFormat || 'DD/MM',
    on_date_conflict: normalizedConflictPolicy,
    mark_verified: Boolean(markVerified),
    planned_rounds: totalRoundsCount,
    excluded_rounds: excludedRounds.length,
    planned_cells: totalRowsFound,
    acknowledgments: acknowledgmentCounts,
    comparison: previewState.overallComparison
      ? {
          new_rounds: previewState.overallComparison.rounds.newRounds,
          existing_identical_rounds: previewState.overallComparison.rounds.existingIdentical,
          existing_adds_cells_rounds: previewState.overallComparison.rounds.existingAddsCells,
          existing_conflict_rounds: previewState.overallComparison.rounds.existingWithConflicts,
          new_cells: previewState.overallComparison.cells.newCells,
          identical_cells: previewState.overallComparison.cells.identicalCells,
          conflict_cells: previewState.overallComparison.cells.conflictCells,
          protected_conflict_cells: previewState.overallComparison.cells.protectedConflictCells,
        }
      : null,
  };

  return {
    readyToImport: blockingReasons.length === 0,
    blockingReasons,
    studentId: selectedStudent ? selectedStudent.id : null,
    studentName: selectedStudent ? selectedStudent.full_name : null,
    studentCode: selectedStudent ? selectedStudent.student_code : null,
    fileName: String(fileName || 'scoresheet.csv'),
    nameInFile,
    studentNameMismatch,
    hasDateConflictsWithDb,
    markVerified: Boolean(markVerified),
    onDateConflict: normalizedConflictPolicy,
    rowsFound: totalRowsFound,
    totalRounds: totalRoundsCount,
    excludedRounds,
    acknowledgments,
    acknowledgmentCounts,
    blockPlans,
    summaryPayload,
  };
}

/**
 * Materializes clean round chunks for a single block after `admin_import_ensure_category`
 * has resolved any newly created historical categories or linked existing categories.
 *
 * Each round in each returned chunk has the exact shape required by `admin_import_rounds`:
 * `{ round_number, round_date, round_type, time_taken_seconds, cells: [{ category_id, correct, total, time_seconds, note }] }`
 *
 * @param {Object} blockPlan - Single element from `buildImportExecutionPlan().blockPlans`
 * @param {Map<number, string>|Object} [ensuredCategoryByRowIndex] - Map or object mapping `rowIndex -> category_id`
 * @param {Object} [chunkOptions={}] - Optional `{ maxRoundsPerCall, maxCellsPerCall }`
 * @returns {Array<Array<Object>>} Array of round chunks ready for `admin_import_rounds`
 */
export function materializeBlockRoundChunks(
  blockPlan,
  ensuredCategoryByRowIndex = new Map(),
  chunkOptions = {}
) {
  const getEnsuredId = (rowIndex) => {
    if (ensuredCategoryByRowIndex instanceof Map) {
      return ensuredCategoryByRowIndex.get(rowIndex) || null;
    }
    if (ensuredCategoryByRowIndex && typeof ensuredCategoryByRowIndex === 'object') {
      return ensuredCategoryByRowIndex[rowIndex] || null;
    }
    return null;
  };

  const cleanRounds = (blockPlan?.rounds || []).map((rnd) => {
    const cleanCells = (rnd.cells || []).map((cell) => {
      const catId = getEnsuredId(cell.rowIndex) || cell.category_id;
      if (!catId) {
        throw new Error(
          `Missing category_id for cell in Block ${blockPlan.blockNumber}, Round ${rnd.round_number} (row ${cell.rowIndex}).`
        );
      }
      return {
        category_id: catId,
        correct: cell.correct ?? null,
        total: cell.total ?? null,
        time_seconds: cell.time_seconds ?? null,
        note: cell.note ?? null,
      };
    });

    return {
      round_number: Number(rnd.round_number),
      round_date: rnd.round_date,
      round_type: rnd.round_type || 'Category wise',
      time_taken_seconds: rnd.time_taken_seconds ?? null,
      cells: cleanCells,
    };
  });

  return chunkRoundsForImport(cleanRounds, chunkOptions);
}

