/**
 * Trendz Tracker - Pure Statistics & Aggregations Module (js/stats.js)
 * 
 * STRICT ARCHITECTURAL RULE:
 * This file is 100% pure JavaScript calculations.
 * NO DOM manipulation, NO document/window calls, NO network requests.
 * All functions can be unit-tested in isolation in any JS environment.
 */

/**
 * Normalizes an ISO date or timestamp into an Indian Standard Time (Asia/Kolkata)
 * YYYY-MM-DD date key.
 * 
 * @param {string|Date} dateVal - Timestamp or date string
 * @returns {string} - "YYYY-MM-DD" in Asia/Kolkata
 */
export function getISTDateString(dateVal) {
  if (!dateVal) return '';
  try {
    const d = typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
    if (isNaN(d.getTime())) {
      // If it's already "YYYY-MM-DD", preserve it
      if (typeof dateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateVal.trim())) {
        return dateVal.trim();
      }
      return '';
    }
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d);
  } catch {
    return String(dateVal).split('T')[0] || '';
  }
}

const SHORT_MONTHS_3 = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Formats a date into human-friendly Indian time display with consistent 3-letter month names
 * (e.g. "17 Oct 2026", "15 Sep 2026" — never "Sept").
 *
 * @param {string|Date} dateVal
 * @returns {string}
 */
export function formatDisplayDateIST(dateVal) {
  if (!dateVal) return '—';
  try {
    const iso = getISTDateString(dateVal);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [year, month, day] = iso.split('-').map(Number);
      const monthName = SHORT_MONTHS_3[month - 1];
      if (monthName) {
        return `${day} ${monthName} ${year}`;
      }
    }
    return String(dateVal);
  } catch {
    return String(dateVal);
  }
}

/**
 * Formats seconds into "mm:ss" or "hh:mm:ss".
 * 
 * @param {number|null|undefined} totalSeconds
 * @returns {string}
 */
export function formatSecondsToTime(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds) || totalSeconds < 0) {
    return '00:00';
  }
  const sec = Math.round(Number(totalSeconds));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const remainingSec = sec % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainingSec).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Parses a time string (e.g. "2:00", "01:30", "90", "1:05") into total seconds.
 * Returns null if invalid or empty.
 * @param {string|number|null|undefined} timeVal
 * @returns {number|null}
 */
export function parseTimeToSeconds(timeVal) {
  if (timeVal === null || timeVal === undefined || timeVal === '') return null;
  if (typeof timeVal === 'number') {
    return isNaN(timeVal) || timeVal < 0 ? null : Math.round(timeVal);
  }
  const str = String(timeVal).trim();
  if (!str) return null;
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length === 2) {
      const mins = Number(parts[0]);
      const secs = Number(parts[1]);
      if (!isNaN(mins) && !isNaN(secs) && mins >= 0 && secs >= 0 && secs < 60) {
        return Math.round(mins * 60 + secs);
      }
    } else if (parts.length === 3) {
      const hrs = Number(parts[0]);
      const mins = Number(parts[1]);
      const secs = Number(parts[2]);
      if (!isNaN(hrs) && !isNaN(mins) && !isNaN(secs) && hrs >= 0 && mins >= 0 && secs >= 0) {
        return Math.round(hrs * 3600 + mins * 60 + secs);
      }
    }
    return null;
  }
  const pureNum = Number(str);
  if (!isNaN(pureNum) && pureNum >= 0) {
    return Math.round(pureNum);
  }
  return null;
}

/**
 * Generates an array of the last N calendar dates in IST ending on baseDateStr (YYYY-MM-DD).
 * 
 * @param {string} baseDateStr - Today's IST date (YYYY-MM-DD)
 * @param {number} daysCount - Number of days to include (e.g. 30)
 * @returns {string[]} Array of date strings "YYYY-MM-DD" in ascending chronological order
 */
