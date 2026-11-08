/**
 * Trendz Tracker - Main Round Scoresheet Engine (js/roundScoresheet.js)
 *
 * Implements the Excel-like scoresheet for Main Round:
 * 1. Filter by source: 'both' | 'manual' | 'online'
 * 2. Filter by date: 'last7' | 'last30' | 'all' | 'single' | 'range' (Strict India Time)
 * 3. Matrix view models:
 *    - Categories as rows (authoritative order)
 *    - Rounds / attempts as columns
 *    - Strict separation of incompatible scoring units (Manual counts vs Online marks)
 *    - Distinct zero score (0), missing (—), and incomplete round handling
 * 4. Mobile-friendly zoom, horizontal/vertical scrolling, sticky headers, clean capture view
 * 5. Standalone PDF 1.4 generator & HTML5 Canvas image exporter with column pagination
 * 6. Native device file sharing with automatic download fallback
 * 7. Scoped strictly to permitted student records
 */

import {
  getISTDateString,
  formatDisplayDateIST,
  formatSecondsToTime,
} from './stats.js';
import {
  formatActiveDurationMs,
  formatJmcwcGroupLabel,
  formatJmcwcCategoryTitle,
  JMCWC_CATEGORY_TITLES,
} from './jmcwcClient.js';
import { isFlatRound } from './roundType.js';

// =============================================================================
// CONSTANTS & CANONICAL JMCWC CATEGORIES
// =============================================================================

export const AUTHORITATIVE_JMCWC_CATEGORIES = Object.freeze([
  { key: 'addition', label: 'Integer addition', position: 1 },
  { key: 'subtraction', label: 'Integer subtraction', position: 2 },
  { key: 'mixed', label: 'Mixed addition and subtraction', position: 3 },
  { key: 'multiplication', label: 'Integer multiplication', position: 4 },
  { key: 'division', label: 'Integer division', position: 5 },
  { key: 'brackets', label: 'Brackets', position: 6 },
  { key: 'prime_factors', label: 'Prime factorisation', position: 7 },
  { key: 'hcf_lcm', label: 'HCF and LCM', position: 8 },
  { key: 'fraction_add', label: 'Fraction addition', position: 9 },
  { key: 'fraction_sub', label: 'Fraction subtraction', position: 10 },
  { key: 'fraction_mul', label: 'Fraction multiplication', position: 11 },
  { key: 'fraction_div', label: 'Fraction division', position: 12 },
  { key: 'approximation', label: 'Approximations', position: 13 },
  { key: 'remainder', label: 'Remainders', position: 14 },
  { key: 'ratio', label: 'Ratios', position: 15 },
  { key: 'square_root', label: 'Perfect square roots', position: 16 },
  { key: 'inexact_square_root', label: 'Inexact square roots', position: 17 },
  { key: 'next_square', label: 'Next squares', position: 18 },
  { key: 'cube_root', label: 'Exact cube roots', position: 19 },
  { key: 'next_cube', label: 'Next cubes', position: 20 },
  { key: 'calendar', label: 'Calendars', position: 21 },
  { key: 'elapsed_time', label: 'Elapsed time', position: 22 },
  { key: 'sum_squares', label: 'Sums of squares', position: 23 },
]);

export const SCORESHEET_SOURCE_FILTERS = Object.freeze(['both', 'manual', 'online']);
export const SCORESHEET_DATE_PRESETS = Object.freeze(['last7', 'last30', 'all', 'single', 'range']);

// =============================================================================
// DATE & TIME UTILITIES (STRICT INDIA TIME)
// =============================================================================

/**
 * Shifts a YYYY-MM-DD IST calendar date backwards by daysBack days.
 * Pure calendar date arithmetic avoids any DST or timezone anomalies.
 */
export function getPastISTDate(baseDateStr, daysBack) {
  if (!baseDateStr || typeof baseDateStr !== 'string') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(baseDateStr.trim());
  if (!match) return '';
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const targetUtcMs = Date.UTC(y, m - 1, d) - daysBack * 86400000;
  const target = new Date(targetUtcMs);
  const targetY = target.getUTCFullYear();
  const targetM = String(target.getUTCMonth() + 1).padStart(2, '0');
  const targetD = String(target.getUTCDate()).padStart(2, '0');
  return `${targetY}-${targetM}-${targetD}`;
}

/**
 * Resolves date boundaries for the given preset and inputs in India Time.
 * Presets include today: today plus previous 6 or 29 dates.
 */
export function resolveDateFilterBounds(preset, todayIST, customFrom = null, customTo = null) {
  const baseToday = todayIST && typeof todayIST === 'string' && /^\d{4}-\d{2}-\d{2}/.test(todayIST)
    ? todayIST.slice(0, 10)
    : getISTDateString(new Date());

  if (preset === 'last7') {
    return {
      preset,
      startDate: getPastISTDate(baseToday, 6),
      endDate: baseToday,
      error: null,
    };
  }

  if (preset === 'last30') {
    return {
      preset,
      startDate: getPastISTDate(baseToday, 29),
      endDate: baseToday,
      error: null,
    };
  }

  if (preset === 'all') {
    return {
      preset,
      startDate: null,
      endDate: null,
      error: null,
    };
  }

  if (preset === 'single') {
    if (!customFrom) {
      return {
        preset,
        startDate: null,
        endDate: null,
        error: 'Please choose a date.',
      };
    }
    const cleanDate = String(customFrom).trim().slice(0, 10);
    return {
      preset,
      startDate: cleanDate,
      endDate: cleanDate,
      error: null,
    };
  }

  if (preset === 'range') {
    if (!customFrom || !customTo) {
      return {
        preset,
        startDate: null,
        endDate: null,
        error: 'Please choose both start and end dates.',
      };
    }
    const fromStr = String(customFrom).trim().slice(0, 10);
    const toStr = String(customTo).trim().slice(0, 10);
    if (fromStr > toStr) {
      return {
        preset,
        startDate: null,
        endDate: null,
        error: 'Start date cannot be after end date.',
      };
    }
    return {
      preset,
      startDate: fromStr,
      endDate: toStr,
      error: null,
    };
  }

  // Fallback to last7
  return {
    preset: 'last7',
    startDate: getPastISTDate(baseToday, 6),
    endDate: baseToday,
    error: null,
  };
}

/**
 * Formats a user-friendly label for the selected date period.
 */
export function formatScoresheetPeriodLabel(filterBounds) {
  if (!filterBounds) return 'All time';
  if (filterBounds.error) return 'Invalid date range';
  const { preset, startDate, endDate } = filterBounds;

  if (preset === 'last7') {
    return `Last 7 days (${formatDisplayDateIST(startDate)} – ${formatDisplayDateIST(endDate)} IST)`;
  }
  if (preset === 'last30') {
    return `Last 30 days (${formatDisplayDateIST(startDate)} – ${formatDisplayDateIST(endDate)} IST)`;
  }
  if (preset === 'all') {
    return 'All time';
  }
  if (preset === 'single') {
    return `Date: ${formatDisplayDateIST(startDate)} (IST)`;
  }
  if (preset === 'range') {
    return `${formatDisplayDateIST(startDate)} – ${formatDisplayDateIST(endDate)} (IST)`;
  }
  return 'Custom period';
}

/**
 * Resolves authoritative IST date string (YYYY-MM-DD) for a manual round.
 * Uses round_date directly; never substitutes creation timestamp when round_date is present.
 */
export function getManualRoundDateIST(roundObj) {
  if (roundObj?.round_date) {
    return String(roundObj.round_date).slice(0, 10);
  }
  if (roundObj?.created_at) {
    return getISTDateString(roundObj.created_at);
  }
  return '';
}

/**
 * Resolves authoritative IST date string (YYYY-MM-DD) for an online attempt.
 * Uses finished_at for submitted attempts; falls back to created_at for in-progress.
 */
export function getOnlineAttemptDateIST(attemptObj) {
  if (attemptObj?.finished_at) {
    return getISTDateString(attemptObj.finished_at);
  }
  if (attemptObj?.created_at) {
    return getISTDateString(attemptObj.created_at);
  }
  return '';
}

/**
 * Checks whether a given date (YYYY-MM-DD) falls within [startDate, endDate] inclusive.
 */
export function isDateWithinFilter(dateStr, startDate, endDate) {
  if (!dateStr) return false;
  const clean = String(dateStr).slice(0, 10);
  if (startDate && clean < startDate) return false;
  if (endDate && clean > endDate) return false;
  return true;
}

// =============================================================================
// SHEET & MATRIX MODEL BUILDERS
// =============================================================================

/**
 * Builds an Excel-like sheet for manual round practice records.
 * Uses authoritative category order from category_series.sort_order.
 * Distinguishes zero (0 / total), missing (—), and note-only entries.
 */
