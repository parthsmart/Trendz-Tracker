/**
 * Trendz Tracker - Phase 5b Reports & Milestones Data Module (js/monthlyReportData.js)
 *
 * Strictly delegates all calculations to PostgreSQL RPCs and server endpoints:
 * - `student_month_report(p_student, p_month)`
 * - `admin_milestones(p_days)`
 * - `report_log` table (admin read-only)
 * - `/api/weekly-report` (`{ preview: true }` and `{ send: true }`)
 *
 * STRICT INVARIANTS:
 * - Never calculate streaks, points, accuracy, attendance, or consistency percentages in JavaScript.
 * - Use Indian Standard Time (Asia/Kolkata) for display formatting.
 */

import { buildWeeklyEmail, buildMilestoneMessage, formatReportDateIST } from '../api/_reportEmail.js';
import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { isDemoMode } from './demoDb.js';
import { getSupabase, DemoDB } from './supabaseClient.js';

export { buildMilestoneMessage, formatReportDateIST };

const FULL_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Formats a YYYY-MM-DD month_start into "October 2026".
 * @param {string|null|undefined} monthStart
 * @returns {string}
 */
export function formatMonthHeadingIST(monthStart) {
  if (!monthStart || typeof monthStart !== 'string') return 'This Month';
  const match = /^(\d{4})-(\d{2})/.exec(monthStart.trim());
  if (!match) return monthStart;
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const monthName = FULL_MONTH_NAMES[monthIdx] || match[2];
  return `${monthName} ${year}`;
}

/**
 * Formats an ISO timestamp into Indian Standard Time date + time (e.g. "18 Oct 2026, 21:00 IST").
 * @param {string|null|undefined} isoStr
 * @returns {string}
 */