export function getRecentISTDateRange(baseDateStr, daysCount = 30) {
  const dates = [];
  if (!baseDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(baseDateStr)) {
    baseDateStr = getISTDateString(new Date());
  }

  const [y, m, d] = baseDateStr.split('-').map(Number);
  const baseUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  for (let i = daysCount - 1; i >= 0; i--) {
    const cur = new Date(baseUtc.getTime() - i * 86400000);
    const yStr = cur.getUTCFullYear();
    const mStr = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const dStr = String(cur.getUTCDate()).padStart(2, '0');
    dates.push(`${yStr}-${mStr}-${dStr}`);
  }
  return dates;
}

/**
 * Computes daily accuracy percentage over the last N days (default 30).
 * Rule: Per day, sum(correct) / sum(total), only entries with total > 0.
 * Days with zero attempts return null accuracy so charts render clean breaks or empty dots.
 * 
 * @param {Array<object>} results - Array of result records
 * @param {number} days - Number of days (e.g. 30)
 * @param {string} todayIST - Current IST date (YYYY-MM-DD)
 * @returns {Array<{ date: string, displayDate: string, accuracy: number|null, correct: number, total: number, count: number }>}
 */
export function calculateAccuracyTrend(results = [], days = 30, todayIST = '') {
  const dateRange = getRecentISTDateRange(todayIST, days);
  const dateMap = new Map();

  dateRange.forEach(date => {
    dateMap.set(date, { correct: 0, total: 0, count: 0 });
  });

  results.forEach(res => {
    const total = Number(res.total) || 0;
    const correct = Number(res.correct) || 0;
    if (total <= 0) return; // Only entries with total > 0

    const dateKey = getISTDateString(res.entry_date || res.created_at);
    if (dateMap.has(dateKey)) {
      const bucket = dateMap.get(dateKey);
      bucket.correct += Math.min(correct, total);
      bucket.total += total;
      bucket.count += 1;
    }
  });

  return dateRange.map(date => {
    const data = dateMap.get(date);
    const accuracy = data.total > 0 ? Math.round((data.correct / data.total) * 1000) / 10 : null;
    return {
      date,
      displayDate: formatDisplayDateIST(date),
      accuracy,
      correct: data.correct,
      total: data.total,
      count: data.count
    };
  });
}

/**
 * Computes daily speed in questions per minute over the last N days (default 30).
 * Rule: questions per minute = sum(total) / (sum(time_seconds) / 60),
 * only entries with total > 0 and time_seconds > 0.
 * 
 * @param {Array<object>} results - Array of result records
 * @param {number} days - Number of days (e.g. 30)
 * @param {string} todayIST - Current IST date (YYYY-MM-DD)
 * @returns {Array<{ date: string, displayDate: string, speed: number|null, totalQuestions: number, totalSeconds: number, count: number }>}
 */
export function calculateSpeedTrend(results = [], days = 30, todayIST = '') {
  const dateRange = getRecentISTDateRange(todayIST, days);
  const dateMap = new Map();

  dateRange.forEach(date => {
    dateMap.set(date, { totalQuestions: 0, totalSeconds: 0, count: 0 });
  });

  results.forEach(res => {
    const total = Number(res.total) || 0;
    const timeSec = Number(res.time_seconds) || 0;
    if (total <= 0 || timeSec <= 0) return; // Only entries with total > 0 and time > 0

    const dateKey = getISTDateString(res.entry_date || res.created_at);
    if (dateMap.has(dateKey)) {
      const bucket = dateMap.get(dateKey);
      bucket.totalQuestions += total;
      bucket.totalSeconds += timeSec;
      bucket.count += 1;
    }
  });

  return dateRange.map(date => {
    const data = dateMap.get(date);
    let speed = null;
    if (data.totalQuestions > 0 && data.totalSeconds > 0) {
      const minutes = data.totalSeconds / 60;
      speed = Math.round((data.totalQuestions / minutes) * 10) / 10;
    }
    return {
      date,
      displayDate: formatDisplayDateIST(date),
      speed,
      totalQuestions: data.totalQuestions,
      totalSeconds: data.totalSeconds,
      count: data.count
    };
  });
}