export function buildManualScoresheet({
  seriesInfo = {},
  categories = [],
  rounds = [],
  results = [],
}) {
  const seriesName = seriesInfo.name || 'Current series';
  const seriesId = seriesInfo.id || 'current';

  // Map results by `${student_round_id}_${category_id}`
  const resultMap = new Map();
  (results || []).forEach((r) => {
    if (r && r.student_round_id && r.category_id) {
      resultMap.set(`${r.student_round_id}_${r.category_id}`, r);
    }
  });

  // Sort rounds chronologically (Round 1, Round 2, ...) with unique tie-breaker on id
  const sortedRounds = [...rounds].sort((a, b) => {
    const dateA = getManualRoundDateIST(a);
    const dateB = getManualRoundDateIST(b);
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const numDiff = (a.round_number || 0) - (b.round_number || 0);
    if (numDiff !== 0) return numDiff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const orderedCategories = [...categories].sort(
    (a, b) => (a.series_sort_order ?? a.sort_order ?? 0) - (b.series_sort_order ?? b.sort_order ?? 0)
  );

  // Preserve historical/inactive categories present in results but not in orderedCategories
  const presentCategoryIds = new Set(orderedCategories.map((c) => c.id));
  (results || []).forEach((r) => {
    if (r && r.category_id && !presentCategoryIds.has(r.category_id)) {
      if (sortedRounds.some((rnd) => rnd.id === r.student_round_id)) {
        orderedCategories.push({
          id: r.category_id,
          name: r.category_name || r.category?.name || 'Historical Category',
          series_sort_order: 9999,
          active: false,
        });
        presentCategoryIds.add(r.category_id);
      }
    }
  });

  const columns = sortedRounds.map((r) => {
    const dateStr = getManualRoundDateIST(r);
    const roundType = r.round_type || 'Category wise';
    let enteredCount = 0;
    orderedCategories.forEach((c) => {
      if (resultMap.has(`${r.id}_${c.id}`)) enteredCount++;
    });
    const isEmpty = enteredCount === 0;
    const isPartial = enteredCount > 0 && enteredCount < orderedCategories.length;

    return {
      id: r.id,
      roundNumber: r.round_number,
      label: `Round ${r.round_number}`,
      dateStr,
      displayDate: formatDisplayDateIST(dateStr),
      roundType,
      isFlat: isFlatRound(roundType),
      timeTakenSeconds: r.time_taken_seconds !== null && r.time_taken_seconds !== undefined ? Number(r.time_taken_seconds) : null,
      formattedTime: r.time_taken_seconds !== null && r.time_taken_seconds !== undefined ? formatSecondsToTime(r.time_taken_seconds) : '—',
      source: 'Manual',
      status: isEmpty ? 'Not started' : isPartial ? 'Partial' : 'Completed',
      enteredCount,
    };
  });

  const rows = orderedCategories.map((cat) => {
    const cells = sortedRounds.map((r) => {
      const res = resultMap.get(`${r.id}_${cat.id}`);
      if (!res) {
        return {
          status: 'missing',
          display: '—',
          correct: null,
          total: null,
          timeSeconds: null,
          isVerified: false,
          isCorrected: false,
        };
      }

      const hasCorrect = res.correct !== null && res.correct !== undefined;
      const hasTotal = res.total !== null && res.total !== undefined;
      const correctNum = hasCorrect ? Number(res.correct) : null;
      const totalNum = hasTotal ? Number(res.total) : null;
      const isVerified = Boolean(res.verified || res.verified_at || res.verified_by);
      const isCorrected = Boolean(res.corrected_at || res.corrected_by);

      if (correctNum === 0) {
        return {
          status: 'zero',
          display: totalNum !== null ? `0 / ${totalNum}` : '0',
          correct: 0,
          total: totalNum,
          timeSeconds: res.time_seconds !== null && res.time_seconds !== undefined ? Number(res.time_seconds) : null,
          isVerified,
          isCorrected,
          note: res.note || null,
        };
      }

      if (hasCorrect) {
        return {
          status: 'entered',
          display: totalNum !== null ? `${correctNum} / ${totalNum}` : String(correctNum),
          correct: correctNum,
          total: totalNum,
          timeSeconds: res.time_seconds !== null && res.time_seconds !== undefined ? Number(res.time_seconds) : null,
          isVerified,
          isCorrected,
          note: res.note || null,
        };
      }

      if (res.note) {
        return {
          status: 'note',
          display: String(res.note),
          correct: null,
          total: null,
          timeSeconds: res.time_seconds !== null && res.time_seconds !== undefined ? Number(res.time_seconds) : null,
          isVerified,
          isCorrected,
          note: res.note,
        };
      }

      return {
        status: 'missing',
        display: '—',
        correct: null,
        total: null,
        timeSeconds: null,
        isVerified,
        isCorrected,
      };
    });

    return {
      category: {
        id: cat.id,
        name: cat.name,
        sortOrder: cat.series_sort_order ?? cat.sort_order ?? 0,
      },
      cells,
    };
  });

  // Calculate column totals
  const columnTotals = sortedRounds.map((r, colIdx) => {
    let sumCorrect = 0;
    let sumTotal = 0;
    let countTotalEntries = 0;

    rows.forEach((row) => {
      const cell = row.cells[colIdx];
      if (cell.correct !== null) {
        sumCorrect += cell.correct;
      }
      if (cell.total !== null && cell.total > 0) {
        sumTotal += cell.total;
        countTotalEntries++;
      }
    });

    const accuracyText = sumTotal > 0
      ? `${((sumCorrect / sumTotal) * 100).toFixed(1).replace(/\.0$/, '')}%`
      : countTotalEntries > 0
        ? '0%'
        : '—';

    const colMeta = columns[colIdx];

    return {
      scoreText: sumTotal > 0 ? `${sumCorrect} / ${sumTotal}` : (sumCorrect > 0 ? String(sumCorrect) : '—'),
      accuracyText,
      timeText: colMeta.formattedTime,
      statusText: colMeta.status,
      sumCorrect,
      sumTotal,
    };
  });

  return {
    type: 'manual',
    sheetId: `manual_${seriesId}`,
    title: `Manual Practice · ${seriesName}`,
    seriesName,
    seriesId,
    unitLabel: 'Correct / Total (Manual)',
    columns,
    rows,
    totals: {
      columnTotals,
    },
  };
}

/**
 * Builds an Excel-like sheet for online JMCWC simulator attempts.
 * Uses authoritative 23 categories in position order (1..23).
 * Uses persisted earned marks and frozen maximum marks (never recalculates dynamic maximums).
 * Distinguishes zero (0 / max_marks), missing (—), and incomplete rounds without leaking private questions/answers.
 */
export function buildOnlineScoresheet({
  groupKey = null,
  paperId = null,
  paperVersion = null,
  jmcwcCategories = AUTHORITATIVE_JMCWC_CATEGORIES,
  attempts = [],
  reviewCache = new Map(),
}) {
  const groupLabel = groupKey ? formatJmcwcGroupLabel(groupKey) : 'Unassigned Group';

  // Authoritative version metadata when available; otherwise distinguishable paper identifier
  let versionLabel = '';
  let paperVersionLabel = '';
  if (paperVersion) {
    versionLabel = ` · Version ${paperVersion}`;
    paperVersionLabel = `Version ${paperVersion}`;
  } else if (paperId) {
    versionLabel = ` · Paper ${paperId}`;
    paperVersionLabel = `Paper ${paperId}`;
  } else {
    paperVersionLabel = 'Unspecified Paper';
  }

  // Sort attempts chronologically with tie-breaker on id
  const sortedAttempts = [...attempts].sort((a, b) => {
    const dateA = getOnlineAttemptDateIST(a);
    const dateB = getOnlineAttemptDateIST(b);
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const timeA = a.finished_at || a.created_at || '';
    const timeB = b.finished_at || b.created_at || '';
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const orderedCategories = [...(jmcwcCategories && jmcwcCategories.length > 0 ? jmcwcCategories : AUTHORITATIVE_JMCWC_CATEGORIES)]
    .sort((a, b) => (a.position || 0) - (b.position || 0));

  let flatRoundCount = 0;
  const columns = sortedAttempts.map((att, idx) => {
    const isSubmitted = att.status === 'submitted';
    const isFlat = att.mode === 'flat';
    if (isFlat) flatRoundCount++;
    const roundNumber = isFlat ? flatRoundCount : idx + 1;
    const dateStr = getOnlineAttemptDateIST(att);
    const catTitle = att.category_key ? formatJmcwcCategoryTitle(att.category_key, orderedCategories) : '';
    const label = isFlat ? `Flat Round #${roundNumber}` : `Practice: ${catTitle}`;

    const activeMs = Number(att.active_ms || 0);
    const timeFormatted = formatActiveDurationMs(activeMs, { alwaysHours: isFlat });

    let statusLabel = 'Completed';
    if (!isSubmitted) {
      statusLabel = att.status === 'paused' ? 'Paused' : 'In progress';
    }

    const reviewErr = reviewCache.get(att.id)?.error || null;

    return {
      id: att.id,
      roundNumber,
      label,
      dateStr,
      displayDate: formatDisplayDateIST(dateStr),
      mode: att.mode,
      isFlat,
      categoryKey: att.category_key || null,
      status: statusLabel,
      isSubmitted,
      activeMs,
      formattedTime: timeFormatted,
      source: 'Online',
      paperId: att.paper_id || paperId || null,
      paperVersion: att.paper_version || paperVersion || null,
      reviewError: reviewErr,
    };
  });

  const rows = orderedCategories.map((cat) => {
    const cells = sortedAttempts.map((att) => {
      const isSubmitted = att.status === 'submitted';

      if (!isSubmitted) {
        // Excluded / in-progress attempt: show '—' without exposing questions or answer keys
        return {
          status: 'in_progress',
          display: '—',
          marks: null,
          maxMarks: null,
          note: 'In progress',
        };
      }

      if (att.mode === 'category') {
        if (att.category_key === cat.key) {
          const scoreObj = att.score || att.score_summary || {};
          const marks = Number(scoreObj.marks ?? scoreObj.earned_marks ?? 0);
          const maxMarks = Number(scoreObj.max_marks ?? att.max_marks ?? 0);

          if (marks === 0) {
            return {
              status: 'zero',
              display: maxMarks > 0 ? `0 / ${maxMarks}` : '0',
              marks: 0,
              maxMarks,
            };
          }
          return {
            status: 'entered',
            display: maxMarks > 0 ? `${marks} / ${maxMarks}` : String(marks),
            marks,
            maxMarks,
          };
        }
        // Category not tested in this category attempt
        return {
          status: 'missing',
          display: '—',
          marks: null,
          maxMarks: null,
        };
      }

      // Flat round: check reviewCache
      const reviewEntry = reviewCache.get(att.id);
      if (reviewEntry && reviewEntry.error) {
        return {
          status: 'review_error',
          display: '⚠️ Error',
          marks: null,
          maxMarks: null,
          note: reviewEntry.error || 'Failed to load question breakdown',
        };
      }

      const reviewQuestions = Array.isArray(reviewEntry) ? reviewEntry : (reviewEntry?.review || []);
      const catQuestions = reviewQuestions.filter((q) => q.category_key === cat.key);

      if (catQuestions.length === 0) {
        // If review items not cached or no questions for this category in paper
        return {
          status: 'missing',
          display: '—',
          marks: null,
          maxMarks: null,
        };
      }

      let catAward = 0;
      let catMax = 0;
      catQuestions.forEach((q) => {
        catAward += Number(q.award ?? q.awarded_marks ?? 0);
        catMax += Number(q.max_marks ?? 0);
      });

      if (catAward === 0) {
        return {
          status: 'zero',
          display: catMax > 0 ? `0 / ${catMax}` : '0',
          marks: 0,
          maxMarks: catMax,
        };
      }

      return {
        status: 'entered',
        display: catMax > 0 ? `${catAward} / ${catMax}` : String(catAward),
        marks: catAward,
        maxMarks: catMax,
      };
    });

    return {
      category: {
        key: cat.key,
        name: cat.label || JMCWC_CATEGORY_TITLES[cat.key] || cat.key,
        position: cat.position,
      },
      cells,
    };
  });

  // Calculate column totals
  const columnTotals = sortedAttempts.map((att, colIdx) => {
    const isSubmitted = att.status === 'submitted';
    const colMeta = columns[colIdx];

    if (!isSubmitted) {
      return {
        scoreText: '—',
        accuracyText: '—',
        timeText: colMeta.formattedTime,
        statusText: `In progress (${att.status})`,
        breakdownText: 'In progress',
        isSubmitted: false,
      };
    }

    const scoreObj = att.score || att.score_summary || {};
    const marks = Number(scoreObj.marks ?? scoreObj.earned_marks ?? 0);
    const maxMarks = Number(scoreObj.max_marks ?? att.max_marks ?? 0);
    const accuracyText = maxMarks > 0
      ? `${((marks / maxMarks) * 100).toFixed(1).replace(/\.0$/, '')}%`
      : '—';

    const cCount = Number(scoreObj.correct || 0);
    const pCount = Number(scoreObj.partial || 0);
    const wCount = Number(scoreObj.wrong || 0);
    const sCount = Number(scoreObj.skipped || 0);
    const breakdownText = `${cCount}C · ${pCount}P · ${wCount}W · ${sCount}S`;

    return {
      scoreText: maxMarks > 0 ? `${marks} / ${maxMarks}` : String(marks),
      accuracyText,
      timeText: colMeta.formattedTime,
      statusText: 'Completed',
      breakdownText,
      isSubmitted: true,
      marks,
      maxMarks,
    };
  });

  const sheetId = `online_${groupKey || 'unassigned'}_${paperId ? `paper_${paperId}` : (paperVersion ? `ver_${paperVersion}` : 'default')}`;

  return {
    type: 'online',
    sheetId,
    title: `Online Practice · ${groupLabel}${versionLabel}`,
    groupKey,
    groupLabel,
    paperId,
    paperVersion,
    paperVersionLabel,
    unitLabel: 'Earned Marks / Frozen Max Marks (Online)',
    columns,
    rows,
    totals: {
      columnTotals,
    },
  };
}

/**
 * Assembles the full scoresheet view model based on the active filters and student state.
 * Strictly separates incompatible manual and online units into separate sheet objects.
 */
export function buildScoresheetViewModel({
  sourceFilter = 'both',
  preset = 'last7',
  customFrom = null,
  customTo = null,
  todayIST = '',
  studentProfile = {},
  jmcwcAssignment = null,
  manualRounds = [],
  seriesCategories = [],
  manualResults = [],
  roundSeriesList = [],
  onlineAttempts = [],
  onlineCategories = AUTHORITATIVE_JMCWC_CATEGORIES,
  onlineReviewCache = new Map(),
  papersMap = new Map(),
  loadErrors = { manual: null, online: null, reviews: new Map() },
}) {
  const filterBounds = resolveDateFilterBounds(preset, todayIST, customFrom, customTo);
  const periodLabel = formatScoresheetPeriodLabel(filterBounds);

  if (filterBounds.error) {
    return {
      isValid: false,
      error: filterBounds.error,
      loadErrors,
      periodLabel,
      sourceFilter,
      sheets: [],
      studentInfo: {
        name: studentProfile?.full_name || 'Student',
        code: studentProfile?.student_code || 'STU',
        level: studentProfile?.level || 'Unassigned',
        group: jmcwcAssignment?.group_key ? formatJmcwcGroupLabel(jmcwcAssignment.group_key) : 'Unassigned Group',
      },
      isEmpty: true,
    };
  }

  const { startDate, endDate } = filterBounds;
  const sheets = [];

  // 1. Process Manual sheets if filter is 'both' or 'manual'
  if (sourceFilter === 'both' || sourceFilter === 'manual') {
    // Filter manual rounds by date
    const filteredManualRounds = (manualRounds || []).filter((r) => {
      const d = getManualRoundDateIST(r);
      return isDateWithinFilter(d, startDate, endDate);
    });

    if (filteredManualRounds.length > 0) {
      // Group by series_id
      const seriesMap = new Map();
      (roundSeriesList || []).forEach((s) => seriesMap.set(s.id, s));

      const roundsBySeries = new Map();
      filteredManualRounds.forEach((r) => {
        const sId = r.series_id || 'default';
        if (!roundsBySeries.has(sId)) {
          roundsBySeries.set(sId, []);
        }
        roundsBySeries.get(sId).push(r);
      });

      roundsBySeries.forEach((sRounds, sId) => {
        const sInfo = seriesMap.get(sId) || { id: sId, name: sRounds[0]?.series?.name || 'Simulator Series' };
        // Filter categories belonging to this series (or use seriesCategories if single series)
        const sCategories = seriesCategories.filter((c) => !c.series_id || c.series_id === sId);
        const catsToUse = sCategories.length > 0 ? sCategories : seriesCategories;

        const manualSheet = buildManualScoresheet({
          seriesInfo: sInfo,
          categories: catsToUse,
          rounds: sRounds,
          results: manualResults,
        });
        sheets.push(manualSheet);
      });
    }
  }

  // 2. Process Online sheets if filter is 'both' or 'online'
  if (sourceFilter === 'both' || sourceFilter === 'online') {
    // Filter online attempts by date
    const filteredOnlineAttempts = (onlineAttempts || []).filter((att) => {
      const d = getOnlineAttemptDateIST(att);
      return isDateWithinFilter(d, startDate, endDate);
    });

    if (filteredOnlineAttempts.length > 0) {
      // Group by group_key AND paper_id (preserving unique paper identity, never combining different paper IDs)
      const attemptsByPaper = new Map();
      filteredOnlineAttempts.forEach((att) => {
        const gKey = att.group_key || null;
        const pId = att.paper_id || null;
        const pVersion =
          att.paper_version ||
          att.paper?.version ||
          att.version ||
          (papersMap && pId ? papersMap.get(pId)?.version : null) ||
          null;

        // Distinct sheet key combining group_key and paper_id. If no paper_id exists, fall back to paperVersion or default.
        const sheetKey = `${gKey || 'unassigned'}__${pId ? `paper_${pId}` : (pVersion ? `ver_${pVersion}` : 'default')}`;
        if (!attemptsByPaper.has(sheetKey)) {
          attemptsByPaper.set(sheetKey, {
            groupKey: gKey,
            paperId: pId,
            paperVersion: pVersion,
            attempts: [],
          });
        }
        attemptsByPaper.get(sheetKey).attempts.push(att);
      });

      attemptsByPaper.forEach(({ groupKey, paperId, paperVersion, attempts: gAttempts }) => {
        const onlineSheet = buildOnlineScoresheet({
          groupKey,
          paperId,
          paperVersion,
          jmcwcCategories: onlineCategories,
          attempts: gAttempts,
          reviewCache: onlineReviewCache,
        });
        sheets.push(onlineSheet);
      });

      // Disambiguate titles if different paper IDs share the exact same version and group
      const titleCounts = new Map();
      sheets.forEach((s) => {
        if (s.type === 'online') {
          titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1);
        }
      });
      sheets.forEach((s) => {
        if (s.type === 'online' && titleCounts.get(s.title) > 1 && s.paperId) {
          s.title = `${s.title} (${s.paperId})`;
        }
      });
    }
  }

  const assignedGroupKey = jmcwcAssignment?.group_key || (sheets.find((s) => s.type === 'online')?.groupKey) || null;
  const groupLabel = assignedGroupKey ? formatJmcwcGroupLabel(assignedGroupKey) : 'Unassigned';

  const studentInfo = {
    name: studentProfile?.full_name || 'Student',
    code: studentProfile?.student_code || 'STU',
    level: studentProfile?.level || 'Unassigned',
    group: groupLabel,
  };

  const isEmpty = sheets.length === 0 || sheets.every((s) => s.columns.length === 0);

  return {
    isValid: true,
    error: null,
    loadErrors,
    periodLabel,
    sourceFilter,
    sheets,
    studentInfo,
    isEmpty,
  };
}

// =============================================================================
// STANDALONE PDF 1.4 GENERATOR WITH COLUMN PAGINATION
// =============================================================================

/**
 * Robustly sanitizes and escapes strings for PDF 1.4 Type1 fonts (WinAnsiEncoding).
 * Converts Unicode em/en dashes to ASCII '-', middle dots to ' | ', smart quotes,
 * strips combining accents to pure ASCII, removes unprintable non-ASCII bytes,
 * and escapes PDF string literal special characters \, (, ).
 */
export function pdfEscape(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u2014\u2013\u2015]/g, '-')
    .replace(/\s*[\u00B7\u2022]\s*/g, ' | ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Approximate Helvetica character widths (per 1000 units of font size) for standard Type1 PDF fonts
const HELVETICA_CHAR_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 222,
  '{': 334, '|': 260, '}': 334, '~': 584,
  'i': 222, 'l': 222, 'j': 222, 'f': 278, 't': 278, 'r': 333,
  'm': 833, 'w': 722, 'M': 833, 'W': 944,
};

/**
 * Measures the width of a plain ASCII string rendered in Helvetica / Helvetica-Bold in PDF points.
 */
export function measurePdfTextWidth(text, fontSize, isBold = false) {
  if (!text) return 0;
  const str = String(text);
  let totalUnits = 0;
  const boldFactor = isBold ? 1.08 : 1.0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (HELVETICA_CHAR_WIDTHS[ch] !== undefined) {
      totalUnits += HELVETICA_CHAR_WIDTHS[ch] * boldFactor;
    } else if (ch >= '0' && ch <= '9') {
      totalUnits += 556 * boldFactor;
    } else if (ch >= 'a' && ch <= 'z') {
      totalUnits += 520 * boldFactor;
    } else if (ch >= 'A' && ch <= 'Z') {
      totalUnits += 680 * boldFactor;
    } else {
      totalUnits += 500 * boldFactor;
    }
  }
  return (totalUnits / 1000) * fontSize;
}

/**
 * Fits a single line of text into maxWidth by truncating with ellipsis if necessary.
 */
export function fitPdfText(text, maxWidth, fontSize, isBold = false) {
  if (!text) return '';
  const str = String(text).trim();
  if (measurePdfTextWidth(str, fontSize, isBold) <= maxWidth) {
    return str;
  }
  let truncated = str;
  while (truncated.length > 2 && measurePdfTextWidth(truncated + '...', fontSize, isBold) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '...';
}

/**
 * Wraps text into multiple lines where each line fits within maxWidth.
 */
export function wrapPdfText(text, maxWidth, fontSize, isBold = false) {
  if (!text) return [];
  const str = String(text).trim();
  if (!str) return [];
  if (measurePdfTextWidth(str, fontSize, isBold) <= maxWidth) {
    return [str];
  }
  const words = str.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    let safeWord = word;
    if (measurePdfTextWidth(safeWord, fontSize, isBold) > maxWidth) {
      while (safeWord.length > 3 && measurePdfTextWidth(safeWord + '...', fontSize, isBold) > maxWidth) {
        safeWord = safeWord.slice(0, -1);
      }
      safeWord += '...';
    }
    const testLine = currentLine ? `${currentLine} ${safeWord}` : safeWord;
    if (measurePdfTextWidth(testLine, fontSize, isBold) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = safeWord;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

const SHORT_CATEGORY_LABELS = {
  'Integer addition': 'Integer Add.',
  'Integer subtraction': 'Integer Sub.',
  'Mixed addition and subtraction': 'Mixed Add/Sub',
  'Integer multiplication': 'Integer Mult.',
  'Integer division': 'Integer Div.',
  'Prime factorisation': 'Prime Factors',
  'HCF and LCM': 'HCF & LCM',
  'Fraction addition': 'Fraction Add.',
  'Fraction subtraction': 'Fraction Sub.',
  'Fraction multiplication': 'Fraction Mult.',
  'Fraction division': 'Fraction Div.',
  'Perfect square roots': 'Square Roots',
  'Inexact square roots': 'Inexact Sq. Roots',
  'Next squares': 'Next Squares',
  'Exact cube roots': 'Cube Roots',
  'Next cubes': 'Next Cubes',
  'Elapsed time': 'Elapsed Time',
  'Sums of squares': 'Sums of Sq.',
};

/**
 * Formats a column header label into [line1, line2], ensuring every line stays within available width.
 */
export function formatColumnHeaderLabel(label, availW) {
  if (!label) return ['', ''];
  const match = /^Practice\s*:\s*(.*)$/i.exec(label);
  if (match) {
    const catRaw = match[1].trim();
    const line1 = 'Practice';
    let line2 = catRaw;
    if (measurePdfTextWidth(line2, 7, true) > availW) {
      line2 = SHORT_CATEGORY_LABELS[catRaw] || line2;
    }
    if (measurePdfTextWidth(line2, 7, true) > availW) {
      line2 = fitPdfText(line2, availW, 7, true);
    }
    return [line1, line2];
  }
  if (measurePdfTextWidth(label, 8, true) <= availW) {
    return [label, ''];
  }
  const lines = wrapPdfText(label, availW, 7.5, true);
  return [lines[0] || label, lines.slice(1).join(' ') || ''];
}

/**
 * Builds a multi-page, landscape A4 PDF 1.4 document containing the Excel-like scoresheet.
 * If columns exceed 7 columns, repeats the Category column and header on subsequent pages.
 * Returns Uint8Array of PDF bytes. Zero external dependencies.
 */
export function buildScoresheetPdfBytes(viewModel) {
  if (!viewModel || !viewModel.isValid) {
    throw new Error(viewModel?.error || 'Cannot generate PDF for invalid scoresheet.');
  }

  if (hasScoresheetLoadErrors(viewModel)) {
    const errMsg = viewModel.loadErrors?.manual || viewModel.loadErrors?.online || 'Score history has unrecovered loading failures.';
    throw new Error(`Cannot export incomplete scoresheet due to loading errors: ${errMsg}`);
  }

  const PAGE_W = 842; // A4 Landscape width
  const PAGE_H = 595; // A4 Landscape height
  const MARGIN_X = 36;
  const MARGIN_Y = 36;
  const CONTENT_W = PAGE_W - MARGIN_X * 2; // 770 pt
  const CONTENT_H = PAGE_H - MARGIN_Y * 2; // 523 pt
  const BOTTOM_LIMIT = MARGIN_Y + 24;

  const CAT_COL_W = 145;
  const MAX_DATA_COLS_PER_PAGE = 7;
  const DATA_COL_W = Math.floor((CONTENT_W - CAT_COL_W) / MAX_DATA_COLS_PER_PAGE); // 89 pt

  const pages = [];
  const encoder = new TextEncoder();

  const { studentInfo, periodLabel, sheets } = viewModel;

  function renderPageHeader(ops, sheetTitle, unitLabel, pageChunkLabel) {
    const BANNER_H = 58;
    // Top Brand & Identity Banner
    // Background fill for header
    ops.push('q');
    ops.push('0.96 0.97 0.99 rg');
    ops.push('0.85 0.88 0.93 RG');
    ops.push('0.5 w');
    ops.push(`${MARGIN_X} ${PAGE_H - MARGIN_Y - BANNER_H} ${CONTENT_W} ${BANNER_H} re B`);
    ops.push('Q');

    // Accent line
    ops.push('q');
    ops.push('0.15 0.38 0.92 rg');
    ops.push(`${MARGIN_X} ${PAGE_H - MARGIN_Y - 4} ${CONTENT_W} 4 re f`);
    ops.push('Q');

    const LEFT_BOX_X = MARGIN_X + 12; // 48
    const RIGHT_BOX_X = MARGIN_X + 418; // 454
    const LEFT_BOX_W = RIGHT_BOX_X - LEFT_BOX_X - 16; // 390 pt
    const RIGHT_BOX_W = PAGE_W - MARGIN_X - 12 - RIGHT_BOX_X; // 340 pt

    // Left side: Brand Title, Sheet Title / Paper ID, Unit & Part
    ops.push('BT');
    ops.push('/F2 11.5 Tf');
    ops.push('0.06 0.09 0.16 rg');
    ops.push(`1 0 0 1 ${LEFT_BOX_X} ${PAGE_H - MARGIN_Y - 18} Tm`);
    ops.push(`(${pdfEscape('TRENDZ TRACKER - MAIN ROUND SCORESHEET')}) Tj`);

    ops.push('/F1 8.5 Tf');
    ops.push('0.20 0.25 0.35 rg');
    const safeSheetTitle = fitPdfText(sheetTitle, LEFT_BOX_W, 8.5, false);
    ops.push(`1 0 0 1 ${LEFT_BOX_X} ${PAGE_H - MARGIN_Y - 32} Tm`);
    ops.push(`(${pdfEscape(safeSheetTitle)}) Tj`);

    ops.push('/F1 8 Tf');
    ops.push('0.35 0.40 0.50 rg');
    const unitChunkText = `Unit: ${unitLabel}${pageChunkLabel ? ' | ' + pageChunkLabel : ''}`;
    const safeUnitChunk = fitPdfText(unitChunkText, LEFT_BOX_W, 8, false);
    ops.push(`1 0 0 1 ${LEFT_BOX_X} ${PAGE_H - MARGIN_Y - 46} Tm`);
    ops.push(`(${pdfEscape(safeUnitChunk)}) Tj`);

    // Right side: Student identity & Period
    const fullStudentLine = `${studentInfo?.name || 'Student'} (${studentInfo?.code || '-'}) | Group: ${studentInfo?.group || 'Unassigned'}`;
    const fitsSingleLine = measurePdfTextWidth(fullStudentLine, 9.5, true) <= RIGHT_BOX_W;

    if (fitsSingleLine) {
      ops.push('/F2 9.5 Tf');
      ops.push('0.06 0.09 0.16 rg');
      ops.push(`1 0 0 1 ${RIGHT_BOX_X} ${PAGE_H - MARGIN_Y - 18} Tm`);
      ops.push(`(${pdfEscape(fullStudentLine)}) Tj`);

      ops.push('/F1 8.5 Tf');
      ops.push('0.35 0.40 0.50 rg');
      ops.push(`1 0 0 1 ${RIGHT_BOX_X} ${PAGE_H - MARGIN_Y - 46} Tm`);
      ops.push(`(${pdfEscape(`Period: ${periodLabel}`)}) Tj`);
    } else {
      const safeName = fitPdfText(studentInfo?.name || 'Student', RIGHT_BOX_W, 9.5, true);
      ops.push('/F2 9.5 Tf');
      ops.push('0.06 0.09 0.16 rg');
      ops.push(`1 0 0 1 ${RIGHT_BOX_X} ${PAGE_H - MARGIN_Y - 18} Tm`);
      ops.push(`(${pdfEscape(safeName)}) Tj`);

      const idGroupText = `ID: ${studentInfo?.code || '-'} | Group: ${studentInfo?.group || 'Unassigned'}`;
      const safeIdGroup = fitPdfText(idGroupText, RIGHT_BOX_W, 8, false);
      ops.push('/F1 8 Tf');
      ops.push('0.20 0.25 0.35 rg');
      ops.push(`1 0 0 1 ${RIGHT_BOX_X} ${PAGE_H - MARGIN_Y - 32} Tm`);
      ops.push(`(${pdfEscape(safeIdGroup)}) Tj`);

      const safePeriod = fitPdfText(`Period: ${periodLabel}`, RIGHT_BOX_W, 8, false);
      ops.push('/F1 8 Tf');
      ops.push('0.35 0.40 0.50 rg');
      ops.push(`1 0 0 1 ${RIGHT_BOX_X} ${PAGE_H - MARGIN_Y - 46} Tm`);
      ops.push(`(${pdfEscape(safePeriod)}) Tj`);
    }
    ops.push('ET');
  }

  function renderPageFooter(ops, pageNum, totalPagesEst, paperId, studentCode) {
    ops.push('BT');
    ops.push('/F1 8 Tf');
    ops.push('0.50 0.55 0.65 rg');
    ops.push(`1 0 0 1 ${MARGIN_X} ${MARGIN_Y + 8} Tm`);
    const paperStr = paperId ? `Paper: ${paperId} | ` : '';
    const studentStr = studentCode ? `Student: ${studentCode} | ` : '';
    const footerLeft = fitPdfText(`${paperStr}${studentStr}Trendz Tracker Portal | Confidential Student Score Sheet | Preserved Frozen Marks`, CONTENT_W - 100, 8, false);
    ops.push(`(${pdfEscape(footerLeft)}) Tj`);

    ops.push(`1 0 0 1 ${MARGIN_X + CONTENT_W - 70} ${MARGIN_Y + 8} Tm`);
    ops.push(`(${pdfEscape(`Page ${pageNum} of ${totalPagesEst}`)}) Tj`);
    ops.push('ET');
  }

  // Iterate over each sheet (e.g. Manual, Online)
  for (const sheet of sheets) {
    const totalCols = sheet.columns.length;
    if (totalCols === 0) continue;

    const chunkCount = Math.ceil(totalCols / MAX_DATA_COLS_PER_PAGE);

    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      const colStart = chunkIdx * MAX_DATA_COLS_PER_PAGE;
      const colEnd = Math.min(colStart + MAX_DATA_COLS_PER_PAGE, totalCols);
      const pageCols = sheet.columns.slice(colStart, colEnd);
      const actualColCount = pageCols.length;

      const pageOps = [];
      const pageChunkLabel = chunkCount > 1 ? `Part ${chunkIdx + 1} of ${chunkCount} (Cols ${colStart + 1}-${colEnd})` : '';

      renderPageHeader(pageOps, sheet.title, sheet.unitLabel, pageChunkLabel);

      let curY = PAGE_H - MARGIN_Y - 66;
      const ROW_H = 15;
      const HEADER_H = 48;
      const totalTableW = CAT_COL_W + actualColCount * DATA_COL_W;

      // Table Header Row Background
      pageOps.push('q');
      pageOps.push('0.94 0.95 0.97 rg');
      pageOps.push('0.80 0.83 0.88 RG');
      pageOps.push('0.5 w');
      pageOps.push(`${MARGIN_X} ${curY - HEADER_H} ${totalTableW} ${HEADER_H} re B`);
      pageOps.push('Q');

      // Category Column Header Text
      pageOps.push('BT');
      pageOps.push('/F2 9 Tf');
      pageOps.push('0.20 0.25 0.35 rg');
      pageOps.push(`1 0 0 1 ${MARGIN_X + 6} ${curY - 26} Tm`);
      pageOps.push(`(${pdfEscape('CATEGORY')}) Tj`);
      pageOps.push('ET');

      // Column Header Texts (Round / Date / Type)
      pageCols.forEach((col, idx) => {
        const cellX = MARGIN_X + CAT_COL_W + idx * DATA_COL_W;
        const availW = DATA_COL_W - 8;

        // Vertical divider
        pageOps.push('q');
        pageOps.push('0.85 0.88 0.93 RG');
        pageOps.push('0.5 w');
        pageOps.push(`${cellX} ${curY - HEADER_H} m ${cellX} ${curY} l S`);
        pageOps.push('Q');

        const lines = formatColumnHeaderLabel(col.label || `Round ${col.roundNumber}`, availW);
        const line1 = lines[0] || '';
        const line2 = lines[1] || '';

        pageOps.push('BT');
        if (line2) {
          pageOps.push('/F2 7.5 Tf');
          pageOps.push('0.06 0.09 0.16 rg');
          pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 11} Tm`);
          pageOps.push(`(${pdfEscape(line1)}) Tj`);

          pageOps.push('/F2 7 Tf');
          pageOps.push('0.10 0.15 0.25 rg');
          pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 21} Tm`);
          pageOps.push(`(${pdfEscape(line2)}) Tj`);
        } else {
          pageOps.push('/F2 8 Tf');
          pageOps.push('0.06 0.09 0.16 rg');
          pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 14} Tm`);
          pageOps.push(`(${pdfEscape(line1)}) Tj`);
        }

        pageOps.push('/F1 6.5 Tf');
        pageOps.push('0.40 0.45 0.55 rg');
        pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 31} Tm`);
        const safeDate = fitPdfText(col.displayDate || col.dateStr, availW, 6.5, false);
        pageOps.push(`(${pdfEscape(safeDate)}) Tj`);

        pageOps.push('/F1 6.5 Tf');
        pageOps.push(col.status === 'Completed' ? '0.08 0.55 0.25 rg' : '0.80 0.45 0.05 rg');
        pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 40} Tm`);
        const safeStatus = fitPdfText(col.status, availW, 6.5, false);
        pageOps.push(`(${pdfEscape(safeStatus)}) Tj`);
        pageOps.push('ET');
      });

      // Right edge divider on header
      pageOps.push('q');
      pageOps.push('0.85 0.88 0.93 RG');
      pageOps.push('0.5 w');
      pageOps.push(`${MARGIN_X + totalTableW} ${curY - HEADER_H} m ${MARGIN_X + totalTableW} ${curY} l S`);
      pageOps.push('Q');

      curY -= HEADER_H;

      // Table Rows
      sheet.rows.forEach((row, rowIdx) => {
        const isAlt = rowIdx % 2 === 1;

        // Row background
        if (isAlt) {
          pageOps.push('q');
          pageOps.push('0.985 0.988 0.995 rg');
          pageOps.push(`${MARGIN_X} ${curY - ROW_H} ${totalTableW} ${ROW_H} re f`);
          pageOps.push('Q');
        }

        // Horizontal bottom grid line
        pageOps.push('q');
        pageOps.push('0.90 0.92 0.95 RG');
        pageOps.push('0.5 w');
        pageOps.push(`${MARGIN_X} ${curY - ROW_H} m ${MARGIN_X + totalTableW} ${curY - ROW_H} l S`);
        pageOps.push('Q');

        // Category Name Cell
        const catName = row.category?.name || row.category?.key || row.categoryName || 'Category';
        const safeCat = fitPdfText(catName, CAT_COL_W - 12, 8, true);
        pageOps.push('BT');
        pageOps.push('/F2 8 Tf');
        pageOps.push('0.10 0.14 0.22 rg');
        pageOps.push(`1 0 0 1 ${MARGIN_X + 6} ${curY - 11} Tm`);
        pageOps.push(`(${pdfEscape(safeCat)}) Tj`);
        pageOps.push('ET');

        // Cells for this row across page columns
        for (let idx = 0; idx < actualColCount; idx++) {
          const originalColIdx = colStart + idx;
          const cell = row.cells[originalColIdx];
          const cellX = MARGIN_X + CAT_COL_W + idx * DATA_COL_W;
          const availW = DATA_COL_W - 8;

          // Vertical divider line
          pageOps.push('q');
          pageOps.push('0.92 0.93 0.96 RG');
          pageOps.push('0.5 w');
          pageOps.push(`${cellX} ${curY - ROW_H} m ${cellX} ${curY} l S`);
          pageOps.push('Q');

          pageOps.push('BT');
          if (cell.status === 'missing') {
            pageOps.push('/F1 8 Tf');
            pageOps.push('0.60 0.65 0.72 rg');
          } else if (cell.status === 'zero') {
            pageOps.push('/F2 8 Tf');
            pageOps.push('0.75 0.20 0.20 rg');
          } else if (cell.status === 'in_progress') {
            pageOps.push('/F1 7.5 Tf');
            pageOps.push('0.55 0.50 0.10 rg');
          } else if (cell.status === 'review_error') {
            pageOps.push('/F2 7.5 Tf');
            pageOps.push('0.85 0.15 0.15 rg');
          } else {
            pageOps.push('/F2 8 Tf');
            pageOps.push('0.06 0.09 0.16 rg');
          }

          const displayText = cell.display || '-';
          const safeDisplay = fitPdfText(displayText, availW, 8, cell.status === 'zero' || cell.status === 'review_error');
          pageOps.push(`1 0 0 1 ${cellX + 6} ${curY - 11} Tm`);
          pageOps.push(`(${pdfEscape(safeDisplay)}) Tj`);
          pageOps.push('ET');
        }

        // Right edge divider on row
        pageOps.push('q');
        pageOps.push('0.92 0.93 0.96 RG');
        pageOps.push('0.5 w');
        pageOps.push(`${MARGIN_X + totalTableW} ${curY - ROW_H} m ${MARGIN_X + totalTableW} ${curY} l S`);
        pageOps.push('Q');

        curY -= ROW_H;
      });

      // Bottom Totals Row
      const TOTAL_ROW_H = 18;
      pageOps.push('q');
      pageOps.push('0.92 0.94 0.98 rg');
      pageOps.push('0.75 0.80 0.90 RG');
      pageOps.push('0.8 w');
      pageOps.push(`${MARGIN_X} ${curY - TOTAL_ROW_H} ${totalTableW} ${TOTAL_ROW_H} re B`);
      pageOps.push('Q');

      // Totals Label
      pageOps.push('BT');
      pageOps.push('/F2 8.5 Tf');
      pageOps.push('0.06 0.09 0.16 rg');
      pageOps.push(`1 0 0 1 ${MARGIN_X + 6} ${curY - 12} Tm`);
      pageOps.push(`(${pdfEscape('TOTAL / ACCURACY')}) Tj`);
      pageOps.push('ET');

      // Each column total
      for (let idx = 0; idx < actualColCount; idx++) {
        const originalColIdx = colStart + idx;
        const tot = sheet.totals.columnTotals[originalColIdx];
        const cellX = MARGIN_X + CAT_COL_W + idx * DATA_COL_W;
        const availW = DATA_COL_W - 8;

        pageOps.push('q');
        pageOps.push('0.80 0.83 0.88 RG');
        pageOps.push('0.5 w');
        pageOps.push(`${cellX} ${curY - TOTAL_ROW_H} m ${cellX} ${curY} l S`);
        pageOps.push('Q');

        pageOps.push('BT');
        pageOps.push('/F2 8 Tf');
        pageOps.push('0.06 0.09 0.16 rg');
        pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 10} Tm`);
        const safeScore = fitPdfText(tot?.scoreText || '-', availW, 8, true);
        pageOps.push(`(${pdfEscape(safeScore)}) Tj`);

        pageOps.push('/F1 7 Tf');
        pageOps.push('0.30 0.35 0.45 rg');
        pageOps.push(`1 0 0 1 ${cellX + 4} ${curY - 17} Tm`);
        const safeAccuracy = fitPdfText(tot?.accuracyText || '-', availW, 7, false);
        pageOps.push(`(${pdfEscape(safeAccuracy)}) Tj`);
        pageOps.push('ET');
      }

      // Right edge divider on totals
      pageOps.push('q');
      pageOps.push('0.80 0.83 0.88 RG');
      pageOps.push('0.5 w');
      pageOps.push(`${MARGIN_X + totalTableW} ${curY - TOTAL_ROW_H} m ${MARGIN_X + totalTableW} ${curY} l S`);
      pageOps.push('Q');

      pages.push({ ops: pageOps, paperId: sheet.paperId });
    }
  }

  if (pages.length === 0) {
    // Empty state page
    const emptyOps = [];
    renderPageHeader(emptyOps, 'No records recorded', 'Scoresheet', '');
    emptyOps.push('BT');
    emptyOps.push('/F1 12 Tf');
    emptyOps.push('0.50 0.55 0.65 rg');
    emptyOps.push(`1 0 0 1 ${MARGIN_X + 100} ${PAGE_H / 2} Tm`);
    emptyOps.push(`(${pdfEscape('No round scores recorded for the selected source or date filter.')}) Tj`);
    emptyOps.push('ET');
    pages.push({ ops: emptyOps, paperId: null });
  }

  const totalPages = pages.length;

  // Add footers with exact total pages
  pages.forEach((pageObj, idx) => {
    const ops = pageObj.ops || pageObj;
    const paperId = pageObj.paperId || null;
    renderPageFooter(ops, idx + 1, totalPages, paperId, studentInfo?.code);
  });

  // Assemble PDF 1.4 objects
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);

  objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>`,
  });
  objects.push({
    id: 3,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  objects.push({
    id: 4,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  });

  pages.forEach((pageObj, i) => {
    const ops = pageObj.ops || pageObj;
    const pageObjId = 5 + i * 2;
    const contentObjId = 6 + i * 2;
    const streamContent = ops.join('\n');
    const streamByteLen = encoder.encode(streamContent).byteLength;

    objects.push({
      id: pageObjId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    });
    objects.push({
      id: contentObjId,
      body: `<< /Length ${streamByteLen} >>\nstream\n${streamContent}\nendstream`,
    });
  });

  let pdfStr = '%PDF-1.4\n';
  const offsets = [0];

  for (const obj of objects) {
    offsets[obj.id] = encoder.encode(pdfStr).byteLength;
    pdfStr += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(pdfStr).byteLength;
  const totalObjCount = objects.length + 1;
  pdfStr += `xref\n0 ${totalObjCount}\n`;
  pdfStr += '0000000000 65535 f \n';
  for (let id = 1; id < totalObjCount; id++) {
    const off = String(offsets[id] || 0).padStart(10, '0');
    pdfStr += `${off} 00000 n \n`;
  }

  pdfStr += `trailer\n<< /Size ${totalObjCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdfStr);
}