export function formatTimestampIST(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    const datePart = formatReportDateIST(d);
    const timeFmt = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${datePart}, ${timeFmt.format(d)} IST`;
  } catch {
    return String(isoStr);
  }
}

/**
 * Builds a plain-text monthly report summary suitable for copying or manual sharing (e.g. WhatsApp).
 * Never calculates any consistency percentage; uses only authoritative numbers from `student_month_report()`.
 *
 * @param {object} report - Output from `student_month_report(p_student, p_month)`
 * @returns {string}
 */
export function buildMonthlyReportShareText(report = {}) {
  const st = report?.student || {};
  const prac = report?.practice || {};
  const strk = report?.streak || {};
  const att = report?.attendance || {};
  const tgt = report?.targets || {};
  const cats = Array.isArray(report?.categories) ? report.categories : [];

  const monthTitle = formatMonthHeadingIST(report?.month_start);
  const name = st.name || st.code || 'Student';
  const code = st.code ? ` (${st.code})` : '';
  const level = st.level || 'Unassigned';

  const accStr =
    prac.accuracy !== null && prac.accuracy !== undefined && Number.isFinite(Number(prac.accuracy))
      ? `${Number(prac.accuracy).toFixed(1).replace(/\.0$/, '')}%`
      : '—';
  const qpmStr =
    prac.qpm !== null && prac.qpm !== undefined && Number.isFinite(Number(prac.qpm))
      ? `${Number(prac.qpm).toFixed(1).replace(/\.0$/, '')} QPM`
      : '—';
  const attPctStr =
    att.percent !== null && att.percent !== undefined && Number.isFinite(Number(att.percent))
      ? `${Number(att.percent).toFixed(1).replace(/\.0$/, '')}%`
      : 'No sessions';

  const lines = [
    `Trendz Abacus Monthly Report — ${monthTitle}`,
    `Student: ${name}${code} · Level: ${level}`,
    `Practice days: ${Number(prac.practice_days ?? 0)} (${Number(report?.days_elapsed ?? 0)} days elapsed)`,
    `Entries: ${Number(prac.entries ?? 0)} (${Number(prac.correct ?? 0)}/${Number(prac.total ?? 0)}) · Rounds: ${Number(prac.rounds ?? 0)}`,
    `Accuracy: ${accStr} · Speed: ${qpmStr}`,
    `Streak: ${Number(strk.current ?? 0)}d current (best ${Number(strk.best ?? 0)}d) · Points: ${Number(report?.points ?? 0)}`,
    `Attendance: ${Number(att.present ?? 0)} present, ${Number(att.absent ?? 0)} absent, ${Number(att.excused ?? 0)} excused (${attPctStr})`,
  ];

  if (Number(tgt.measured ?? 0) > 0) {
    lines.push(`Basics targets met: ${Number(tgt.met ?? 0)} of ${Number(tgt.measured ?? 0)}`);
  }

  if (cats.length > 0) {
    const focusList = cats
      .slice(0, 3)
      .map((c) => `${c.name} (${Number(c.accuracy ?? 0).toFixed(1).replace(/\.0$/, '')}%)`)
      .join(', ');
    lines.push(`Focus categories: ${focusList}`);
  }

  return lines.join('\n');
}

/**
 * Fetches `student_month_report(p_student, p_month)` from Supabase RPC or DemoDB.
 *
 * @param {{ studentId: string, monthDate?: string|null }} params
 * @returns {Promise<object>}
 */
export async function fetchStudentMonthReport({ studentId, monthDate = null }) {
  const cleanMonth =
    typeof monthDate === 'string' && monthDate.trim()
      ? /^\d{4}-\d{2}$/.test(monthDate.trim())
        ? `${monthDate.trim()}-01`
        : monthDate.trim()
      : null;

  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockStudentMonthReport(studentId, cleanMonth);
  }

  const supabase = await getSupabase();
  if (!supabase) {
    if (isDemoMode()) {
      return DemoDB.mockStudentMonthReport(studentId, cleanMonth);
    }
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase.rpc('student_month_report', {
    p_student: studentId,
    p_month: cleanMonth,
  });

  if (error) {
    throw new Error(error.message || 'Could not load monthly student report.');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Monthly report returned no data.');
  }

  return data;
}

/**
 * Fetches `admin_milestones(p_days)` from Supabase RPC or DemoDB.
 *
 * @param {number} days
 * @returns {Promise<Array<object>>}
 */
export async function fetchAdminMilestones(days = 7) {
  const cleanDays = Number(days) || 7;

  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockAdminMilestones(cleanDays);
  }

  const supabase = await getSupabase();
  if (!supabase) {
    if (isDemoMode()) {
      return DemoDB.mockAdminMilestones(cleanDays);
    }
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase.rpc('admin_milestones', {
    p_days: cleanDays,
  });

  if (error) {
    throw new Error(error.message || 'Could not load streak milestones.');
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Fetches recent rows from `report_log` for Admin display.
 *
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
export async function fetchReportLogs(limit = 10) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.getReportLogs().slice(0, limit);
  }

  const supabase = await getSupabase();
  if (!supabase) {
    if (isDemoMode()) {
      return DemoDB.getReportLogs().slice(0, limit);
    }
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase
    .from('report_log')
    .select('id, week_start, kind, status, error, to_email, created_by, created_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message || 'Could not load report log.');
  }

  const dbLogs = Array.isArray(data) ? data : [];
  const localFallbackLogs = readFallbackReportLogs();
  if (localFallbackLogs.length === 0) {
    return dbLogs;
  }

  const combined = [...localFallbackLogs, ...dbLogs].sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))
  );
  return combined.slice(0, limit);
}

const FALLBACK_REPORT_LOGS_KEY = 'trendz_fallback_report_logs';

function readFallbackReportLogs() {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(FALLBACK_REPORT_LOGS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFallbackReportLog(entry) {
  if (!entry || typeof sessionStorage === 'undefined') return;
  try {
    const existing = readFallbackReportLogs();
    existing.unshift(entry);
    sessionStorage.setItem(FALLBACK_REPORT_LOGS_KEY, JSON.stringify(existing.slice(0, 20)));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Calls `POST /api/weekly-report` with `{ preview: true }` (or builds preview in Demo Mode).
 * @returns {Promise<{ subject: string, html: string, text: string }>}
 */
export async function requestWeeklyReportPreview() {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    const mockData = DemoDB.mockWeeklyReportData();
    return buildWeeklyEmail(mockData);
  }

  const supabase = await getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/weekly-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ preview: true }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Could not preview weekly report (HTTP ${response.status}).`);
  }

  return {
    subject: payload.subject || 'Trendz Tracker weekly report',
    html: payload.html || '',
    text: payload.text || '',
  };
}