/**
 * Computes history for a single category (last N entries, default 10).
 * Shows accuracy and speed for each entry in chronological sequence.
 * 
 * @param {Array<object>} results - All results
 * @param {string} categoryId - Target category UUID
 * @param {number} limit - Number of latest entries (default 10)
 * @returns {Array<{ id: string, roundNumber: number|null, date: string, displayDate: string, correct: number, total: number, timeSeconds: number, formattedTime: string, accuracy: number, speed: number|null }>}
 */
export function calculateCategoryHistory(results = [], categoryId = '', limit = 10) {
  if (!categoryId) return [];

  const filtered = results.filter(r => r.category_id === categoryId);

  // Sort descending by date/created_at to get latest, then slice and reverse to chronological order
  const sorted = [...filtered].sort((a, b) => {
    const timeA = new Date(a.entry_date || a.created_at || 0).getTime();
    const timeB = new Date(b.entry_date || b.created_at || 0).getTime();
    return timeB - timeA;
  });

  const latestSlice = sorted.slice(0, limit).reverse();

  return latestSlice.map(entry => {
    const correct = Math.max(0, Number(entry.correct) || 0);
    const total = Math.max(0, Number(entry.total) || 0);
    const timeSeconds = Math.max(0, Number(entry.time_seconds) || 0);

    const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
    let speed = null;
    if (total > 0 && timeSeconds > 0) {
      speed = Math.round((total / (timeSeconds / 60)) * 10) / 10;
    }

    const dateKey = getISTDateString(entry.entry_date || entry.created_at);

    return {
      id: entry.id,
      studentRoundId: entry.student_round_id || null,
      date: dateKey,
      displayDate: formatDisplayDateIST(dateKey),
      correct,
      total,
      timeSeconds,
      formattedTime: formatSecondsToTime(timeSeconds),
      accuracy,
      speed
    };
  });
}

/**
 * Computes Basics summary for the past 7 days (ending on todayIST).
 * For each basics category entered, shows:
 * - Number of entries
 * - Average accuracy (sum correct / sum total)
 * - Average speed in questions per minute (sum total / sum minutes)
 * 
 * @param {Array<object>} results - All results
 * @param {Array<object>} categories - Categories list
 * @param {string} todayIST - Current IST date (YYYY-MM-DD)
 * @returns {Array<{ categoryId: string, categoryName: string, entryCount: number, avgAccuracy: number, avgSpeed: number, totalCorrect: number, totalQuestions: number, totalSeconds: number }>}
 */