/**
 * Triggers a browser download of the generated PDF file.
 */
export function downloadScoresheetPdf(viewModel, filename = null) {
  const bytes = buildScoresheetPdfBytes(viewModel);
  const blob = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'application/pdf' }) : null;
  const finalName = filename || `Main_Round_Scoresheet_${viewModel.studentInfo?.code || 'STU'}_${Date.now()}.pdf`;

  if (typeof document !== 'undefined' && typeof document.createElement === 'function' && blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return { filename: finalName, bytes, blob };
}

// =============================================================================
// HTML5 CANVAS IMAGE GENERATOR & EXPORTER
// =============================================================================

/**
 * Renders the scoresheet to off-screen HTML5 Canvas objects.
 * Splits into labeled parts if columns exceed MAX_COLS_PER_IMAGE (8 columns).
 * Returns array of { canvas, filename, partIndex, totalParts, blobPromise }.
 */
export function renderScoresheetToCanvases(viewModel) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return [];
  }

  if (!viewModel || !viewModel.isValid || viewModel.sheets.length === 0) {
    return [];
  }

  if (hasScoresheetLoadErrors(viewModel)) {
    const errMsg = viewModel.loadErrors?.manual || viewModel.loadErrors?.online || 'Score history has unrecovered loading failures.';
    throw new Error(`Cannot generate image export due to loading errors: ${errMsg}`);
  }

  const results = [];
  const MAX_COLS_PER_IMAGE = 8;
  const DPR = 2; // HiDPI crisp rendering

  for (const sheet of viewModel.sheets) {
    const totalCols = sheet.columns.length;
    if (totalCols === 0) continue;

    const chunkCount = Math.ceil(totalCols / MAX_COLS_PER_IMAGE);

    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      const colStart = chunkIdx * MAX_COLS_PER_IMAGE;
      const colEnd = Math.min(colStart + MAX_COLS_PER_IMAGE, totalCols);
      const pageCols = sheet.columns.slice(colStart, colEnd);
      const colCount = pageCols.length;

      const CAT_COL_W = 240;
      const MIN_DATA_COL_W = 120;
      const MIN_CANVAS_W = 960;
      const rawTableW = CAT_COL_W + colCount * MIN_DATA_COL_W;
      const tableW = Math.max(rawTableW, MIN_CANVAS_W - 40);
      const DATA_COL_W = Math.floor((tableW - CAT_COL_W) / colCount);
      const CANVAS_W = CAT_COL_W + colCount * DATA_COL_W + 40;
      const HEADER_H = 110;
      const COL_HEAD_H = 55;
      const ROW_H = 28;
      const TOTAL_H = 45;
      const CANVAS_H = HEADER_H + COL_HEAD_H + sheet.rows.length * ROW_H + TOTAL_H + 30;

      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W * DPR;
      canvas.height = CANVAS_H * DPR;
      const ctx = canvas.getContext('2d');
      ctx.scale(DPR, DPR);

      // 1. Background Fill
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // 2. Header Box
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(20, 20, CANVAS_W - 40, 70);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(20, 20, CANVAS_W - 40, 70);

      // Primary Accent stripe
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(20, 20, CANVAS_W - 40, 4);

      // Title & Subtitle
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText('Trendz Tracker - Main Round Scoresheet', 36, 48);

      const partSuffix = chunkCount > 1 ? ` | Part ${chunkIdx + 1} of ${chunkCount} (Rounds ${colStart + 1}-${colEnd})` : '';
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${sheet.title} | ${sheet.unitLabel}${partSuffix}`, 36, 70);

      // Student Meta (Right side)
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${viewModel.studentInfo.name} (${viewModel.studentInfo.code})`, CANVAS_W - 36, 48);
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.fillText(`Group: ${viewModel.studentInfo.group} | Period: ${viewModel.periodLabel}`, CANVAS_W - 36, 70);
      ctx.textAlign = 'left';

      // 3. Table Column Headers
      let curY = 105;
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(20, curY, CANVAS_W - 40, COL_HEAD_H);
      ctx.strokeRect(20, curY, CANVAS_W - 40, COL_HEAD_H);

      // Category Header Cell
      ctx.fillStyle = '#475569';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('CATEGORY', 32, curY + 32);

      // Column Header Cells
      pageCols.forEach((col, idx) => {
        const cellX = 20 + CAT_COL_W + idx * DATA_COL_W;
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(cellX, curY);
        ctx.lineTo(cellX, curY + COL_HEAD_H);
        ctx.stroke();

        const lines = formatColumnHeaderLabel(col.label || `Round ${col.roundNumber}`, DATA_COL_W - 20);
        const line1 = lines[0] || '';
        const line2 = lines[1] || '';

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 11px sans-serif';
        if (line2) {
          ctx.fillText(line1, cellX + 10, curY + 16);
          ctx.fillText(line2, cellX + 10, curY + 28);
        } else {
          ctx.fillText(line1, cellX + 10, curY + 20);
        }

        ctx.fillStyle = '#64748b';
        ctx.font = '10px sans-serif';
        ctx.fillText(col.displayDate || col.dateStr, cellX + 10, curY + 39);

        ctx.fillStyle = col.status === 'Completed' ? '#16a34a' : '#d97706';
        ctx.font = 'bold 9.5px sans-serif';
        ctx.fillText(col.status, cellX + 10, curY + 50);
      });

      curY += COL_HEAD_H;

      // 4. Category Rows
      sheet.rows.forEach((row, rIdx) => {
        const isAlt = rIdx % 2 === 1;
        ctx.fillStyle = isAlt ? '#f8fafc' : '#ffffff';
        ctx.fillRect(20, curY, CANVAS_W - 40, ROW_H);

        ctx.strokeStyle = '#e2e8f0';
        ctx.strokeRect(20, curY, CANVAS_W - 40, ROW_H);

        // Category name
        ctx.fillStyle = '#1e293b';
        ctx.font = '500 12px sans-serif';
        const name = row.category.name || row.category.key;
        ctx.fillText(name.length > 28 ? name.slice(0, 27) + '…' : name, 32, curY + 18);

        // Cells
        for (let idx = 0; idx < colCount; idx++) {
          const originalColIdx = colStart + idx;
          const cell = row.cells[originalColIdx];
          const cellX = 20 + CAT_COL_W + idx * DATA_COL_W;

          ctx.beginPath();
          ctx.moveTo(cellX, curY);
          ctx.lineTo(cellX, curY + ROW_H);
          ctx.stroke();

          if (cell.status === 'missing') {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '12px monospace';
          } else if (cell.status === 'zero') {
            ctx.fillStyle = '#dc2626';
            ctx.font = 'bold 12px monospace';
          } else if (cell.status === 'in_progress') {
            ctx.fillStyle = '#d97706';
            ctx.font = 'italic 11px sans-serif';
          } else if (cell.status === 'review_error') {
            ctx.fillStyle = '#dc2626';
            ctx.font = 'bold 11px sans-serif';
          } else {
            ctx.fillStyle = '#0f172a';
            ctx.font = '600 12px monospace';
          }

          ctx.fillText(cell.display || '—', cellX + 12, curY + 18);
        }

        curY += ROW_H;
      });

      // 5. Bottom Totals Row
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(20, curY, CANVAS_W - 40, TOTAL_H);
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(20, curY, CANVAS_W - 40, TOTAL_H);

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('TOTAL & ACCURACY', 32, curY + 27);

      for (let idx = 0; idx < colCount; idx++) {
        const originalColIdx = colStart + idx;
        const tot = sheet.totals.columnTotals[originalColIdx];
        const cellX = 20 + CAT_COL_W + idx * DATA_COL_W;

        ctx.strokeStyle = '#cbd5e1';
        ctx.beginPath();
        ctx.moveTo(cellX, curY);
        ctx.lineTo(cellX, curY + TOTAL_H);
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(tot?.scoreText || '—', cellX + 10, curY + 18);

        ctx.fillStyle = '#334155';
        ctx.font = '11px sans-serif';
        ctx.fillText(tot?.accuracyText || '—', cellX + 10, curY + 34);
      }

      const partNum = chunkIdx + 1;
      const filename = `Main_Round_Scoresheet_${viewModel.studentInfo.code}_${sheet.sheetId || sheet.type}_part${partNum}.png`;

      const blobPromise = new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });

      results.push({
        canvas,
        filename,
        partIndex: chunkIdx,
        totalParts: chunkCount,
        blobPromise,
      });
    }
  }

  return results;
}

