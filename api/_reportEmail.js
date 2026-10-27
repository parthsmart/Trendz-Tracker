/**
 * Trendz Tracker - Pure Weekly Report Email Builder (api/_reportEmail.js)
 *
 * STRICT ARCHITECTURAL RULES:
 * - Pure function module: NO DOM, NO window/document, NO network calls, NO import.meta.env.
 * - Never calculates streaks, points, accuracy, or attendance in JavaScript; consumes
 *   pre-computed numbers returned by `weekly_report_data()`.
 * - Uses Indian Standard Time (Asia/Kolkata) formatting with 3-letter month names.
 * - Escapes all dynamic text before inserting into HTML output.
 */

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
 * Escapes HTML special characters to prevent XSS or broken markup in emails and previews.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parses a YYYY-MM-DD (or ISO) date into { year, month, day } in Indian Standard Time.
 * @param {string|Date|null|undefined} dateVal
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseISTDateParts(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
      };
    }
  }
  try {
    const d = typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
    if (!d || isNaN(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const iso = fmt.format(d);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return null;
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  } catch {
    return null;
  }
}

/**
 * Formats a single date string into Indian display format (e.g. "12 Oct 2026").
 * @param {string|Date|null|undefined} dateVal
 * @returns {string}
 */
export function formatReportDateIST(dateVal) {
  const parts = parseISTDateParts(dateVal);
  if (!parts) return dateVal ? String(dateVal) : '—';
  const monthName = SHORT_MONTHS_3[parts.month - 1] || '';
  return `${parts.day} ${monthName} ${parts.year}`.trim();
}

/**
 * Formats a week start and week end into compact range string:
 * - Same month & year: "12-18 Oct 2026"
 * - Same year, different month: "28 Sep-4 Oct 2026"
 * - Different year: "28 Dec 2026-3 Jan 2027"
 *
 * @param {string|Date} weekStart
 * @param {string|Date} weekEnd
 * @returns {string}
 */
export function formatWeekRangeIST(weekStart, weekEnd) {
  const s = parseISTDateParts(weekStart);
  const e = parseISTDateParts(weekEnd);

  if (!s && !e) return 'This week';
  if (!s) return formatReportDateIST(weekEnd);
  if (!e) return formatReportDateIST(weekStart);

  const sMonth = SHORT_MONTHS_3[s.month - 1] || '';
  const eMonth = SHORT_MONTHS_3[e.month - 1] || '';

  if (s.year === e.year && s.month === e.month) {
    return `${s.day}-${e.day} ${eMonth} ${e.year}`;
  }
  if (s.year === e.year) {
    return `${s.day} ${sMonth}-${e.day} ${eMonth} ${e.year}`;
  }
  return `${s.day} ${sMonth} ${s.year}-${e.day} ${eMonth} ${e.year}`;
}

/**
 * Formats a numeric value with optional suffix, returning "—" when null/undefined/NaN.
 * @param {number|string|null|undefined} val
 * @param {string} suffix
 * @param {number|null} decimals
 * @returns {string}
 */
function formatMetric(val, suffix = '', decimals = null) {
  if (val === null || val === undefined || val === '') return '—';
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  const formatted = decimals !== null ? num.toFixed(decimals).replace(/\.0$/, '') : String(num);
  return `${formatted}${suffix}`;
}

/**
 * Natural level comparator so Level 1..4, Master, and Unassigned sort cleanly,
 * then by student name ascending.
 */
function compareStudentsByLevelAndName(a, b) {
  const lvlA = String(a?.level || '').trim();
  const lvlB = String(b?.level || '').trim();
  if (lvlA !== lvlB) {
    if (!lvlA) return 1;
    if (!lvlB) return -1;
    return lvlA.localeCompare(lvlB, undefined, { numeric: true, sensitivity: 'base' });
  }
  const nameA = String(a?.name || '').trim();
  const nameB = String(b?.name || '').trim();
  return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
}

/**
 * Builds the weekly report email { subject, html, text } from `weekly_report_data()` JSON.
 *
 * Required content order:
 * 1. Summary line (students who practised n of N, average accuracy)
 * 2. "Needs attention" list (name, level, days since last entry, or "no entries yet")
 * 3. "Streak milestones this week"
 * 4. Table of students (name, level, practice days out of 7, entries, accuracy, questions per minute, streak, points) sorted by level then name
 * 5. Attendance sessions this week
 * 6. Weekly tests this week
 *
 * @param {object} data - Output from `weekly_report_data()` RPC
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildWeeklyEmail(data = {}) {
  const safeData = data && typeof data === 'object' ? data : {};
  const rangeStr = formatWeekRangeIST(safeData.week_start, safeData.week_end);
  const subject = `Trendz Tracker weekly report: ${rangeStr}`;

  const summary = safeData.summary && typeof safeData.summary === 'object' ? safeData.summary : {};
  const practisedCount = Number(summary.students_with_entries ?? 0);
  const activeCount = Number(summary.active_students ?? 0);
  const avgAccuracyStr =
    summary.accuracy !== null && summary.accuracy !== undefined && Number.isFinite(Number(summary.accuracy))
      ? `${Number(summary.accuracy).toFixed(1).replace(/\.0$/, '')}%`
      : '—';

  const summaryLineText = `Students who practised: ${practisedCount} of ${activeCount} | Average accuracy: ${avgAccuracyStr}`;

  const needsAttention = Array.isArray(safeData.needs_attention) ? safeData.needs_attention : [];
  const milestones = Array.isArray(safeData.milestones) ? safeData.milestones : [];
  const rawStudents = Array.isArray(safeData.students) ? safeData.students : [];
  const sortedStudents = [...rawStudents].sort(compareStudentsByLevelAndName);
  const sessions = Array.isArray(safeData.sessions) ? safeData.sessions : [];
  const weeklyTests = Array.isArray(safeData.weekly_tests) ? safeData.weekly_tests : [];

  // ---------------------------------------------------------------------------
  // PLAIN TEXT VERSION (strictly ordered 1 -> 6)
  // ---------------------------------------------------------------------------
  const textLines = [];
  textLines.push(subject);
  if (safeData.generated_on) {
    textLines.push(`Generated on (IST): ${formatReportDateIST(safeData.generated_on)}`);
  }
  textLines.push('');

  // 1. Summary line
  textLines.push(`SUMMARY: ${summaryLineText}`);
  textLines.push('');

  // 2. Needs attention
  textLines.push('NEEDS ATTENTION');
  if (needsAttention.length === 0) {
    textLines.push('- None — all active students practised recently.');
  } else {
    needsAttention.forEach((item) => {
      const name = item?.name || item?.code || 'Student';
      const code = item?.code ? ` (${item.code})` : '';
      const level = item?.level || 'Unassigned';
      const hasLastEntry = Boolean(item?.last_entry) && item?.days_ago !== null && item?.days_ago !== undefined;
      const statusText = hasLastEntry
        ? `${Number(item.days_ago)} day${Number(item.days_ago) === 1 ? '' : 's'} since last entry (${formatReportDateIST(item.last_entry)})`
        : 'no entries yet';
      textLines.push(`- ${name}${code} [${level}]: ${statusText}`);
    });
  }
  textLines.push('');

  // 3. Streak milestones this week
  textLines.push('STREAK MILESTONES THIS WEEK');
  if (milestones.length === 0) {
    textLines.push('- No streak milestones reached this week.');
  } else {
    milestones.forEach((m) => {
      const name = m?.name || m?.code || 'Student';
      const code = m?.code ? ` (${m.code})` : '';
      const level = m?.level || 'Unassigned';
      const milestoneDays = Number(m?.milestone ?? 0);
      const streakDays = Number(m?.streak ?? milestoneDays);
      textLines.push(`- ${name}${code} [${level}]: ${milestoneDays}-day milestone (current streak: ${streakDays} days)`);
    });
  }
  textLines.push('');

  // 4. Table of students
  textLines.push('STUDENTS');
  if (sortedStudents.length === 0) {
    textLines.push('- No active students.');
  } else {
    textLines.push('Name | Level | Practice days | Entries | Accuracy | QPM | Streak | Points');
    sortedStudents.forEach((st) => {
      const name = st?.name || st?.code || 'Student';
      const code = st?.code ? ` (${st.code})` : '';
      const level = st?.level || '—';
      const pDays = `${Number(st?.practice_days ?? 0)}/7`;
      const entries = String(Number(st?.entries ?? 0));
      const acc = formatMetric(st?.accuracy, '%', 1);
      const qpm = formatMetric(st?.qpm, '', 1);
      const streak = `${Number(st?.streak ?? 0)}d`;
      const points = String(Number(st?.points ?? 0));
      textLines.push(`${name}${code} | ${level} | ${pDays} | ${entries} | ${acc} | ${qpm} | ${streak} | ${points}`);
    });
  }
  textLines.push('');

  // 5. Sessions this week
  textLines.push('SESSIONS THIS WEEK');
  if (sessions.length === 0) {
    textLines.push('- No sessions recorded this week.');
  } else {
    sessions.forEach((ses) => {
      const dateStr = formatReportDateIST(ses?.date);
      const title = ses?.title || 'Session';
      const type = ses?.type || 'class';
      const present = Number(ses?.present ?? 0);
      const absent = Number(ses?.absent ?? 0);
      const excused = Number(ses?.excused ?? 0);
      textLines.push(`- ${dateStr} — ${title} (${type}): ${present} present, ${absent} absent, ${excused} excused`);
    });
  }
  textLines.push('');

  // 6. Weekly tests this week
  textLines.push('WEEKLY TESTS THIS WEEK');
  if (weeklyTests.length === 0) {
    textLines.push('- No weekly tests recorded this week.');
  } else {
    weeklyTests.forEach((wt) => {
      const dateStr = formatReportDateIST(wt?.date);
      const title = wt?.title || 'Weekly Test';
      const scores = Number(wt?.scores ?? 0);
      textLines.push(`- ${dateStr} — ${title}: ${scores} score${scores === 1 ? '' : 's'} recorded`);
    });
  }
  textLines.push('');

  // 7. Backup status & Score-sheet mirror status
  const backupInfo = safeData.backup && typeof safeData.backup === 'object' ? safeData.backup : null;
  const lastGoogleAt = backupInfo?.last_google_at || backupInfo?.last_run_at || null;
  const lastExportAt = backupInfo?.last_export_at || null;
  const daysSinceBackup =
    backupInfo?.days_since_backup !== undefined && backupInfo?.days_since_backup !== null
      ? Number(backupInfo.days_since_backup)
      : null;

  const mirrorInfo =
    (backupInfo?.mirror && typeof backupInfo.mirror === 'object' ? backupInfo.mirror : null) ||
    (safeData.mirror && typeof safeData.mirror === 'object' ? safeData.mirror : null);

  const mirrorUpToDate = Number(
    mirrorInfo?.up_to_date ?? mirrorInfo?.upToDate ?? backupInfo?.mirror_up_to_date ?? 0
  );
  const mirrorTotal = Number(
    mirrorInfo?.total ?? backupInfo?.mirror_total ?? activeCount
  );
  const mirrorLastBuiltAt =
    mirrorInfo?.last_built_at ??
    mirrorInfo?.lastBuiltAt ??
    backupInfo?.mirror_last_built_at ??
    null;

  let daysSinceMirrorBuilt = null;
  if (mirrorInfo?.days_since_built !== undefined && mirrorInfo?.days_since_built !== null) {
    daysSinceMirrorBuilt = Number(mirrorInfo.days_since_built);
  } else if (mirrorLastBuiltAt) {
    const refParts = parseISTDateParts(safeData.generated_on || safeData.week_end);
    const builtParts = parseISTDateParts(mirrorLastBuiltAt);
    if (refParts && builtParts) {
      const refUtc = Date.UTC(refParts.year, refParts.month - 1, refParts.day);
      const builtUtc = Date.UTC(builtParts.year, builtParts.month - 1, builtParts.day);
      daysSinceMirrorBuilt = Math.max(0, Math.round((refUtc - builtUtc) / 86400000));
    }
  }

  textLines.push('BACKUP');
  if (!lastGoogleAt && !lastExportAt) {
    textLines.push('- Warning: Backup is not set up yet (no Google Sheet backup or manual ZIP export recorded).');
  } else {
    textLines.push(
      `- Last Google Sheet backup: ${lastGoogleAt ? formatReportDateIST(lastGoogleAt) : 'Never'}`
    );
    textLines.push(
      `- Last manual ZIP export: ${lastExportAt ? formatReportDateIST(lastExportAt) : 'Never'}`
    );
    if (daysSinceBackup !== null && Number.isFinite(daysSinceBackup) && daysSinceBackup > 3) {
      textLines.push(`- Warning: Last completed backup was ${daysSinceBackup} days ago.`);
    }
  }

  // Score-sheet mirror status line & staleness warning (> 3 days old or never built)
  textLines.push(
    `- Score-sheet mirror: ${mirrorUpToDate} of ${mirrorTotal} up to date | Last built: ${mirrorLastBuiltAt ? formatReportDateIST(mirrorLastBuiltAt) : 'Never'}`
  );
  if (!mirrorLastBuiltAt) {
    textLines.push('- Warning: Score-sheet mirror has never been built.');
  } else if (
    daysSinceMirrorBuilt !== null &&
    Number.isFinite(daysSinceMirrorBuilt) &&
    daysSinceMirrorBuilt > 3
  ) {
    textLines.push(`- Warning: Score-sheet mirror last built ${daysSinceMirrorBuilt} days ago.`);
  }

  const text = textLines.join('\n');

  // ---------------------------------------------------------------------------
  // HTML VERSION (strictly ordered 1 -> 6, all dynamic values escaped)
  // ---------------------------------------------------------------------------
  const needsAttentionHtml =
    needsAttention.length === 0
      ? `<p style="margin: 0; color: #475569; font-size: 14px;">None — all active students practised recently.</p>`
      : `<ul style="margin: 0; padding-left: 20px; color: #1e293b; font-size: 14px; line-height: 1.6;">
          ${needsAttention
            .map((item) => {
              const name = escapeHtml(item?.name || item?.code || 'Student');
              const code = item?.code ? ` <span style="color: #64748b;">(${escapeHtml(item.code)})</span>` : '';
              const level = escapeHtml(item?.level || 'Unassigned');
              const hasLastEntry =
                Boolean(item?.last_entry) && item?.days_ago !== null && item?.days_ago !== undefined;
              const statusHtml = hasLastEntry
                ? `<strong>${Number(item.days_ago)} day${Number(item.days_ago) === 1 ? '' : 's'} since last entry</strong> (${escapeHtml(formatReportDateIST(item.last_entry))})`
                : `<strong>no entries yet</strong>`;
              return `<li><strong>${name}</strong>${code} &middot; ${level} &mdash; ${statusHtml}</li>`;
            })
            .join('')}
        </ul>`;

  const milestonesHtml =
    milestones.length === 0
      ? `<p style="margin: 0; color: #475569; font-size: 14px;">No streak milestones reached this week.</p>`
      : `<ul style="margin: 0; padding-left: 20px; color: #1e293b; font-size: 14px; line-height: 1.6;">
          ${milestones
            .map((m) => {
              const name = escapeHtml(m?.name || m?.code || 'Student');
              const code = m?.code ? ` <span style="color: #64748b;">(${escapeHtml(m.code)})</span>` : '';
              const level = escapeHtml(m?.level || 'Unassigned');
              const milestoneDays = Number(m?.milestone ?? 0);
              const streakDays = Number(m?.streak ?? milestoneDays);
              return `<li><strong>${name}</strong>${code} &middot; ${level} &mdash; <strong>${milestoneDays}-day milestone</strong> (current streak: ${streakDays} days)</li>`;
            })
            .join('')}
        </ul>`;

  const studentsTableHtml =
    sortedStudents.length === 0
      ? `<p style="margin: 0; color: #475569; font-size: 14px;">No active students found.</p>`
      : `<table width="100%" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-size: 13px; border: 1px solid #e2e8f0;">
          <thead>
            <tr style="background-color: #f8fafc; color: #334155; text-align: left; border-bottom: 2px solid #cbd5e1;">
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Student</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Level</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Practice days</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Entries</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Accuracy</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Questions / min</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Streak</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Points</th>
            </tr>
          </thead>
          <tbody>
            ${sortedStudents
              .map((st) => {
                const name = escapeHtml(st?.name || st?.code || 'Student');
                const code = st?.code ? ` <span style="color: #64748b; font-size: 12px;">(${escapeHtml(st.code)})</span>` : '';
                const level = escapeHtml(st?.level || '—');
                const pDays = `${Number(st?.practice_days ?? 0)} / 7`;
                const entries = String(Number(st?.entries ?? 0));
                const acc = escapeHtml(formatMetric(st?.accuracy, '%', 1));
                const qpm = escapeHtml(formatMetric(st?.qpm, '', 1));
                const streak = `${Number(st?.streak ?? 0)}d`;
                const points = String(Number(st?.points ?? 0));
                return `<tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 8px; font-weight: 600; color: #0f172a;">${name}${code}</td>
                  <td style="padding: 8px; color: #475569;">${level}</td>
                  <td style="padding: 8px; text-align: right; font-variant-numeric: tabular-nums;">${pDays}</td>
                  <td style="padding: 8px; text-align: right; font-variant-numeric: tabular-nums;">${entries}</td>
                  <td style="padding: 8px; text-align: right; font-variant-numeric: tabular-nums;">${acc}</td>
                  <td style="padding: 8px; text-align: right; font-variant-numeric: tabular-nums;">${qpm}</td>
                  <td style="padding: 8px; text-align: right; font-variant-numeric: tabular-nums;">${streak}</td>
                  <td style="padding: 8px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums;">${points}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;

  const sessionsHtml =
    sessions.length === 0
      ? `<p style="margin: 0; color: #475569; font-size: 14px;">No attendance sessions recorded this week.</p>`
      : `<table width="100%" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-size: 13px; border: 1px solid #e2e8f0;">
          <thead>
            <tr style="background-color: #f8fafc; color: #334155; text-align: left;">
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Date</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Session</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Type</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Present</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Absent</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Excused</th>
            </tr>
          </thead>
          <tbody>
            ${sessions
              .map((ses) => {
                const dateStr = escapeHtml(formatReportDateIST(ses?.date));
                const title = escapeHtml(ses?.title || 'Session');
                const type = escapeHtml(ses?.type || 'class');
                const present = Number(ses?.present ?? 0);
                const absent = Number(ses?.absent ?? 0);
                const excused = Number(ses?.excused ?? 0);
                return `<tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 8px; white-space: nowrap;">${dateStr}</td>
                  <td style="padding: 8px; font-weight: 600;">${title}</td>
                  <td style="padding: 8px; color: #475569;">${type}</td>
                  <td style="padding: 8px; text-align: right;">${present}</td>
                  <td style="padding: 8px; text-align: right;">${absent}</td>
                  <td style="padding: 8px; text-align: right;">${excused}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;

  const weeklyTestsHtml =
    weeklyTests.length === 0
      ? `<p style="margin: 0; color: #475569; font-size: 14px;">No weekly tests recorded this week.</p>`
      : `<table width="100%" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-size: 13px; border: 1px solid #e2e8f0;">
          <thead>
            <tr style="background-color: #f8fafc; color: #334155; text-align: left;">
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Date</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1;">Weekly Test</th>
              <th style="padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: right;">Scores Recorded</th>
            </tr>
          </thead>
          <tbody>
            ${weeklyTests
              .map((wt) => {
                const dateStr = escapeHtml(formatReportDateIST(wt?.date));
                const title = escapeHtml(wt?.title || 'Weekly Test');
                const scores = Number(wt?.scores ?? 0);
                return `<tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 8px; white-space: nowrap;">${dateStr}</td>
                  <td style="padding: 8px; font-weight: 600;">${title}</td>
                  <td style="padding: 8px; text-align: right;">${scores}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;

  const mirrorHtmlBlock = `<p style="margin: 8px 0 0 0; color: #1e293b; font-size: 14px; line-height: 1.6;">
    Score-sheet mirror: <strong>${mirrorUpToDate} of ${mirrorTotal} up to date</strong>
    &middot; Last built: <strong>${escapeHtml(mirrorLastBuiltAt ? formatReportDateIST(mirrorLastBuiltAt) : 'Never')}</strong>
    ${
      !mirrorLastBuiltAt
        ? `<br /><span style="color: #b45309;"><strong>Warning:</strong> Score-sheet mirror has never been built.</span>`
        : daysSinceMirrorBuilt !== null && Number.isFinite(daysSinceMirrorBuilt) && daysSinceMirrorBuilt > 3
          ? `<br /><span style="color: #b45309;"><strong>Warning:</strong> Score-sheet mirror last built ${daysSinceMirrorBuilt} days ago.</span>`
          : ''
    }
  </p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 24px; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a;">
  <div style="max-width: 760px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
    <h1 style="margin: 0 0 8px 0; font-size: 20px; color: #0f172a;">${escapeHtml(subject)}</h1>
    ${
      safeData.generated_on
        ? `<p style="margin: 0 0 16px 0; font-size: 12px; color: #64748b;">Generated on (IST): ${escapeHtml(formatReportDateIST(safeData.generated_on))}</p>`
        : ''
    }

    <!-- 1. Summary Line -->
    <div style="background-color: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px 16px; margin-bottom: 24px; font-size: 15px;">
      <strong>Summary:</strong> Students who practised: <strong>${practisedCount} of ${activeCount}</strong> &middot; Average accuracy: <strong>${escapeHtml(avgAccuracyStr)}</strong>
    </div>

    <!-- 2. Needs Attention -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Needs attention</h2>
    <div style="margin-bottom: 24px;">
      ${needsAttentionHtml}
    </div>

    <!-- 3. Streak Milestones This Week -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Streak milestones this week</h2>
    <div style="margin-bottom: 24px;">
      ${milestonesHtml}
    </div>

    <!-- 4. Table of Students -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Student practice &amp; points</h2>
    <div style="margin-bottom: 24px; overflow-x: auto;">
      ${studentsTableHtml}
    </div>

    <!-- 5. Sessions This Week -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Sessions this week</h2>
    <div style="margin-bottom: 24px;">
      ${sessionsHtml}
    </div>

    <!-- 6. Weekly Tests This Week -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Weekly tests this week</h2>
    <div style="margin-bottom: 24px;">
      ${weeklyTestsHtml}
    </div>

    <!-- 7. Backup -->
    <h2 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Backup</h2>
    <div>
      ${
        !lastGoogleAt && !lastExportAt
          ? `<p style="margin: 0; color: #b45309; font-size: 14px;"><strong>Warning:</strong> Backup is not set up yet (no Google Sheet backup or manual ZIP export recorded).</p>`
          : `<p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.6;">
              Last Google Sheet backup: <strong>${escapeHtml(lastGoogleAt ? formatReportDateIST(lastGoogleAt) : 'Never')}</strong>
              &middot; Last manual ZIP export: <strong>${escapeHtml(lastExportAt ? formatReportDateIST(lastExportAt) : 'Never')}</strong>
              ${
                daysSinceBackup !== null && Number.isFinite(daysSinceBackup) && daysSinceBackup > 3
                  ? `<br /><span style="color: #b45309;"><strong>Warning:</strong> Last completed backup was ${daysSinceBackup} days ago.</span>`
                  : ''
              }
            </p>`
      }
      ${mirrorHtmlBlock}
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

/**
 * Builds a plain-text congratulatory message for a student who reached a streak milestone
 * (25, 50, 100, or 200 days) suitable for copying or manual sharing.
 *
 * @param {object} item - { full_name, student_code, level, current_streak, milestone }
 * @returns {string}
 */
export function buildMilestoneMessage(item = {}) {
  const name = item.full_name || item.name || item.student_code || 'Student';
  const level = item.level ? ` (${item.level})` : '';
  const milestone = Number(item.milestone || item.current_streak || 25);
  const current = Number(item.current_streak || milestone);
  return `Congratulations to ${name}${level} on reaching a ${milestone}-day practice streak at Trendz Abacus! Current streak: ${current} days. Keep up the great daily practice!`;
}