export function calculateBasicsWeeklySummary(results = [], categories = [], todayIST = '') {
  const last7Days = new Set(getRecentISTDateRange(todayIST, 7));

  // Build map of basics categories
  const basicsCatMap = new Map();
  categories
    .filter(c => c.section === 'basics')
    .forEach(c => {
      basicsCatMap.set(c.id, {
        categoryId: c.id,
        categoryName: c.name,
        sortOrder: c.sort_order || 0,
        entryCount: 0,
        totalCorrect: 0,
        totalQuestions: 0,
        totalSeconds: 0,
        targetMetCount: 0,
        targetEvaluatedCount: 0
      });
    });

  // Tally results in the 7-day window
  results.forEach(res => {
    const dateKey = getISTDateString(res.entry_date || res.created_at);
    if (!last7Days.has(dateKey)) return;

    if (basicsCatMap.has(res.category_id)) {
      const bucket = basicsCatMap.get(res.category_id);
      const total = Number(res.total) || 0;
      const correct = Number(res.correct) || 0;
      const sec = Number(res.time_seconds) || 0;

      bucket.entryCount += 1;
      bucket.totalCorrect += correct;
      bucket.totalQuestions += total;
      bucket.totalSeconds += sec;

      if (res.meets_target === true) {
        bucket.targetMetCount += 1;
        bucket.targetEvaluatedCount += 1;
      } else if (res.meets_target === false) {
        bucket.targetEvaluatedCount += 1;
      }
    }
  });

  const summary = [];
  basicsCatMap.forEach(item => {
    // Only show categories that have entries or are active
    if (item.entryCount > 0) {
      const avgAccuracy = item.totalQuestions > 0
        ? Math.round((item.totalCorrect / item.totalQuestions) * 1000) / 10
        : 0;
      const avgSpeed = item.totalQuestions > 0 && item.totalSeconds > 0
        ? Math.round((item.totalQuestions / (item.totalSeconds / 60)) * 10) / 10
        : 0;

      summary.push({
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        sortOrder: item.sortOrder,
        entryCount: item.entryCount,
        avgAccuracy,
        avgSpeed,
        totalCorrect: item.totalCorrect,
        totalQuestions: item.totalQuestions,
        totalSeconds: item.totalSeconds,
        targetMetCount: item.targetMetCount,
        targetEvaluatedCount: item.targetEvaluatedCount
      });
    }
  });

  return summary.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Builds the 2D sheet score table matrix for a given list of student_rounds in a series.
 *
 * Rows: Categories belonging to that series via category_series, ordered strictly by category_series.sort_order.
 * Columns: Target student_rounds objects (up to 5 per page, newest first).
 *
 * Summary rows computed per round column:
 * 1. Round Type (`student_rounds.round_type`)
 * 2. Time taken (`student_rounds.time_taken_seconds` if set, otherwise sum of category `time_seconds`)
 * 3. Final score (sum of correct)
 * 4. Total attempt (sum of totals)
 * 5. Marks to be corrected (total attempt minus final score)
 *
 * @param {Array<object>} results - All results for the student
 * @param {Array<object>} seriesCategories - Categories for the selected series ordered by category_series.sort_order
 * @param {Array<object>} targetRounds - Array of student_round objects to display as columns
 */
export function buildRoundScoreMatrix(results = [], seriesCategories = [], targetRounds = []) {
  const totalCatCount = seriesCategories.length;

  // Index results by `${student_round_id}_${category_id}`
  const roundResultMap = new Map();
  const roundCountMap = new Map(); // student_round_id -> count of entered categories

  results.forEach(res => {
    if (res.student_round_id) {
      const srId = String(res.student_round_id);
      const key = `${srId}_${res.category_id}`;
      roundResultMap.set(key, res);

      const curCount = roundCountMap.get(srId) || 0;
      roundCountMap.set(srId, curCount + 1);
    }
  });

  // Build round header metadata
  const roundHeaders = targetRounds.map(sr => {
    const srId = String(sr.id);
    const dateKey = getISTDateString(sr.round_date || sr.created_at || '');
    const count = roundCountMap.get(srId) || 0;
    const isPartial = count > 0 && count < totalCatCount;

    return {
      studentRoundId: srId,
      roundNumber: sr.round_number,
      roundType: sr.round_type || 'Category wise',
      timeTakenSeconds: sr.time_taken_seconds !== undefined && sr.time_taken_seconds !== null ? Number(sr.time_taken_seconds) : null,
      dateStr: dateKey,
      displayDate: formatDisplayDateIST(dateKey),
      isPartial,
      entryCount: count
    };
  });

  // Build category rows
  const rows = seriesCategories.map(cat => {
    const cells = targetRounds.map(sr => {
      const srId = String(sr.id);
      const key = `${srId}_${cat.id}`;
      const entry = roundResultMap.get(key);

      if (entry) {
        const correct = entry.correct !== null && entry.correct !== undefined ? Number(entry.correct) : null;
        const total = entry.total !== null && entry.total !== undefined ? Number(entry.total) : null;
        const timeSeconds = entry.time_seconds !== null && entry.time_seconds !== undefined ? Number(entry.time_seconds) : null;
        const note = entry.note || null;

        return {
          studentRoundId: srId,
          roundNumber: sr.round_number,
          correct,
          total,
          timeSeconds,
          note,
          formattedTime: timeSeconds !== null ? formatSecondsToTime(timeSeconds) : '—',
          isVerified: !!entry.verified_at || !!entry.verified_by || entry.verified === true,
          isCorrected: !!entry.corrected_at || !!entry.corrected_by,
          isFlagged: entry.flagged === true,
          flagNote: entry.flag_note || '',
          hasData: correct !== null || total !== null || Boolean(note)
        };
      }

      return {
        studentRoundId: srId,
        roundNumber: sr.round_number,
        correct: null,
        total: null,
        timeSeconds: null,
        note: null,
        formattedTime: '—',
        hasData: false
      };
    });

    return {
      category: cat,
      cells
    };
  });

  // Compute summary rows across each round column
  const roundTypeRow = [];
  const timeTaken = [];
  const finalScore = [];
  const totalAttempt = [];
  const marksToCorrect = [];

  targetRounds.forEach((sr, colIdx) => {
    let sumSeconds = 0;
    let sumCorrect = 0;
    let sumTotal = 0;
    let hasAnyData = false;

    rows.forEach(row => {
      const cell = row.cells[colIdx];
      if (cell.hasData) {
        hasAnyData = true;
        if (cell.timeSeconds !== null) sumSeconds += cell.timeSeconds;
        if (cell.correct !== null) sumCorrect += cell.correct;
        if (cell.total !== null) sumTotal += cell.total;
      }
    });

    roundTypeRow.push({
      roundNumber: sr.round_number,
      value: sr.round_type || 'Category wise'
    });

    // Time Taken: use student_rounds.time_taken_seconds if set, otherwise sum of category times
    const explicitTime = sr.time_taken_seconds !== null && sr.time_taken_seconds !== undefined
      ? Number(sr.time_taken_seconds)
      : null;

    if (explicitTime !== null && !isNaN(explicitTime) && explicitTime >= 0) {
      timeTaken.push({
        roundNumber: sr.round_number,
        seconds: explicitTime,
        formatted: formatSecondsToTime(explicitTime)
      });
    } else if (hasAnyData && sumSeconds > 0) {
      timeTaken.push({
        roundNumber: sr.round_number,
        seconds: sumSeconds,
        formatted: formatSecondsToTime(sumSeconds)
      });
    } else {
      timeTaken.push({
        roundNumber: sr.round_number,
        seconds: 0,
        formatted: '—'
      });
    }

    if (hasAnyData) {
      finalScore.push({ roundNumber: sr.round_number, value: sumCorrect });
      totalAttempt.push({ roundNumber: sr.round_number, value: sumTotal });
      marksToCorrect.push({ roundNumber: sr.round_number, value: Math.max(0, sumTotal - sumCorrect) });
    } else {
      finalScore.push({ roundNumber: sr.round_number, value: 0 });
      totalAttempt.push({ roundNumber: sr.round_number, value: 0 });
      marksToCorrect.push({ roundNumber: sr.round_number, value: 0 });
    }
  });

  return {
    roundHeaders,
    rows,
    summary: {
      roundType: roundTypeRow,
      timeTaken,
      finalScore,
      totalAttempt,
      marksToCorrect
    }
  };
}

/**
 * Computes 7-day dual trend (accuracy and speed on each of the last 7 calendar days in IST).
 * 
 * @param {Array<object>} results - Results records
 * @param {string} todayIST - Current IST date (YYYY-MM-DD)
 * @returns {Array<{ date: string, displayDate: string, accuracy: number|null, speed: number|null, correct: number, total: number, timeSeconds: number, count: number }>}
 */
export function calculate7DayDualTrend(results = [], todayIST = '') {
  const dates = getRecentISTDateRange(todayIST, 7);
  const map = new Map();

  dates.forEach(d => {
    map.set(d, { correct: 0, total: 0, seconds: 0, count: 0 });
  });

  results.forEach(res => {
    const total = Number(res.total) || 0;
    const correct = Number(res.correct) || 0;
    const sec = Number(res.time_seconds) || 0;
    if (total <= 0) return;

    const dateKey = getISTDateString(res.entry_date || res.created_at);
    if (map.has(dateKey)) {
      const bucket = map.get(dateKey);
      bucket.correct += Math.min(correct, total);
      bucket.total += total;
      bucket.seconds += sec;
      bucket.count += 1;
    }
  });

  return dates.map(date => {
    const item = map.get(date);
    const accuracy = item.total > 0 ? Math.round((item.correct / item.total) * 1000) / 10 : null;
    let speed = null;
    if (item.total > 0 && item.seconds > 0) {
      speed = Math.round((item.total / (item.seconds / 60)) * 10) / 10;
    }
    return {
      date,
      displayDate: formatDisplayDateIST(date),
      accuracy,
      speed,
      correct: item.correct,
      total: item.total,
      timeSeconds: item.seconds,
      count: item.count
    };
  });
}

/**
 * Computes 4-week metrics bucketed Monday to Sunday in Indian Standard Time (Asia/Kolkata).
 * 
 * Returns:
 * - weeks: 4 weeks in chronological order [Week -3, Week -2, Week -1, Week 0 (current)]
 * - comparison: This week vs last week difference and direction (arrows + label)
 * - summaries: Text summary under accuracy and speed charts
 * 
 * @param {Array<object>} results - All results
 * @param {string} todayIST - Today's IST date (YYYY-MM-DD)
 */
export function calculate4WeekSummary(results = [], todayIST = '') {
  if (!todayIST || !/^\d{4}-\d{2}-\d{2}$/.test(todayIST)) {
    todayIST = getISTDateString(new Date());
  }

  const [y, m, d] = todayIST.split('-').map(Number);
  const todayUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  // In IST, Monday is day 1, Sunday is day 7
  // getUTCDay: Sunday=0, Monday=1, ..., Saturday=6
  const dayFromMonday = (todayUtc.getUTCDay() + 6) % 7;
  const currentMondayUtc = new Date(todayUtc.getTime() - dayFromMonday * 86400000);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Build 4 week buckets: weekOffset 3, 2, 1, 0 (0 is current week)
  const weekBuckets = [];
  for (let offset = 3; offset >= 0; offset--) {
    const mon = new Date(currentMondayUtc.getTime() - offset * 7 * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);

    const fmtDate = (dt) => {
      const yr = dt.getUTCFullYear();
      const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const da = String(dt.getUTCDate()).padStart(2, '0');
      return `${yr}-${mo}-${da}`;
    };

    const startDateStr = fmtDate(mon);
    const endDateStr = fmtDate(sun);
    const monDay = mon.getUTCDate();
    const monMonth = monthNames[mon.getUTCMonth()];
    const label = `Week of ${monDay} ${monMonth}`;
    const isCurrentWeek = offset === 0;

    weekBuckets.push({
      index: 3 - offset, // 0, 1, 2, 3
      offset,
      startDate: startDateStr,
      endDate: endDateStr,
      label,
      isCurrentWeek,
      correct: 0,
      total: 0,
      seconds: 0,
      count: 0
    });
  }

  // Tally results into the 4 buckets
  results.forEach(res => {
    const total = Number(res.total) || 0;
    const correct = Number(res.correct) || 0;
    const sec = Number(res.time_seconds) || 0;
    if (total <= 0) return;

    const resDate = getISTDateString(res.entry_date || res.created_at);
    if (!resDate) return;

    for (const b of weekBuckets) {
      if (resDate >= b.startDate && resDate <= b.endDate) {
        b.correct += Math.min(correct, total);
        b.total += total;
        b.seconds += sec;
        b.count += 1;
        break;
      }
    }
  });

  // Calculate averages for each week
  const weeks = weekBuckets.map(b => {
    const hasEntries = b.total > 0 && b.count > 0;
    const accuracy = hasEntries ? Math.round((b.correct / b.total) * 1000) / 10 : null;
    let speed = null;
    if (hasEntries && b.seconds > 0) {
      speed = Math.round((b.total / (b.seconds / 60)) * 10) / 10;
    }

    return {
      label: b.label,
      startDate: b.startDate,
      endDate: b.endDate,
      isCurrentWeek: b.isCurrentWeek,
      hasEntries,
      accuracy,
      speed,
      correct: b.correct,
      total: b.total,
      seconds: b.seconds,
      count: b.count
    };
  });

  // Comparison: This week (index 3) vs last week (index 2)
  const currentWk = weeks[3];
  const lastWk = weeks[2];

  let accComparison = { diff: null, text: 'No comparison data', direction: 'none' };
  if (currentWk.hasEntries && lastWk.hasEntries && currentWk.accuracy !== null && lastWk.accuracy !== null) {
    const diff = Math.round((currentWk.accuracy - lastWk.accuracy) * 10) / 10;
    if (diff > 0) {
      accComparison = { diff, text: `↑ +${diff}%`, direction: 'up' };
    } else if (diff < 0) {
      accComparison = { diff, text: `↓ ${diff}%`, direction: 'down' };
    } else {
      accComparison = { diff: 0, text: `→ 0.0% (steady)`, direction: 'steady' };
    }
  } else if (currentWk.hasEntries && !lastWk.hasEntries) {
    accComparison = { diff: null, text: `${currentWk.accuracy}% (no entries last week)`, direction: 'none' };
  } else if (!currentWk.hasEntries && lastWk.hasEntries) {
    accComparison = { diff: null, text: `Last week was ${lastWk.accuracy}%`, direction: 'none' };
  }

  let spdComparison = { diff: null, text: 'No comparison data', direction: 'none' };
  if (currentWk.hasEntries && lastWk.hasEntries && currentWk.speed !== null && lastWk.speed !== null) {
    const diff = Math.round((currentWk.speed - lastWk.speed) * 10) / 10;
    if (diff > 0) {
      spdComparison = { diff, text: `↑ +${diff} qpm`, direction: 'up' };
    } else if (diff < 0) {
      spdComparison = { diff, text: `↓ ${diff} qpm`, direction: 'down' };
    } else {
      spdComparison = { diff: 0, text: `→ 0.0 qpm (steady)`, direction: 'steady' };
    }
  } else if (currentWk.hasEntries && !lastWk.hasEntries) {
    spdComparison = { diff: null, text: `${currentWk.speed} qpm (no entries last week)`, direction: 'none' };
  } else if (!currentWk.hasEntries && lastWk.hasEntries) {
    spdComparison = { diff: null, text: `Last week was ${lastWk.speed} qpm`, direction: 'none' };
  }

  // Generate short text summaries
  let accuracySummary = '';
  if (currentWk.hasEntries && lastWk.hasEntries) {
    if (currentWk.accuracy > lastWk.accuracy) {
      accuracySummary = `Accuracy rose from ${lastWk.accuracy}% last week to ${currentWk.accuracy}% this week.`;
    } else if (currentWk.accuracy < lastWk.accuracy) {
      accuracySummary = `Accuracy dipped from ${lastWk.accuracy}% last week to ${currentWk.accuracy}% this week.`;
    } else {
      accuracySummary = `Accuracy is steady at ${currentWk.accuracy}% week-over-week.`;
    }
  } else if (currentWk.hasEntries) {
    accuracySummary = `Current week accuracy is ${currentWk.accuracy}% based on ${currentWk.count} entries so far.`;
  } else if (lastWk.hasEntries) {
    accuracySummary = `Last week finished at ${lastWk.accuracy}% accuracy across ${lastWk.count} entries.`;
  } else {
    accuracySummary = 'No practice entries logged in the last 2 weeks.';
  }

  let speedSummary = '';
  if (currentWk.hasEntries && lastWk.hasEntries && currentWk.speed !== null && lastWk.speed !== null) {
    if (currentWk.speed > lastWk.speed) {
      speedSummary = `Speed rose from ${lastWk.speed} to ${currentWk.speed} questions per minute.`;
    } else if (currentWk.speed < lastWk.speed) {
      speedSummary = `Speed dipped from ${lastWk.speed} to ${currentWk.speed} questions per minute.`;
    } else {
      speedSummary = `Speed is steady at ${currentWk.speed} questions per minute.`;
    }
  } else if (currentWk.hasEntries && currentWk.speed !== null) {
    speedSummary = `Current week speed is ${currentWk.speed} questions per minute so far.`;
  } else if (lastWk.hasEntries && lastWk.speed !== null) {
    speedSummary = `Last week average speed was ${lastWk.speed} questions per minute.`;
  } else {
    speedSummary = 'Speed data will appear after completing timed calculation rounds.';
  }

  return {
    weeks,
    comparison: {
      accuracy: accComparison,
      speed: spdComparison
    },
    summaries: {
      accuracy: accuracySummary,
      speed: speedSummary
    }
  };
}