/**
 * Downloads all generated PNG image parts for the scoresheet.
 */
export async function downloadScoresheetImages(viewModel) {
  const canvases = renderScoresheetToCanvases(viewModel);
  if (canvases.length === 0) return;

  for (const item of canvases) {
    const blob = await item.blobPromise;
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

// =============================================================================
// NATIVE SHARE HANDLER WITH DOWNLOAD FALLBACK
// =============================================================================

/**
 * Triggers native device file sharing (e.g. WhatsApp, Drive, AirDrop) if supported,
 * otherwise automatically downloads the file as a safe fallback.
 * Strictly requires explicit student click; never contacts anyone automatically.
 */
export async function shareScoresheet({
  format = 'pdf', // 'pdf' | 'image'
  viewModel,
  onToast = (type, msg) => {},
}) {
  if (!viewModel || !viewModel.isValid) {
    onToast('error', 'Cannot share invalid scoresheet.');
    return { shared: false };
  }

  // Prevent sharing if data loading failed
  if (hasScoresheetLoadErrors(viewModel)) {
    const errMsg = viewModel.loadErrors?.manual || viewModel.loadErrors?.online || 'Score history has unrecovered loading failures.';
    onToast('error', 'Cannot share scoresheet while scores failed to load. Please click retry.');
    return { shared: false, error: errMsg };
  }

  const studentName = viewModel.studentInfo?.name || 'Student';
  const studentCode = viewModel.studentInfo?.code || 'STU';
  const title = `Main Round Scoresheet - ${studentName}`;
  const text = `Main Round scoresheet for ${studentName} (${studentCode}) · ${viewModel.periodLabel}`;

  if (format === 'pdf') {
    const bytes = buildScoresheetPdfBytes(viewModel);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const filename = `Main_Round_Scoresheet_${studentCode}.pdf`;

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        const file = new File([blob], filename, { type: 'application/pdf' });
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title,
            text,
          });
          onToast('success', 'Scoresheet PDF shared successfully!');
          return { shared: true, method: 'native_share', fileCount: 1 };
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          // Student cancelled share dialog
          return { shared: false, cancelled: true };
        }
        console.warn('Native PDF share error:', err);
        downloadScoresheetPdf(viewModel, filename);
        onToast('info', 'Sharing failed on this device. The PDF was downloaded so you can share it manually.');
        return { shared: false, fallbackDownloaded: true, fileCount: 1, error: err.message };
      }
    }

    // Download fallback
    downloadScoresheetPdf(viewModel, filename);
    onToast('info', 'File sharing is not supported on this browser. The PDF was downloaded so you can share it manually.');
    return { shared: false, fallbackDownloaded: true, fileCount: 1 };
  }

  // Format: Image
  const canvases = renderScoresheetToCanvases(viewModel);
  if (canvases.length === 0) {
    onToast('error', 'No scores to export as image.');
    return { shared: false };
  }

  // Await all generated image parts
  const files = [];
  for (const part of canvases) {
    const b = await part.blobPromise;
    if (b) {
      files.push(new File([b], part.filename, { type: 'image/png' }));
    }
  }

  if (files.length === 0) {
    onToast('error', 'Failed to generate image files for sharing.');
    return { shared: false };
  }

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const canShareAll = typeof navigator.canShare === 'function' ? navigator.canShare({ files }) : false;

    if (canShareAll) {
      try {
        await navigator.share({
          files,
          title,
          text,
        });
        const partMsg = files.length > 1
          ? `All ${files.length} scoresheet image parts shared successfully!`
          : 'Scoresheet image shared successfully!';
        onToast('success', partMsg);
        return { shared: true, method: 'native_share', fileCount: files.length };
      } catch (err) {
        if (err.name === 'AbortError') {
          return { shared: false, cancelled: true };
        }
        console.warn('Native image share error:', err);
        await downloadScoresheetImages(viewModel);
        onToast('info', 'Sharing failed on this device. All image parts were downloaded so you can share them manually, or use the complete PDF.');
        return { shared: false, fallbackDownloaded: true, fileCount: files.length, error: err.message };
      }
    } else {
      // Device / browser cannot share multiple files at once
      await downloadScoresheetImages(viewModel);
      const explanation = files.length > 1
        ? `Your device or browser does not support sharing multiple image parts (${files.length} parts) at once. All ${files.length} numbered images have been downloaded, or you can share the complete PDF instead.`
        : 'File sharing is not supported on this browser. The image was downloaded so you can share it manually.';
      onToast('info', explanation);
      return { shared: false, fallbackDownloaded: true, multiPartUnsupported: files.length > 1, fileCount: files.length };
    }
  }

  // Fallback download if navigator.share is not present
  await downloadScoresheetImages(viewModel);
  const noShareMsg = files.length > 1
    ? `File sharing is not supported on this browser. All ${files.length} image parts were downloaded so you can share them manually, or share the complete PDF instead.`
    : 'File sharing is not supported on this browser. All image parts were downloaded so you can share them manually.';
  onToast('info', noShareMsg);
  return { shared: false, fallbackDownloaded: true, fileCount: files.length };
}