/**
 * Calls `POST /api/weekly-report` with `{ send: true }` (or simulates log in Demo Mode).
 * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
 */
export async function requestWeeklyReportSend() {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    const mockData = DemoDB.mockWeeklyReportData();
    DemoDB.addReportLog({
      week_start: mockData.week_start,
      kind: 'manual',
      status: 'sent',
      to_email: 'coach@trendzabacus.com (Demo)',
    });
    return { ok: true, status: 'sent' };
  }

  const supabase = await getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/weekly-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ send: true }),
  });

  const payload = await response.json().catch(() => null);
  if (payload?.logEntry) {
    saveFallbackReportLog(payload.logEntry);
  }

  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(payload?.error || `Failed to send weekly report (HTTP ${response.status}).`);
  }

  return payload;
}

/**
 * Sanitizes text for PDF Standard Type1 font literal strings (...)
 * Converts common Unicode punctuation to ASCII equivalents and escapes \, (, ).
 * @param {unknown} str
 * @returns {string}
 */
function pdfEscapeText(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u00B7\u2022]/g, '|')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .trim();
}

/**
 * Truncates a string to a maximum character count with ellipsis.
 */
function truncatePdfStr(str, maxLen) {
  const s = String(str ?? '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

/**
 * Formats seconds into M:SS for PDF output.
 */
function formatPdfTimeSec(sec) {
  if (sec === null || sec === undefined || sec === '') return '-';
  const total = Math.max(0, Math.round(Number(sec)));
  if (!Number.isFinite(total)) return '-';
  const mins = Math.floor(total / 60);
  const rem = String(total % 60).padStart(2, '0');
  return `${mins}:${rem}`;
}

/**
 * Formats a number or returns '-' for PDF display.
 */
function formatPdfNum(val, suffix = '', decimals = null) {
  if (val === null || val === undefined || val === '') return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return '-';
  const str = decimals !== null ? num.toFixed(decimals).replace(/\.0$/, '') : String(num);
  return `${str}${suffix}`;
}

/**
 * Returns a clean filename for the student's monthly report PDF.
 * @param {object} report
 * @returns {string}
 */
export function getMonthlyReportPdfFilename(report = {}) {
  const rawCode = report?.student?.code || report?.student?.name || 'Student';
  const safeCode = String(rawCode)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'Student';
  const rawYm = String(report?.month_start || '').slice(0, 7);
  const safeYm = /^\d{4}-\d{2}$/.test(rawYm) ? rawYm : 'Report';
  return `Trendz-Monthly-Report-${safeCode}-${safeYm}.pdf`;
}

/**
 * Generates a complete, multi-page-capable A4 PDF 1.4 document in pure JavaScript (zero dependencies).
 * Works reliably inside sandboxed iframes where `window.print()` is blocked by the browser.
 *
 * @param {object} report - Output from `student_month_report(p_student, p_month)`
 * @returns {Uint8Array}
 */
export function buildMonthlyReportPdfBytes(report = {}) {
  const st = report?.student || {};
  const prac = report?.practice || {};
  const prev = report?.previous || {};
  const strk = report?.streak || {};
  const att = report?.attendance || {};
  const tgt = report?.targets || {};
  const weeks = Array.isArray(report?.weeks) ? report.weeks : [];
  const categories = Array.isArray(report?.categories) ? report.categories : [];
  const weeklyTests = Array.isArray(report?.weekly_tests) ? report.weekly_tests : [];

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN_X = 40;
  const CONTENT_W = PAGE_W - MARGIN_X * 2; // 515 pt
  const BOTTOM_MARGIN = 52;

  const pages = [];
  let currentOps = [];
  let y = PAGE_H - 40;

  function startNewPage() {
    if (currentOps.length > 0) {
      pages.push(currentOps);
    }
    currentOps = [];
    y = PAGE_H - 40;
  }

  function ensureSpace(heightNeeded) {
    if (y - heightNeeded < BOTTOM_MARGIN) {
      startNewPage();
    }
  }

  function drawRect(x, topY, w, h, fillRgb = null, strokeRgb = null, lineWidth = 1) {
    const bottomY = topY - h;
    currentOps.push('q');
    if (lineWidth) currentOps.push(`${lineWidth.toFixed(2)} w`);
    if (fillRgb) {
      currentOps.push(`${fillRgb[0].toFixed(3)} ${fillRgb[1].toFixed(3)} ${fillRgb[2].toFixed(3)} rg`);
    }
    if (strokeRgb) {
      currentOps.push(`${strokeRgb[0].toFixed(3)} ${strokeRgb[1].toFixed(3)} ${strokeRgb[2].toFixed(3)} RG`);
    }
    const op = fillRgb && strokeRgb ? 'B' : fillRgb ? 'f' : 'S';
    currentOps.push(`${x.toFixed(2)} ${bottomY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
    currentOps.push('Q');
  }

  function drawText(text, x, baselineY, { font = 'F1', size = 10, color = [0.06, 0.09, 0.16] } = {}) {
    const safe = pdfEscapeText(text);
    if (!safe) return;
    currentOps.push('BT');
    currentOps.push(`/${font} ${size} Tf`);
    currentOps.push(`${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} rg`);
    currentOps.push(`1 0 0 1 ${x.toFixed(2)} ${baselineY.toFixed(2)} Tm`);
    currentOps.push(`(${safe}) Tj`);
    currentOps.push('ET');
  }

  // 1. Header Card
  const monthHeading = formatMonthHeadingIST(report?.month_start);
  const dateRangeStr =
    report?.month_start && report?.month_end
      ? `${formatReportDateIST(report.month_start)} - ${formatReportDateIST(report.month_end)}`
      : monthHeading;
  const daysElapsedStr = `${Number(report?.days_elapsed ?? 0)} days elapsed`;

  drawRect(MARGIN_X, y, CONTENT_W, 74, [0.973, 0.98, 0.988], [0.796, 0.835, 0.882], 1);
  drawRect(MARGIN_X, y, CONTENT_W, 5, [0.145, 0.388, 0.922], null, 0);

  drawText('TRENDZ ABACUS PROGRESS REPORT', MARGIN_X + 14, y - 19, {
    font: 'F2',
    size: 8.5,
    color: [0.145, 0.388, 0.922],
  });
  drawText(`Monthly Report - ${monthHeading}`, MARGIN_X + 14, y - 36, {
    font: 'F2',
    size: 15,
    color: [0.06, 0.09, 0.16],
  });

  const studentLine = `Student: ${st.name || 'Student'}   |   ID: ${st.code || '-'}   |   Level: ${st.level || 'Unassigned'}`;
  drawText(studentLine, MARGIN_X + 14, y - 56, {
    font: 'F2',
    size: 10,
    color: [0.2, 0.25, 0.33],
  });

  drawText(dateRangeStr, MARGIN_X + CONTENT_W - 155, y - 24, {
    font: 'F2',
    size: 9.5,
    color: [0.145, 0.388, 0.922],
  });
  drawText(daysElapsedStr, MARGIN_X + CONTENT_W - 155, y - 40, {
    font: 'F1',
    size: 8.5,
    color: [0.39, 0.45, 0.55],
  });

  y -= 88;

  // 2. Primary KPI Strip (4 cards)
  const kpiGap = 9;
  const kpiW = (CONTENT_W - kpiGap * 3) / 4;
  const kpiH = 58;
  const primaryCards = [
    {
      label: 'PRACTICE DAYS',
      value: `${Number(prac.practice_days ?? 0)} days`,
      sub: `${Number(report?.days_elapsed ?? 0)}d elapsed | Last mo: ${Number(prev.practice_days ?? 0)}d`,
    },
    {
      label: 'PRACTICE ENTRIES',
      value: String(Number(prac.entries ?? 0)),
      sub: `${Number(prac.correct ?? 0)}/${Number(prac.total ?? 0)} correct | ${Number(prac.rounds ?? 0)} rounds`,
    },
    {
      label: 'OVERALL ACCURACY',
      value: formatPdfNum(prac.accuracy, '%', 1),
      sub: `Last month: ${formatPdfNum(prev.accuracy, '%', 1)}`,
    },
    {
      label: 'SPEED (QPM)',
      value: formatPdfNum(prac.qpm, ' QPM', 1),
      sub: `Last month: ${formatPdfNum(prev.qpm, ' QPM', 1)}`,
    },
  ];

  primaryCards.forEach((card, idx) => {
    const bx = MARGIN_X + idx * (kpiW + kpiGap);
    drawRect(bx, y, kpiW, kpiH, [1, 1, 1], [0.82, 0.85, 0.9], 0.8);
    drawText(card.label, bx + 8, y - 14, { font: 'F2', size: 7.5, color: [0.39, 0.45, 0.55] });
    drawText(card.value, bx + 8, y - 33, { font: 'F2', size: 13, color: [0.06, 0.09, 0.16] });
    drawText(truncatePdfStr(card.sub, 28), bx + 8, y - 48, {
      font: 'F1',
      size: 7.2,
      color: [0.39, 0.45, 0.55],
    });
  });

  y -= kpiH + 10;

  // 3. Secondary KPI Strip (3 cards)
  const secW = (CONTENT_W - kpiGap * 2) / 3;
  const secH = 54;
  const attPctStr =
    att.percent !== null && att.percent !== undefined && Number.isFinite(Number(att.percent))
      ? `${Number(att.percent).toFixed(1).replace(/\.0$/, '')}%`
      : 'No sessions';
  const measuredCount = Number(tgt.measured ?? 0);
  const metCount = Number(tgt.met ?? 0);

  const secondaryCards = [
    {
      label: 'MONTHLY POINTS & STREAK',
      value: `${Number(report?.points ?? 0)} pts`,
      sub: `Current streak: ${Number(strk.current ?? 0)}d | Best: ${Number(strk.best ?? 0)}d`,
    },
    {
      label: 'SESSION ATTENDANCE',
      value: attPctStr,
      sub: `${Number(att.present ?? 0)} present | ${Number(att.absent ?? 0)} absent | ${Number(att.excused ?? 0)} excused`,
    },
    {
      label: 'BASICS TARGETS',
      value: measuredCount > 0 ? `${metCount} of ${measuredCount} met target` : 'No target entries',
      sub:
        measuredCount > 0
          ? 'Basics speed & accuracy benchmark'
          : 'No target-measured entries this month',
    },
  ];

  secondaryCards.forEach((card, idx) => {
    const bx = MARGIN_X + idx * (secW + kpiGap);
    drawRect(bx, y, secW, secH, [1, 1, 1], [0.82, 0.85, 0.9], 0.8);
    drawText(card.label, bx + 10, y - 14, { font: 'F2', size: 7.5, color: [0.39, 0.45, 0.55] });
    drawText(card.value, bx + 10, y - 31, { font: 'F2', size: 12, color: [0.06, 0.09, 0.16] });
    drawText(truncatePdfStr(card.sub, 38), bx + 10, y - 45, {
      font: 'F1',
      size: 7.5,
      color: [0.39, 0.45, 0.55],
    });
  });

  y -= secH + 18;

  // Helper to draw a table section
  function drawTableSection({ title, subtitle, columns, rows, emptyText }) {
    ensureSpace(65);
    drawText(title, MARGIN_X, y - 10, { font: 'F2', size: 11, color: [0.06, 0.09, 0.16] });
    if (subtitle) {
      drawText(truncatePdfStr(subtitle, 95), MARGIN_X, y - 23, {
        font: 'F1',
        size: 8.5,
        color: [0.39, 0.45, 0.55],
      });
      y -= 30;
    } else {
      y -= 18;
    }

    const headerH = 20;
    drawRect(MARGIN_X, y, CONTENT_W, headerH, [0.945, 0.961, 0.976], [0.82, 0.85, 0.9], 0.7);
    columns.forEach((col) => {
      drawText(col.header, MARGIN_X + col.x, y - 13, {
        font: 'F2',
        size: 8.2,
        color: [0.2, 0.25, 0.33],
      });
    });
    y -= headerH;

    const rowH = 19;
    if (!rows || rows.length === 0) {
      drawRect(MARGIN_X, y, CONTENT_W, rowH + 4, [1, 1, 1], [0.88, 0.9, 0.94], 0.6);
      drawText(emptyText || 'No records for this period.', MARGIN_X + 10, y - 14, {
        font: 'F1',
        size: 8.5,
        color: [0.45, 0.5, 0.58],
      });
      y -= rowH + 18;
      return;
    }

    rows.forEach((row, rIdx) => {
      if (y - rowH < BOTTOM_MARGIN) {
        startNewPage();
        drawRect(MARGIN_X, y, CONTENT_W, headerH, [0.945, 0.961, 0.976], [0.82, 0.85, 0.9], 0.7);
        columns.forEach((col) => {
          drawText(col.header, MARGIN_X + col.x, y - 13, {
            font: 'F2',
            size: 8.2,
            color: [0.2, 0.25, 0.33],
          });
        });
        y -= headerH;
      }

      const bg = rIdx % 2 === 1 ? [0.985, 0.99, 0.996] : [1, 1, 1];
      drawRect(MARGIN_X, y, CONTENT_W, rowH, bg, [0.88, 0.9, 0.94], 0.5);
      columns.forEach((col) => {
        const rawVal = row[col.key] ?? '-';
        const cellStr = col.maxChars ? truncatePdfStr(rawVal, col.maxChars) : String(rawVal);
        drawText(cellStr, MARGIN_X + col.x, y - 13, {
          font: col.bold ? 'F2' : 'F1',
          size: 8.5,
          color: [0.12, 0.16, 0.23],
        });
      });
      y -= rowH;
    });

    y -= 16;
  }

  // 4. Week-by-Week Practice Table
  const weekRows = weeks.map((w) => ({
    week: w.week_start ? `Week of ${formatReportDateIST(w.week_start)}` : 'Week',
    entries: String(Number(w.entries ?? 0)),
    accuracy: formatPdfNum(w.accuracy, '%', 1),
  }));

  drawTableSection({
    title: 'Week-by-Week Practice',
    subtitle: 'Entries and accuracy for each week in this month',
    columns: [
      { header: 'Week Starting', key: 'week', x: 10, maxChars: 42, bold: true },
      { header: 'Entries', key: 'entries', x: 340 },
      { header: 'Accuracy', key: 'accuracy', x: 435, bold: true },
    ],
    rows: weekRows,
    emptyText: 'No weekly practice data for this month.',
  });

  // 5. Categories Practised (3+ Entries)
  const focusSubtitle =
    categories.length > 0
      ? `Focus areas (lowest accuracy first): ${categories
          .slice(0, 3)
          .map((c) => `${c.name} (${formatPdfNum(c.accuracy, '%', 1)})`)
          .join(' | ')}`
      : 'Sorted lowest accuracy first to highlight focus areas (minimum 3 entries)';

  const categoryRows = categories.map((cat, idx) => ({
    name: idx < 3 ? `${cat.name} [Focus]` : String(cat.name || '-'),
    section: String(cat.section || 'round'),
    entries: String(Number(cat.entries ?? 0)),
    wrong: String(Number(cat.wrong ?? 0)),
    accuracy: formatPdfNum(cat.accuracy, '%', 1),
  }));

  drawTableSection({
    title: 'Categories Practised (3+ Entries)',
    subtitle: focusSubtitle,
    columns: [
      { header: 'Category', key: 'name', x: 10, maxChars: 42, bold: true },
      { header: 'Section', key: 'section', x: 255, maxChars: 15 },
      { header: 'Entries', key: 'entries', x: 340 },
      { header: 'Wrong', key: 'wrong', x: 395 },
      { header: 'Accuracy', key: 'accuracy', x: 450, bold: true },
    ],
    rows: categoryRows,
    emptyText: 'No categories with at least 3 entries recorded this month.',
  });

  // 6. Weekly Tests This Month
  const testRows = weeklyTests.map((wt) => ({
    date: wt.date ? formatReportDateIST(wt.date) : '-',
    title: String(wt.title || 'Weekly Test'),
    category: String(wt.category || '-'),
    score: `${Number(wt.correct ?? 0)} / ${Number(wt.total ?? 0)}`,
    time:
      wt.time_seconds !== null && wt.time_seconds !== undefined
        ? formatPdfTimeSec(wt.time_seconds)
        : '-',
  }));

  drawTableSection({
    title: 'Weekly Tests This Month',
    subtitle: 'Official weekly test scores recorded during the month',
    columns: [
      { header: 'Date', key: 'date', x: 10, maxChars: 16 },
      { header: 'Test Title', key: 'title', x: 95, maxChars: 34, bold: true },
      { header: 'Category', key: 'category', x: 280, maxChars: 20 },
      { header: 'Score', key: 'score', x: 395, bold: true },
      { header: 'Time', key: 'time', x: 465 },
    ],
    rows: testRows,
    emptyText: 'No weekly test scores recorded in this month.',
  });

  if (currentOps.length > 0 || pages.length === 0) {
    pages.push(currentOps);
  }

  // Add footer to each page
  const totalPages = pages.length;
  pages.forEach((ops, idx) => {
    const pageNumStr = `Page ${idx + 1} of ${totalPages}`;
    ops.push('BT');
    ops.push('/F1 8 Tf');
    ops.push('0.450 0.500 0.580 rg');
    ops.push(`1 0 0 1 ${MARGIN_X} 28 Tm`);
    ops.push('(Trendz Abacus Speed & Accuracy Tracker - Monthly Student Report) Tj');
    ops.push('ET');

    ops.push('BT');
    ops.push('/F1 8 Tf');
    ops.push('0.450 0.500 0.580 rg');
    ops.push(`1 0 0 1 ${MARGIN_X + CONTENT_W - 55} 28 Tm`);
    ops.push(`(${pdfEscapeText(pageNumStr)}) Tj`);
    ops.push('ET');
  });

  // Assemble PDF 1.4 objects
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // 3: Font F1 (Helvetica)
  // 4: Font F2 (Helvetica-Bold)
  // For each page i (0..totalPages-1):
  //   pageObjId = 5 + i * 2
  //   contentObjId = 6 + i * 2
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);

  objects.push({
    id: 1,
    body: '<< /Type /Catalog /Pages 2 0 R >>',
  });
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

  const encoder = new TextEncoder();
  pages.forEach((ops, i) => {
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
  const offsets = [0]; // index 0 is free object

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