// =============================================================================
// DOM RENDERING & CONTROLLER IMPLEMENTATION
// =============================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Returns true if the active source filter has unrecovered load failures
 * or if any rendered column has review-breakdown errors.
 */
export function hasScoresheetLoadErrors(viewModel) {
  if (!viewModel) return false;
  const isManualActive = viewModel.sourceFilter === 'both' || viewModel.sourceFilter === 'manual';
  const isOnlineActive = viewModel.sourceFilter === 'both' || viewModel.sourceFilter === 'online';
  if (isManualActive && viewModel.loadErrors?.manual) return true;
  if (isOnlineActive && viewModel.loadErrors?.online) return true;
  for (const sheet of viewModel.sheets || []) {
    if (sheet.columns?.some((c) => c.reviewError)) return true;
  }
  return false;
}

/**
 * Generates semantic, accessible HTML for the Excel-like scoresheet view.
 */
export function renderScoresheetHTML(viewModel) {
  if (!viewModel || !viewModel.isValid) {
    return `
      <div class="banner banner-error" role="alert" style="margin-bottom: var(--space-4);">
        <span class="banner-icon" aria-hidden="true">⚠️</span>
        <span>${escapeHtml(viewModel?.error || 'Invalid date range or scoresheet settings.')}</span>
      </div>
      <div class="empty-state" style="padding: var(--space-8); text-align: center;">
        <div style="font-size: 2.25rem; margin-bottom: var(--space-2);">📋</div>
        <h3 class="empty-state-title">No scoresheet data</h3>
        <p class="empty-state-desc">Please choose a valid date period.</p>
      </div>
    `;
  }

  const isManualActive = viewModel.sourceFilter === 'both' || viewModel.sourceFilter === 'manual';
  const isOnlineActive = viewModel.sourceFilter === 'both' || viewModel.sourceFilter === 'online';
  const manualLoadError = isManualActive ? viewModel.loadErrors?.manual : null;
  const onlineLoadError = isOnlineActive ? viewModel.loadErrors?.online : null;
  const reviewErrorCount = viewModel.loadErrors?.reviews?.size || 0;
  const hasActiveErrors = Boolean(manualLoadError || onlineLoadError || (isOnlineActive && reviewErrorCount > 0));

  let errorBannersHtml = '';
  if (manualLoadError) {
    errorBannersHtml += `
      <div class="banner banner-error scoresheet-load-error-banner" role="alert" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-4); padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--radius-md); color: #991b1b;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.25rem;">⚠️</span>
          <div>
            <strong>Manual scores failed to load:</strong> ${escapeHtml(manualLoadError)}
          </div>
        </div>
        <button type="button" id="btn-retry-manual" class="btn btn-outline btn-sm" style="color: #991b1b; border-color: #f87171; background: #ffffff; font-weight: 700;">
          🔄 Retry Manual
        </button>
      </div>
    `;
  }

  if (onlineLoadError) {
    errorBannersHtml += `
      <div class="banner banner-error scoresheet-load-error-banner" role="alert" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-4); padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--radius-md); color: #991b1b;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.25rem;">⚠️</span>
          <div>
            <strong>Online practice failed to load:</strong> ${escapeHtml(onlineLoadError)}
          </div>
        </div>
        <button type="button" id="btn-retry-online" class="btn btn-outline btn-sm" style="color: #991b1b; border-color: #f87171; background: #ffffff; font-weight: 700;">
          🔄 Retry Online
        </button>
      </div>
    `;
  }

  if (reviewErrorCount > 0 && isOnlineActive) {
    errorBannersHtml += `
      <div class="banner banner-error scoresheet-load-error-banner" role="alert" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-4); padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--radius-md); color: #991b1b;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.25rem;">⚠️</span>
          <div>
            <strong>Review breakdown failed to load:</strong> Detailed score breakdown for ${reviewErrorCount} ${reviewErrorCount === 1 ? 'attempt' : 'attempts'} could not be retrieved.
          </div>
        </div>
        <button type="button" id="btn-retry-reviews" class="btn btn-outline btn-sm" style="color: #991b1b; border-color: #f87171; background: #ffffff; font-weight: 700;">
          🔄 Retry Reviews
        </button>
      </div>
    `;
  }

  if (viewModel.isEmpty) {
    if (hasActiveErrors) {
      return `
        ${errorBannersHtml}
        <div class="empty-state scoresheet-empty-error" style="padding: var(--space-8); text-align: center; background: var(--bg-surface); border: 1px solid #fca5a5; border-radius: var(--radius-lg);">
          <div style="font-size: 2.5rem; margin-bottom: var(--space-2);">⚠️</div>
          <h3 class="empty-state-title" style="margin-bottom: var(--space-2); color: #b91c1c;">Scoresheet history could not be loaded</h3>
          <p class="empty-state-desc" style="max-width: 480px; margin: 0 auto var(--space-4) auto; font-size: var(--text-sm); color: var(--text-muted);">
            One or more score sources failed to load from the server. Check your connection and retry loading.
          </p>
          <button type="button" id="btn-retry-scoresheet" class="btn btn-primary btn-sm" style="font-weight: 700;">
            🔄 Retry Loading Scores
          </button>
        </div>
      `;
    }

    return `
      ${errorBannersHtml}
      <div class="empty-state" style="padding: var(--space-8); text-align: center; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);">
        <div style="font-size: 2.5rem; margin-bottom: var(--space-2);">📊</div>
        <h3 class="empty-state-title" style="margin-bottom: var(--space-2);">No scores recorded for this period</h3>
        <p class="empty-state-desc" style="max-width: 480px; margin: 0 auto var(--space-4) auto; font-size: var(--text-sm); color: var(--text-muted);">
          No practice rounds or online attempts were found for <strong>${escapeHtml(viewModel.periodLabel)}</strong>.
          Try selecting a wider date range like <em>Last 30 days</em> or <em>All time</em>, or switch the source filter.
        </p>
      </div>
    `;
  }

  let html = errorBannersHtml;

  viewModel.sheets.forEach((sheet, sheetIdx) => {
    const isManual = sheet.type === 'manual';
    const isOnline = sheet.type === 'online';
    const sheetId = `scoresheet-table-wrap-${sheetIdx}`;

    html += `
      <section class="card scoresheet-section-card" style="padding: var(--space-4) var(--space-5); margin-bottom: var(--space-5); border: 1px solid var(--border-subtle); background: var(--bg-surface); box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        <!-- Sheet Header Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-3); padding-bottom: var(--space-3); border-bottom: 1px solid var(--border-subtle);">
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            <span class="badge ${isOnline ? 'badge-primary' : 'badge-neutral'}" style="font-size: 11px; font-weight: 700;">
              ${escapeHtml(isOnline ? 'Online Practice' : 'Manual Practice')}
            </span>
            <h2 style="font-size: var(--text-md); margin: 0; font-weight: 800; color: var(--text-main);">
              ${escapeHtml(sheet.title)}
            </h2>
          </div>
          <div style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 600;">
            Unit: <span style="color: var(--text-main); font-weight: 700;">${escapeHtml(sheet.unitLabel)}</span>
            <span style="margin: 0 4px;">·</span>
            <span class="num">${sheet.columns.length} ${sheet.columns.length === 1 ? 'round' : 'rounds'}</span>
          </div>
        </div>

        <!-- Excel-like Table Scroll Container -->
        <div class="scoresheet-scroll-pane" id="${sheetId}" style="overflow: auto; max-height: calc(100vh - 300px); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: #ffffff;">
          <table class="scoresheet-grid-table" style="width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-xs); font-family: inherit;">
            <thead>
              <tr>
                <th class="scoresheet-corner-cell" style="position: sticky; top: 0; left: 0; z-index: 12; background: #f8fafc; color: #475569; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 14px; border-bottom: 2px solid #cbd5e1; border-right: 2px solid #cbd5e1; min-width: 180px; text-align: left;">
                  Category
                </th>
                ${sheet.columns.map((col) => {
                  const isErr = Boolean(col.reviewError);
                  return `
                  <th class="scoresheet-col-header ${isErr ? 'has-review-error' : ''}" style="position: sticky; top: 0; z-index: 10; background: ${isErr ? '#fef2f2' : '#f8fafc'}; color: #0f172a; padding: 8px 12px; border-bottom: 2px solid ${isErr ? '#f87171' : '#cbd5e1'}; border-right: 1px solid #e2e8f0; min-width: 105px; text-align: center;">
                    <div style="font-weight: 800; font-size: 12px; white-space: nowrap;">${escapeHtml(col.label)}</div>
                    <div class="num" style="font-size: 10px; color: #64748b; font-weight: 500; margin-top: 2px; white-space: nowrap;">${escapeHtml(col.displayDate)}</div>
                    <div style="margin-top: 4px;">
                      <span class="badge ${isErr ? 'badge-error' : (col.status === 'Completed' ? 'badge-active' : 'badge-inactive')}" style="font-size: 9.5px; padding: 1px 6px; font-weight: 700;" ${isErr ? `title="${escapeHtml(col.reviewError)}"` : ''}>
                        ${escapeHtml(isErr ? 'Review Error' : col.status)}
                      </span>
                    </div>
                  </th>
                `;
                }).join('')}
              </tr>
            </thead>
            <tbody>
              ${sheet.rows.map((row, rIdx) => {
                const isAlt = rIdx % 2 === 1;
                const catName = row.category.name || row.category.key;
                return `
                  <tr style="background: ${isAlt ? '#f8fafc' : '#ffffff'};">
                    <td class="scoresheet-cat-cell" style="position: sticky; left: 0; z-index: 9; background: ${isAlt ? '#f8fafc' : '#ffffff'}; font-weight: 700; color: #1e293b; padding: 8px 14px; border-bottom: 1px solid #e2e8f0; border-right: 2px solid #cbd5e1; white-space: nowrap;">
                      ${escapeHtml(catName)}
                    </td>
                    ${row.cells.map((cell) => {
                      let cellStyle = 'padding: 8px 10px; border-bottom: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; text-align: center; font-variant-numeric: tabular-nums;';
                      let content = escapeHtml(cell.display || '—');

                      if (cell.status === 'zero') {
                        cellStyle += ' color: #dc2626; font-weight: 800; background: rgba(239, 68, 68, 0.05);';
                      } else if (cell.status === 'missing') {
                        cellStyle += ' color: #94a3b8; font-weight: normal;';
                      } else if (cell.status === 'in_progress') {
                        cellStyle += ' color: #d97706; font-style: italic; font-size: 11px;';
                        content = '<span title="Attempt in progress · scores excluded from grand totals">In progress</span>';
                      } else if (cell.status === 'review_error') {
                        cellStyle += ' color: #dc2626; font-weight: 700; font-size: 11px; background: rgba(239, 68, 68, 0.08);';
                        content = `<span title="${escapeHtml(cell.note || 'Review breakdown failed to load')}">⚠️ Error</span>`;
                      } else if (cell.status === 'note') {
                        cellStyle += ' color: #2563eb; font-weight: 600; font-size: 11px;';
                      } else {
                        cellStyle += ' color: #0f172a; font-weight: 700;';
                      }

                      const lockIcons = cell.isVerified
                        ? '<span title="Verified by teacher" style="font-size: 10px; margin-left: 2px;">🔒</span>'
                        : cell.isCorrected
                          ? '<span title="Corrected by teacher" style="font-size: 10px; margin-left: 2px; color: #2563eb;">✏️</span>'
                          : '';

                      return `<td style="${cellStyle}">${content}${lockIcons}</td>`;
                    }).join('')}
                  </tr>
                `;
              }).join('')}
            </tbody>
            <tfoot>
              <!-- Totals Row -->
              <tr style="position: sticky; bottom: 0; z-index: 11; background: #f1f5f9; border-top: 2px solid #cbd5e1; font-weight: 800;">
                <td style="position: sticky; left: 0; z-index: 12; background: #f1f5f9; padding: 10px 14px; border-top: 2px solid #cbd5e1; border-right: 2px solid #cbd5e1; color: #0f172a; font-size: 11px; text-transform: uppercase;">
                  ${isOnline ? 'Total Marks' : 'Total Score'}
                </td>
                ${sheet.totals.columnTotals.map((tot) => `
                  <td class="num" style="padding: 8px 10px; border-top: 2px solid #cbd5e1; border-right: 1px solid #e2e8f0; text-align: center; color: #0f172a; font-weight: 800; font-size: 12px;">
                    ${escapeHtml(tot.scoreText)}
                  </td>
                `).join('')}
              </tr>
              <!-- Accuracy / Percentage Row -->
              <tr style="position: sticky; bottom: 0; z-index: 11; background: #f1f5f9;">
                <td style="position: sticky; left: 0; z-index: 12; background: #f1f5f9; padding: 6px 14px; border-right: 2px solid #cbd5e1; color: #475569; font-size: 11px;">
                  ${isOnline ? 'Mark %' : 'Accuracy %'}
                </td>
                ${sheet.totals.columnTotals.map((tot) => `
                  <td class="num" style="padding: 6px 10px; border-right: 1px solid #e2e8f0; text-align: center; color: #2563eb; font-weight: 700; font-size: 11.5px;">
                    ${escapeHtml(tot.accuracyText)}
                  </td>
                `).join('')}
              </tr>
              <!-- Time Row -->
              <tr style="position: sticky; bottom: 0; z-index: 11; background: #f1f5f9; border-bottom: 2px solid #cbd5e1;">
                <td style="position: sticky; left: 0; z-index: 12; background: #f1f5f9; padding: 6px 14px; border-right: 2px solid #cbd5e1; border-bottom: 2px solid #cbd5e1; color: #475569; font-size: 11px;">
                  ${isOnline ? 'Active Time' : 'Round Time'}
                </td>
                ${sheet.totals.columnTotals.map((tot) => `
                  <td class="num" style="padding: 6px 10px; border-right: 1px solid #e2e8f0; border-bottom: 2px solid #cbd5e1; text-align: center; color: #64748b; font-size: 11px;">
                    ${escapeHtml(tot.timeText)}
                  </td>
                `).join('')}
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    `;
  });

  return html;
}

/**
 * Injects scoped styles for the scoresheet, Clean View chrome hiding, and mobile scroll containment.
 */
export function ensureScoresheetStyles() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || !document.head) return;
  if (document.getElementById('main-round-scoresheet-styles')) return;
  const style = document.createElement('style');
  style.id = 'main-round-scoresheet-styles';
  style.textContent = `
    .scoresheet-scroll-pane {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      overflow-x: auto !important;
      overflow-y: auto !important;
      -webkit-overflow-scrolling: touch !important;
      overscroll-behavior-x: contain !important;
    }
    .scoresheet-grid-table th,
    .scoresheet-grid-table td {
      white-space: nowrap;
    }
    body.scoresheet-capture-active {
      overflow-x: hidden !important;
    }
    body.scoresheet-capture-active .app-header,
    body.scoresheet-capture-active .section-header-row,
    body.scoresheet-capture-active #config-banner-placeholder,
    body.scoresheet-capture-active .scoresheet-controls-card,
    body.scoresheet-capture-active #jmcwc-combined-history-card,
    body.scoresheet-capture-active #sticky-save-bar,
    body.scoresheet-capture-active footer,
    body.scoresheet-capture-active .app-footer {
      display: none !important;
    }
    body.scoresheet-capture-active .main-content {
      padding: var(--space-2) 0 !important;
      max-width: 100vw !important;
      overflow-x: hidden !important;
    }
    body.scoresheet-capture-active .container {
      padding-left: var(--space-2) !important;
      padding-right: var(--space-2) !important;
      max-width: 100vw !important;
      box-sizing: border-box !important;
      overflow-x: hidden !important;
    }
    body.scoresheet-capture-active #main-round-preview-pane,
    body.scoresheet-capture-active #scoresheet-container,
    body.scoresheet-capture-active .scoresheet-wrapper {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      overflow-x: hidden !important;
    }
    body.scoresheet-capture-active .scoresheet-section-card {
      padding: var(--space-3) var(--space-2) !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
    .btn-scoresheet-exit {
      background: #ffffff !important;
      color: #0f172a !important;
      border: 1px solid #cbd5e1 !important;
    }
    .btn-scoresheet-exit:hover,
    .btn-scoresheet-exit:focus {
      background: #f1f5f9 !important;
      color: #0f172a !important;
      border-color: #94a3b8 !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Interactive Scoresheet Controller handling filters, zoom, clean capture view, and exports.
 */
export class ScoresheetController {
  constructor({
    containerEl,
    currentProfile = {},
    todayIST = '',
    getSupabase = async () => null,
    isDemo = false,
    DemoDB = null,
    callJmcwcApi = async () => ({}),
    showToast = () => {},
  }) {
    this.containerEl = containerEl;
    this.currentProfile = currentProfile;
    this.todayIST = todayIST || getISTDateString(new Date());
    this.getSupabase = getSupabase;
    this.isDemo = isDemo;
    this.DemoDB = DemoDB;
    this.callJmcwcApi = callJmcwcApi;
    this.showToast = showToast;

    // State
    this.sourceFilter = 'both';
    this.preset = 'last7';
    this.customFrom = '';
    this.customTo = '';
    this.zoomScale = 1.0;
    this.isCleanView = false;
    this._escListener = null;

    // Loading & Error States
    this.isLoading = false;
    this.loadErrors = {
      manual: null,
      online: null,
      reviews: new Map(),
    };

    // Loaded Raw Data Caches
    this.manualRounds = [];
    this.seriesCategories = [];
    this.manualResults = [];
    this.roundSeriesList = [];
    this.onlineAttempts = [];
    this.onlineCategories = AUTHORITATIVE_JMCWC_CATEGORIES;
    this.onlineReviewCache = new Map();
    this.jmcwcAssignment = null;
    this.papersMap = new Map();
  }

  setCleanView(active) {
    this.isCleanView = Boolean(active);
    ensureScoresheetStyles();
    if (typeof document !== 'undefined' && document.body?.classList) {
      if (this.isCleanView) {
        document.body.classList.add('scoresheet-capture-active');
      } else {
        document.body.classList.remove('scoresheet-capture-active');
      }
    }
    this.render();
  }

  destroy() {
    if (typeof document !== 'undefined' && document.body?.classList) {
      document.body.classList.remove('scoresheet-capture-active');
    }
    if (this._escListener && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._escListener);
      this._escListener = null;
    }
  }

  async init() {
    ensureScoresheetStyles();
    this.renderSkeleton();
    await this.loadAllStudentData();
    this.render();
    this.bindEvents();
  }

  renderSkeleton() {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = `
      <div style="padding: var(--space-6); text-align: center;">
        <div class="skeleton-row" style="height: 48px; margin-bottom: var(--space-3);"></div>
        <div class="skeleton-row" style="height: 320px;"></div>
      </div>
    `;
  }

  async loadAllStudentData() {
    this.isLoading = true;
    this.loadErrors = {
      manual: null,
      online: null,
      reviews: new Map(),
    };

    try {
      if (!this.isDemo) {
        const supabase = await this.getSupabase();
        if (supabase) {
          const studentId = this.currentProfile.id;

          // 1. Fetch manual metadata and categories (Public/Authenticated tables)
          const [seriesRes, catSeriesRes, allCatsRes] = await Promise.all([
            supabase.from('round_series').select('id, name, is_current'),
            supabase
              .from('category_series')
              .select('category_id, series_id, sort_order, category:categories(id, name, section, active)')
              .order('sort_order', { ascending: true }),
            supabase.from('categories').select('id, name, section, active'),
          ]);

          if (seriesRes?.error) {
            this.loadErrors.manual = seriesRes.error.message || 'Failed to load round series';
          }
          if (catSeriesRes?.error) {
            this.loadErrors.manual = catSeriesRes.error.message || 'Failed to load category series';
          }
          if (allCatsRes?.error) {
            this.loadErrors.manual = allCatsRes.error.message || 'Failed to load categories';
          }

          this.roundSeriesList = seriesRes?.data || [];
          this.jmcwcAssignment = null;

          const allCatsMap = new Map();
          (allCatsRes?.data || []).forEach((c) => allCatsMap.set(c.id, c));

          // Retain all categories in series (DO NOT exclude active === false!)
          this.seriesCategories = (catSeriesRes?.data || [])
            .filter((item) => item.category && item.category.section === 'round')
            .map((item) => ({
              id: item.category.id,
              name: item.category.name,
              series_id: item.series_id,
              series_sort_order: item.sort_order,
              active: item.category.active !== false,
            }));

          // 2. Paginate manual student_rounds with deterministic unique ordering
          try {
            let roundFrom = 0;
            const ROUND_PAGE_SIZE = 500;
            const allRounds = [];
            while (true) {
              const { data: pageRounds, error: rErr } = await supabase
                .from('student_rounds')
                .select('id, student_id, series_id, round_number, round_date, round_type, time_taken_seconds, created_at')
                .eq('student_id', studentId)
                .order('round_date', { ascending: false })
                .order('round_number', { ascending: false })
                .order('id', { ascending: true })
                .range(roundFrom, roundFrom + ROUND_PAGE_SIZE - 1);
              if (rErr) throw rErr;
              if (!pageRounds || pageRounds.length === 0) break;
              allRounds.push(...pageRounds);
              if (pageRounds.length < ROUND_PAGE_SIZE) break;
              roundFrom += pageRounds.length;
            }
            this.manualRounds = allRounds;
          } catch (rErr) {
            console.error('Error loading student_rounds:', rErr);
            this.loadErrors.manual = rErr.message || 'Failed to load round history';
            this.manualRounds = [];
          }

          // 3. Batch and paginate results for all student rounds
          const roundIds = this.manualRounds.map((r) => r.id);
          if (roundIds.length > 0 && !this.loadErrors.manual) {
            try {
              const allResults = [];
              const CHUNK_SIZE = 100;
              for (let i = 0; i < roundIds.length; i += CHUNK_SIZE) {
                const idChunk = roundIds.slice(i, i + CHUNK_SIZE);
                let resFrom = 0;
                const RES_PAGE_SIZE = 500;
                while (true) {
                  const { data: chunkResults, error: resErr } = await supabase
                    .from('results')
                    .select('id, student_round_id, category_id, correct, total, time_seconds, note, verified, verified_at, verified_by, corrected_at, corrected_by')
                    .eq('student_id', studentId)
                    .in('student_round_id', idChunk)
                    .order('student_round_id', { ascending: true })
                    .order('category_id', { ascending: true })
                    .order('id', { ascending: true })
                    .range(resFrom, resFrom + RES_PAGE_SIZE - 1);
                  if (resErr) throw resErr;
                  if (!chunkResults || chunkResults.length === 0) break;
                  allResults.push(...chunkResults);
                  if (chunkResults.length < RES_PAGE_SIZE) break;
                  resFrom += chunkResults.length;
                }
              }
              this.manualResults = allResults;

              // Ensure any historical category with recorded results is added to seriesCategories
              const knownCatIds = new Set(this.seriesCategories.map((c) => c.id));
              this.manualResults.forEach((res) => {
                if (res.category_id && !knownCatIds.has(res.category_id)) {
                  const catMeta = allCatsMap.get(res.category_id);
                  this.seriesCategories.push({
                    id: res.category_id,
                    name: catMeta?.name || 'Historical Category',
                    series_id: null,
                    series_sort_order: 9999,
                    active: false,
                  });
                  knownCatIds.add(res.category_id);
                }
              });
            } catch (resErr) {
              console.error('Error loading results:', resErr);
              this.loadErrors.manual = resErr.message || 'Failed to load score results';
              this.manualResults = [];
            }
          } else {
            this.manualResults = [];
          }

          // 4. Paginate online attempts via JMCWC API offset and fetch authorized online metadata
          try {
            // First fetch overview to resolve authoritative online categories, published paper & student assignment
            try {
              const overviewAction = this.currentProfile?.role === 'admin' ? 'admin_get_overview' : 'get_practice_overview';
              const overviewRes = await this.callJmcwcApi({ action: overviewAction });
              if (overviewRes?.error) {
                this.loadErrors.online = overviewRes.error.message || overviewRes.error || 'Failed to load online categories';
              } else {
                if (Array.isArray(overviewRes?.categories) && overviewRes.categories.length > 0) {
                  this.onlineCategories = [...overviewRes.categories].sort(
                    (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
                  );
                }
                if (overviewRes?.paper?.id) {
                  this.papersMap.set(overviewRes.paper.id, overviewRes.paper);
                }
                if (Array.isArray(overviewRes?.papers)) {
                  overviewRes.papers.forEach((p) => {
                    if (p?.id) this.papersMap.set(p.id, p);
                  });
                }
                if (overviewRes?.group_key) {
                  this.jmcwcAssignment = { student_id: studentId, group_key: overviewRes.group_key };
                } else if (Array.isArray(overviewRes?.assignments)) {
                  const studentAssign = overviewRes.assignments.find((a) => a.student_id === studentId);
                  if (studentAssign) {
                    this.jmcwcAssignment = studentAssign;
                  }
                }
              }
            } catch (ovErr) {
              console.warn('Overview fetch warning:', ovErr?.message);
              this.loadErrors.online = ovErr.message || 'Failed to load online practice metadata';
            }

            let offset = 0;
            const JMCWC_PAGE_SIZE = 50;
            const allOnlineAttempts = [];
            while (true) {
              const attemptsRes = await this.callJmcwcApi({ action: 'list_attempts', offset });
              if (attemptsRes?.error) {
                throw new Error(attemptsRes.error);
              }
              const batch = Array.isArray(attemptsRes?.attempts) ? attemptsRes.attempts : [];
              if (batch.length === 0) break;
              allOnlineAttempts.push(...batch);
              if (batch.length < JMCWC_PAGE_SIZE) break;
              offset += batch.length;
            }
            this.onlineAttempts = allOnlineAttempts;

            // Preload reviews for submitted flat rounds with BOUNDED CONCURRENCY (max 3 concurrent)
            const submittedFlat = this.onlineAttempts.filter((a) => a.status === 'submitted' && a.mode === 'flat');
            const CONCURRENCY_LIMIT = 3;
            for (let i = 0; i < submittedFlat.length; i += CONCURRENCY_LIMIT) {
              const chunk = submittedFlat.slice(i, i + CONCURRENCY_LIMIT);
              await Promise.all(
                chunk.map(async (att) => {
                  const cached = this.onlineReviewCache.get(att.id);
                  const hasSuccessfulReview = Array.isArray(cached) || (cached && !cached.error && Array.isArray(cached.review));
                  if (!hasSuccessfulReview) {
                    try {
                      const reviewRes = await this.callJmcwcApi({ action: 'get_attempt_review', attempt_id: att.id });
                      if (reviewRes?.error) {
                        throw new Error(reviewRes.error);
                      }
                      const reviewList = reviewRes?.attempt?.review;
                      if (!Array.isArray(reviewList)) {
                        throw new Error('Review breakdown response is missing or malformed');
                      }
                      this.onlineReviewCache.set(att.id, reviewList);
                      this.loadErrors.reviews.delete(att.id);
                    } catch (e) {
                      console.warn(`Review fetch error for attempt ${att.id}:`, e.message);
                      this.loadErrors.reviews.set(att.id, e.message || 'Failed to load review breakdown');
                      this.onlineReviewCache.set(att.id, { error: e.message || 'Failed to load review breakdown' });
                    }
                  }
                })
              );
            }
          } catch (jmcwcErr) {
            console.error('JMCWC attempts fetch in scoresheet:', jmcwcErr?.message);
            this.loadErrors.online = jmcwcErr.message || 'Failed to load online practice history';
            this.onlineAttempts = [];
          }
        }
      } else if (this.DemoDB) {
        // Demo Mode Local Storage
        const studentId = this.currentProfile.id;
        this.roundSeriesList = this.DemoDB.getRoundSeries();
        this.manualRounds = this.DemoDB.getStudentRounds(studentId);

        const allCats = this.DemoDB.getCategories();
        const catMap = new Map(allCats.map((c) => [c.id, c]));
        const catSeries = this.DemoDB.getCategorySeries();
        // Do NOT exclude active: false in demo mode either!
        this.seriesCategories = catSeries
          .map((cs) => {
            const cat = catMap.get(cs.category_id);
            if (!cat || cat.section !== 'round') return null;
            return {
              id: cat.id,
              name: cat.name,
              series_id: cs.series_id,
              series_sort_order: cs.sort_order,
              active: cat.active !== false,
            };
          })
          .filter(Boolean);

        const allResults = [];
        this.manualRounds.forEach((r) => {
          const res = this.DemoDB.getRoundResults(r.id);
          allResults.push(...res);
        });
        this.manualResults = allResults;
        this.onlineCategories = AUTHORITATIVE_JMCWC_CATEGORIES;
        this.onlineAttempts = [];
      }
    } catch (err) {
      console.error('Error loading scoresheet data:', err);
      this.showToast('error', 'Failed to load scoresheet data: ' + err.message);
    } finally {
      this.isLoading = false;
    }
  }

  getViewModel() {
    return buildScoresheetViewModel({
      sourceFilter: this.sourceFilter,
      preset: this.preset,
      customFrom: this.customFrom,
      customTo: this.customTo,
      todayIST: this.todayIST,
      studentProfile: this.currentProfile,
      jmcwcAssignment: this.jmcwcAssignment,
      manualRounds: this.manualRounds,
      seriesCategories: this.seriesCategories,
      manualResults: this.manualResults,
      roundSeriesList: this.roundSeriesList,
      onlineAttempts: this.onlineAttempts,
      onlineCategories: this.onlineCategories,
      onlineReviewCache: this.onlineReviewCache,
      papersMap: this.papersMap,
      loadErrors: this.loadErrors,
    });
  }

  render() {
    if (!this.containerEl) return;
    ensureScoresheetStyles();
    if (typeof document !== 'undefined' && document.body?.classList) {
      if (this.isCleanView) {
        document.body.classList.add('scoresheet-capture-active');
      } else {
        document.body.classList.remove('scoresheet-capture-active');
      }
    }
    const vm = this.getViewModel();

    const isCustom = this.preset === 'range' || this.preset === 'single';

    this.containerEl.innerHTML = `
      <div class="scoresheet-wrapper ${this.isCleanView ? 'scoresheet-capture-active' : ''}">
        <!-- Clean View Floating Top Header (Shown only during clean capture view) -->
        <div class="scoresheet-clean-header" style="${this.isCleanView ? 'display: flex;' : 'display: none;'} justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 16px; background: #0f172a; color: #ffffff; border-radius: var(--radius-md); margin-bottom: var(--space-4); box-shadow: var(--shadow-md); max-width: 100%; box-sizing: border-box;">
          <div style="min-width: 0; flex: 1 1 auto;">
            <div style="font-weight: 800; font-size: var(--text-sm); letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              🧮 Trendz Tracker · Main Round Scoresheet
            </div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px; word-break: break-word;">
              <strong>${escapeHtml(vm.studentInfo.name)}</strong> (${escapeHtml(vm.studentInfo.code)}) · Group: ${escapeHtml(vm.studentInfo.group)} · ${escapeHtml(vm.periodLabel)}
            </div>
          </div>
          <button type="button" id="btn-scoresheet-exit-clean" class="btn btn-sm btn-scoresheet-exit" style="background: #ffffff; color: #0f172a; border: 1px solid #cbd5e1; font-weight: 700; cursor: pointer; padding: 6px 14px; border-radius: var(--radius-sm, 6px); box-shadow: 0 1px 2px rgba(0,0,0,0.1); flex-shrink: 0;">
            ✕ Exit Clean View
          </button>
        </div>

        <!-- Filter & Control Card (Hidden during clean view) -->
        <div class="card scoresheet-controls-card" style="${this.isCleanView ? 'display: none;' : 'display: block;'} padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4);">
          <!-- Top Row: Source Filters & Action Buttons -->
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-3); padding-bottom: var(--space-3); border-bottom: 1px solid var(--border-subtle);">
            <!-- Source Filter Segmented Buttons -->
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <span style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Source:</span>
              <div role="group" aria-label="Scoresheet Source Filter" style="display: inline-flex; gap: 4px; background: var(--bg-surface-subtle); padding: 3px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
                <button type="button" id="btn-src-both" class="btn ${this.sourceFilter === 'both' ? 'btn-primary' : 'btn-ghost'} btn-sm" style="min-height: 32px; font-weight: 700; font-size: 11.5px;">
                  Both
                </button>
                <button type="button" id="btn-src-manual" class="btn ${this.sourceFilter === 'manual' ? 'btn-primary' : 'btn-ghost'} btn-sm" style="min-height: 32px; font-weight: 700; font-size: 11.5px;">
                  Manual entry
                </button>
                <button type="button" id="btn-src-online" class="btn ${this.sourceFilter === 'online' ? 'btn-primary' : 'btn-ghost'} btn-sm" style="min-height: 32px; font-weight: 700; font-size: 11.5px;">
                  Online practice
                </button>
              </div>
            </div>

            <!-- Export, Share & Clean View Actions -->
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <button type="button" id="btn-scoresheet-clean-toggle" class="btn btn-outline btn-sm" style="min-height: 34px; font-weight: 700;" title="Toggle clean screenshot view without controls or page chrome">
                📷 Clean View
              </button>
              <button type="button" id="btn-export-pdf" class="btn btn-outline btn-sm" style="min-height: 34px; font-weight: 700;">
                📄 Download PDF
              </button>
              <button type="button" id="btn-export-image" class="btn btn-outline btn-sm" style="min-height: 34px; font-weight: 700;">
                🖼️ Download Image
              </button>
              <button type="button" id="btn-open-share-modal" class="btn btn-primary btn-sm" style="min-height: 34px; font-weight: 700;">
                📤 Share
              </button>
            </div>
          </div>

          <!-- Bottom Row: Date Presets & Custom Inputs -->
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);">
            <!-- Preset Buttons -->
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Period:</span>
              <button type="button" class="btn ${this.preset === 'last7' ? 'btn-secondary' : 'btn-ghost'} btn-sm btn-date-preset" data-preset="last7" style="font-size: 11.5px; min-height: 30px;">
                Last 7 days
              </button>
              <button type="button" class="btn ${this.preset === 'last30' ? 'btn-secondary' : 'btn-ghost'} btn-sm btn-date-preset" data-preset="last30" style="font-size: 11.5px; min-height: 30px;">
                Last 30 days
              </button>
              <button type="button" class="btn ${this.preset === 'all' ? 'btn-secondary' : 'btn-ghost'} btn-sm btn-date-preset" data-preset="all" style="font-size: 11.5px; min-height: 30px;">
                All time
              </button>
              <button type="button" class="btn ${this.preset === 'single' ? 'btn-secondary' : 'btn-ghost'} btn-sm btn-date-preset" data-preset="single" style="font-size: 11.5px; min-height: 30px;">
                Pick a date
              </button>
              <button type="button" class="btn ${this.preset === 'range' ? 'btn-secondary' : 'btn-ghost'} btn-sm btn-date-preset" data-preset="range" style="font-size: 11.5px; min-height: 30px;">
                Date range
              </button>
            </div>

            <!-- Zoom Controls -->
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 600;">Zoom:</span>
              <button type="button" id="btn-zoom-out" class="btn btn-outline btn-sm" style="min-width: 30px; padding: 2px 8px; font-weight: 800;" title="Zoom out">−</button>
              <span id="zoom-indicator" class="num" style="font-size: 11px; font-weight: 700; min-width: 44px; text-align: center;">${Math.round(this.zoomScale * 100)}%</span>
              <button type="button" id="btn-zoom-in" class="btn btn-outline btn-sm" style="min-width: 30px; padding: 2px 8px; font-weight: 800;" title="Zoom in">+</button>
              <button type="button" id="btn-zoom-reset" class="btn btn-ghost btn-sm" style="font-size: 11px; padding: 2px 6px;" title="Reset zoom">Reset</button>
              <button type="button" id="btn-zoom-fit" class="btn btn-ghost btn-sm" style="font-size: 11px; padding: 2px 6px;" title="Fit to container width">Fit</button>
            </div>
          </div>

          <!-- Dynamic Date Inputs (for single date or range) -->
          <div id="scoresheet-custom-date-row" style="${isCustom ? 'display: flex;' : 'display: none;'} align-items: center; gap: var(--space-3); margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px dashed var(--border-subtle); flex-wrap: wrap;">
            ${this.preset === 'single' ? `
              <div style="display: flex; align-items: center; gap: var(--space-2);">
                <label for="input-single-date" class="form-label" style="margin: 0; font-size: var(--text-xs);">Date (IST):</label>
                <input type="date" id="input-single-date" class="form-input num" style="min-height: 36px; max-width: 170px;" value="${escapeHtml(this.customFrom || this.todayIST)}" />
              </div>
            ` : `
              <div style="display: flex; align-items: center; gap: var(--space-2);">
                <label for="input-range-from" class="form-label" style="margin: 0; font-size: var(--text-xs);">From:</label>
                <input type="date" id="input-range-from" class="form-input num" style="min-height: 36px; max-width: 170px;" value="${escapeHtml(this.customFrom)}" />
              </div>
              <div style="display: flex; align-items: center; gap: var(--space-2);">
                <label for="input-range-to" class="form-label" style="margin: 0; font-size: var(--text-xs);">To:</label>
                <input type="date" id="input-range-to" class="form-input num" style="min-height: 36px; max-width: 170px;" value="${escapeHtml(this.customTo || this.todayIST)}" />
              </div>
            `}
            <button type="button" id="btn-apply-custom-dates" class="btn btn-secondary btn-sm" style="min-height: 36px;">
              Apply
            </button>
          </div>
        </div>

        <!-- Student & Period Metadata Banner -->
        <div class="scoresheet-meta-summary" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); padding: 6px 12px; background: var(--bg-surface-subtle); border-radius: var(--radius-md); font-size: var(--text-xs); color: var(--text-muted);">
          <div>
            <strong>${escapeHtml(vm.studentInfo.name)}</strong>
            <span class="meta-separator">·</span>
            <span class="num">${escapeHtml(vm.studentInfo.code)}</span>
            <span class="meta-separator">·</span>
            <span>Group: <strong>${escapeHtml(vm.studentInfo.group)}</strong></span>
          </div>
          <div>
            Period: <strong style="color: var(--text-main);">${escapeHtml(vm.periodLabel)}</strong>
          </div>
        </div>

        <!-- Main Scoresheet Render Container -->
        <div id="scoresheet-main-display" style="transform: scale(${this.zoomScale}); transform-origin: top left; transition: transform 0.15s ease;">
          ${renderScoresheetHTML(vm)}
        </div>
      </div>

      <!-- Share Choice Modal -->
      <div id="scoresheet-share-dialog" class="modal-backdrop" aria-hidden="true" role="dialog" aria-modal="true" style="display: none;">
        <div class="modal-dialog" style="max-width: 440px;">
          <header class="modal-header">
            <div>
              <h2 class="modal-title" style="font-size: var(--text-md);">Share Main Round Scoresheet</h2>
              <p class="modal-subtitle" style="font-size: var(--text-xs); margin: 2px 0 0 0;">Choose your preferred format for device sharing.</p>
            </div>
            <button type="button" class="modal-close" id="btn-close-share-dialog" aria-label="Close modal">&times;</button>
          </header>
          <div class="modal-body" style="padding: var(--space-4);">
            <p style="font-size: var(--text-sm); margin-bottom: var(--space-4); color: var(--text-main);">
              Opens your device share sheet (WhatsApp, Drive, Email) if supported, or downloads the file as a fallback.
            </p>
            <div style="display: flex; flex-direction: column; gap: var(--space-3);">
              <button type="button" id="btn-do-share-pdf" class="btn btn-primary" style="min-height: 44px; justify-content: center; font-weight: 700;">
                📄 Share as PDF Document (.pdf)
              </button>
              <button type="button" id="btn-do-share-image" class="btn btn-outline" style="min-height: 44px; justify-content: center; font-weight: 700;">
                🖼️ Share as Image (.png)
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindDynamicEvents();
  }

  bindEvents() {
    // Esc key exits clean view
    if (typeof document !== 'undefined') {
      if (this._escListener) {
        document.removeEventListener('keydown', this._escListener);
      }
      this._escListener = (e) => {
        if (e.key === 'Escape' && this.isCleanView) {
          this.setCleanView(false);
        }
      };
      document.addEventListener('keydown', this._escListener);
    }
  }

  bindDynamicEvents() {
    if (!this.containerEl) return;

    // Source Filter Buttons
    const btnBoth = this.containerEl.querySelector('#btn-src-both');
    const btnManual = this.containerEl.querySelector('#btn-src-manual');
    const btnOnline = this.containerEl.querySelector('#btn-src-online');

    btnBoth?.addEventListener('click', () => {
      this.sourceFilter = 'both';
      this.render();
    });
    btnManual?.addEventListener('click', () => {
      this.sourceFilter = 'manual';
      this.render();
    });
    btnOnline?.addEventListener('click', () => {
      this.sourceFilter = 'online';
      this.render();
    });

    // Date Preset Buttons
    this.containerEl.querySelectorAll('.btn-date-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetPreset = btn.getAttribute('data-preset');
        this.preset = targetPreset;
        if (targetPreset === 'single' && !this.customFrom) {
          this.customFrom = this.todayIST;
        }
        if (targetPreset === 'range' && (!this.customFrom || !this.customTo)) {
          this.customFrom = getPastISTDate(this.todayIST, 6);
          this.customTo = this.todayIST;
        }
        this.render();
      });
    });

    // Apply custom date button
    const btnApplyCustom = this.containerEl.querySelector('#btn-apply-custom-dates');
    btnApplyCustom?.addEventListener('click', () => {
      if (this.preset === 'single') {
        const input = this.containerEl.querySelector('#input-single-date');
        this.customFrom = input?.value || '';
      } else if (this.preset === 'range') {
        const fromInput = this.containerEl.querySelector('#input-range-from');
        const toInput = this.containerEl.querySelector('#input-range-to');
        this.customFrom = fromInput?.value || '';
        this.customTo = toInput?.value || '';
      }
      this.render();
    });

    // Zoom buttons
    this.containerEl.querySelector('#btn-zoom-in')?.addEventListener('click', () => {
      this.zoomScale = Math.min(1.75, Number((this.zoomScale + 0.15).toFixed(2)));
      this.render();
    });
    this.containerEl.querySelector('#btn-zoom-out')?.addEventListener('click', () => {
      this.zoomScale = Math.max(0.60, Number((this.zoomScale - 0.15).toFixed(2)));
      this.render();
    });
    this.containerEl.querySelector('#btn-zoom-reset')?.addEventListener('click', () => {
      this.zoomScale = 1.0;
      this.render();
    });
    this.containerEl.querySelector('#btn-zoom-fit')?.addEventListener('click', () => {
      const pane = this.containerEl.querySelector('.scoresheet-scroll-pane');
      const table = this.containerEl.querySelector('.scoresheet-grid-table');
      if (pane && table) {
        const paneW = pane.clientWidth;
        const tableW = table.scrollWidth;
        if (paneW > 0 && tableW > 0) {
          const ratio = Math.max(0.60, Math.min(1.20, Number((paneW / tableW).toFixed(2))));
          this.zoomScale = ratio;
          this.render();
        }
      }
    });

    // Clean View Toggles
    this.containerEl.querySelector('#btn-scoresheet-clean-toggle')?.addEventListener('click', () => {
      this.setCleanView(true);
    });
    this.containerEl.querySelector('#btn-scoresheet-exit-clean')?.addEventListener('click', () => {
      this.setCleanView(false);
    });

    // Retry buttons for failed queries
    this.containerEl.querySelector('#btn-retry-manual')?.addEventListener('click', async () => {
      if (this.loadErrors) this.loadErrors.manual = null;
      await this.init();
    });
    this.containerEl.querySelector('#btn-retry-online')?.addEventListener('click', async () => {
      if (this.loadErrors) this.loadErrors.online = null;
      await this.init();
    });
    this.containerEl.querySelector('#btn-retry-reviews')?.addEventListener('click', async () => {
      await this.init();
    });
    this.containerEl.querySelector('#btn-retry-scoresheet')?.addEventListener('click', async () => {
      if (this.loadErrors) {
        this.loadErrors.manual = null;
        this.loadErrors.online = null;
      }
      await this.init();
    });

    // Exports
    this.containerEl.querySelector('#btn-export-pdf')?.addEventListener('click', () => {
      const vm = this.getViewModel();
      if (hasScoresheetLoadErrors(vm)) {
        this.showToast('error', 'Cannot export PDF while score history has loading failures. Please retry.');
        return;
      }
      if (!vm.isValid || vm.isEmpty) {
        this.showToast('info', 'No scores to export for this period.');
        return;
      }
      try {
        downloadScoresheetPdf(vm);
        this.showToast('success', 'PDF scoresheet downloaded.');
      } catch (err) {
        this.showToast('error', 'PDF generation failed: ' + err.message);
      }
    });

    this.containerEl.querySelector('#btn-export-image')?.addEventListener('click', async () => {
      const vm = this.getViewModel();
      if (hasScoresheetLoadErrors(vm)) {
        this.showToast('error', 'Cannot export image while score history has loading failures. Please retry.');
        return;
      }
      if (!vm.isValid || vm.isEmpty) {
        this.showToast('info', 'No scores to export for this period.');
        return;
      }
      try {
        await downloadScoresheetImages(vm);
        this.showToast('success', 'Scoresheet image downloaded.');
      } catch (err) {
        this.showToast('error', 'Image generation failed: ' + err.message);
      }
    });

    // Share Modal
    const shareDialog = this.containerEl.querySelector('#scoresheet-share-dialog');
    const openShareBtn = this.containerEl.querySelector('#btn-open-share-modal');
    const closeShareBtn = this.containerEl.querySelector('#btn-close-share-dialog');

    openShareBtn?.addEventListener('click', () => {
      const vm = this.getViewModel();
      if (hasScoresheetLoadErrors(vm)) {
        this.showToast('error', 'Cannot share scoresheet while score history has loading failures. Please retry.');
        return;
      }
      if (!vm.isValid || vm.isEmpty) {
        this.showToast('info', 'No scores to share for this period.');
        return;
      }
      if (shareDialog) shareDialog.style.display = 'flex';
    });

    closeShareBtn?.addEventListener('click', () => {
      if (shareDialog) shareDialog.style.display = 'none';
    });

    this.containerEl.querySelector('#btn-do-share-pdf')?.addEventListener('click', async () => {
      if (shareDialog) shareDialog.style.display = 'none';
      const vm = this.getViewModel();
      if (hasScoresheetLoadErrors(vm)) {
        this.showToast('error', 'Cannot share PDF while score history has loading failures. Please retry.');
        return;
      }
      await shareScoresheet({
        format: 'pdf',
        viewModel: vm,
        onToast: (t, m) => this.showToast(t, m),
      });
    });

    this.containerEl.querySelector('#btn-do-share-image')?.addEventListener('click', async () => {
      if (shareDialog) shareDialog.style.display = 'none';
      const vm = this.getViewModel();
      if (hasScoresheetLoadErrors(vm)) {
        this.showToast('error', 'Cannot share image while score history has loading failures. Please retry.');
        return;
      }
      await shareScoresheet({
        format: 'image',
        viewModel: vm,
        onToast: (t, m) => this.showToast(t, m),
      });
    });
  }
}
