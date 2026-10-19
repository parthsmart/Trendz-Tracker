/**
 * Trendz Tracker - Monthly Student Report Controller (js/monthlyReport.js)
 *
 * Serves both Students and Admins on /pages/monthly-report.html (and /pages/report.html):
 * - Guard: requireAuth(['student', 'admin'])
 * - Student view: strictly loads the logged-in student's own report (`p_student = profile.id`);
 *   never reads a student ID from URL query parameters.
 * - Admin view: student selector dropdown (pre-selecting `?id=` or `?studentId=` if present)
 *   plus month selector (`p_month` as `YYYY-MM-01` or `null` for current month).
 * - Never calculates streaks, points, accuracy, attendance, or consistency percentages in JS;
 *   renders authoritative values from `student_month_report(p_student, p_month)`.
 * - Includes Print (`window.print()`), Copy Summary, and manual WhatsApp share link.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { setupAdminNav } from './modal.js';
import {
  fetchStudentMonthReport,
  formatMonthHeadingIST,
  buildMonthlyReportShareText,
  buildMonthlyReportPdfBytes,
  getMonthlyReportPdfFilename,
} from './monthlyReportData.js';
import { formatDisplayDateIST, formatSecondsToTime, getISTDateString } from './stats.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { showToast } from './toast.js';

let currentProfile = null;
let isAdmin = false;
let selectedStudentId = null;
let selectedMonthStr = ''; // '' means current month (null p_month), or 'YYYY-MM'
let lastLoadedReport = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumOrDash(val, suffix = '', decimals = null) {
  if (val === null || val === undefined || val === '') return '—';
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  const str = decimals !== null ? num.toFixed(decimals).replace(/\.0$/, '') : String(num);
  return `${str}${suffix}`;
}

/**
 * Shifts a YYYY-MM string by deltaMonths (-1 or +1)
 */
function shiftYearMonth(ymStr, deltaMonths) {
  let year;
  let month;
  const match = /^(\d{4})-(\d{2})/.exec(ymStr || '');
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
  } else {
    const todayIso = getISTDateString(new Date());
    const [y, m] = todayIso.split('-').map(Number);
    year = y || 2026;
    month = m || 10;
  }

  const d = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
  const nextY = d.getUTCFullYear();
  const nextM = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${nextY}-${nextM}`;
}

async function initMonthlyReportPage() {
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;

  currentProfile = profile;
  isAdmin = profile.role === 'admin';

  configureHeaderNavigation(profile);
  renderDemoBannerIfNeeded();

  // Initialize default month input to current IST YYYY-MM
  const todayIst = getISTDateString(new Date());
  const currentYm = todayIst ? todayIst.slice(0, 7) : '2026-10';
  const monthInput = document.getElementById('select-report-month');
  if (monthInput) {
    monthInput.value = currentYm;
  }

  if (isAdmin) {
    await setupAdminStudentSelector();
  } else {
    // STRICT RULE: Students can ONLY view their own report; ignore any URL ?id= param.
    selectedStudentId = profile.id;
  }

  attachEventListeners(currentYm);
  await loadAndRenderReport();
}

function configureHeaderNavigation(profile) {
  const studentNav = document.getElementById('student-nav-zone');
  const adminNav = document.getElementById('admin-nav-zone');
  const mobileMenuBtn = document.getElementById('btn-mobile-menu');
  const brandLink = document.getElementById('header-brand-link');
  const userPill = document.getElementById('user-pill-container');
  const userNameEl = document.getElementById('header-user-name');
  const userCodeEl = document.getElementById('header-user-code');

  if (userPill) userPill.style.display = 'flex';
  if (userNameEl) userNameEl.textContent = profile.full_name || (isAdmin ? 'Admin' : 'Student');
  if (userCodeEl) {
    userCodeEl.textContent = isAdmin ? 'Teacher / Admin' : (profile.student_code || 'STU');
  }

  if (isAdmin) {
    if (studentNav) studentNav.style.display = 'none';
    if (adminNav) adminNav.style.display = 'flex';
    if (mobileMenuBtn) mobileMenuBtn.style.display = '';
    if (brandLink) brandLink.href = '/pages/admin.html';
    setupAdminNav();
  } else {
    if (studentNav) studentNav.style.display = 'flex';
    if (adminNav) adminNav.style.display = 'none';
    if (mobileMenuBtn) mobileMenuBtn.style.display = 'none';
    if (brandLink) brandLink.href = '/pages/student.html';
  }
}

function renderDemoBannerIfNeeded() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  if (isDemoMode()) {
    placeholder.innerHTML = `
      <div class="banner banner-demo no-print" style="margin-bottom: var(--space-4);">
        <span class="banner-icon" aria-hidden="true">ℹ️</span>
        <div class="banner-body">
          <strong>DEMO MODE &mdash; data is fake:</strong>
          Showing static sample monthly report data on development host.
        </div>
      </div>
    `;
  }
}

/**
 * Populates the student dropdown for Admins and resolves initial selectedStudentId from URL ?id= or ?studentId=
 */
async function setupAdminStudentSelector() {
  const wrapper = document.getElementById('admin-student-selector-wrapper');
  const selectEl = document.getElementById('select-report-student');
  const detailLink = document.getElementById('btn-view-student-detail');
  if (wrapper) wrapper.style.display = 'flex';
  if (!selectEl) return;

  let students = [];
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data } = await supabase
          .from('profiles')
          .select('id, student_code, full_name, level, active')
          .eq('role', 'student')
          .order('student_code', { ascending: true });
        if (Array.isArray(data)) students = data;
      }
    } else if (isDemoMode()) {
      students = DemoDB.getStudents().filter((s) => s.role !== 'admin');
    }
  } catch (err) {
    console.warn('Could not load student list for monthly report selector:', err);
  }

  if (students.length === 0) {
    selectEl.innerHTML = `<option value="">No students found</option>`;
    return;
  }

  selectEl.innerHTML = students
    .map((s) => {
      const inactiveTag = s.active === false ? ' [Inactive]' : '';
      return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name)} (${escapeHtml(s.student_code)} · ${escapeHtml(s.level || 'Unassigned')})${inactiveTag}</option>`;
    })
    .join('');

  const params = new URLSearchParams(window.location.search);
  const requestedId = (params.get('id') || params.get('studentId') || '').trim();
  const matched = students.find(
    (s) => s.id === requestedId || s.student_code.toLowerCase() === requestedId.toLowerCase()
  );

  selectedStudentId = matched ? matched.id : students[0].id;
  selectEl.value = selectedStudentId;

  if (detailLink && selectedStudentId) {
    detailLink.href = `/pages/student-detail.html?id=${encodeURIComponent(selectedStudentId)}`;
    detailLink.style.display = 'inline-flex';
  }
}

async function loadAndRenderReport() {
  const errorBanner = document.getElementById('report-error-banner');
  const errorMsgEl = document.getElementById('report-error-message');
  const skeletonBox = document.getElementById('report-loading-skeleton');
  const contentBox = document.getElementById('report-main-content');

  if (errorBanner) errorBanner.style.display = 'none';
  if (skeletonBox) skeletonBox.style.display = 'block';
  if (contentBox) contentBox.style.display = 'none';

  if (!selectedStudentId) {
    if (skeletonBox) skeletonBox.style.display = 'none';
    if (errorBanner) errorBanner.style.display = 'flex';
    if (errorMsgEl) errorMsgEl.textContent = 'Please select a student to view their monthly report.';
    return;
  }

  try {
    const pMonthArg = selectedMonthStr ? `${selectedMonthStr}-01` : null;
    const report = await fetchStudentMonthReport({
      studentId: selectedStudentId,
      monthDate: pMonthArg,
    });

    lastLoadedReport = report;
    renderReportContent(report);

    if (skeletonBox) skeletonBox.style.display = 'none';
    if (contentBox) contentBox.style.display = 'block';
  } catch (err) {
    console.error('Failed to load monthly student report:', err);
    if (skeletonBox) skeletonBox.style.display = 'none';
    if (errorBanner) errorBanner.style.display = 'flex';
    if (errorMsgEl) {
      errorMsgEl.textContent = err.message || 'Could not load monthly report. Please try again.';
    }
  }
}

function renderReportContent(report) {
  const st = report?.student || {};
  const prac = report?.practice || {};
  const prev = report?.previous || {};
  const strk = report?.streak || {};
  const att = report?.attendance || {};
  const tgt = report?.targets || {};
  const weeks = Array.isArray(report?.weeks) ? report.weeks : [];
  const categories = Array.isArray(report?.categories) ? report.categories : [];
  const weeklyTests = Array.isArray(report?.weekly_tests) ? report.weekly_tests : [];

  // Sync month picker if selectedMonthStr was empty
  if (!selectedMonthStr && report?.month_start) {
    const ym = String(report.month_start).slice(0, 7);
    const monthInput = document.getElementById('select-report-month');
    if (monthInput && /^\d{4}-\d{2}$/.test(ym)) {
      monthInput.value = ym;
    }
  }

  // 1. Header Identity & Period
  const titleEl = document.getElementById('report-month-heading');
  const studentNameEl = document.getElementById('report-student-name');
  const studentCodeEl = document.getElementById('report-student-code');
  const studentLevelEl = document.getElementById('report-student-level');
  const dateRangeEl = document.getElementById('report-date-range');
  const daysElapsedEl = document.getElementById('report-days-elapsed');

  if (titleEl) titleEl.textContent = `Monthly Report — ${formatMonthHeadingIST(report?.month_start)}`;
  if (studentNameEl) studentNameEl.textContent = st.name || 'Student';
  if (studentCodeEl) studentCodeEl.textContent = st.code || '—';
  if (studentLevelEl) studentLevelEl.textContent = st.level || 'Unassigned';
  if (dateRangeEl) {
    dateRangeEl.textContent = `${formatDisplayDateIST(report?.month_start)} – ${formatDisplayDateIST(report?.month_end)}`;
  }
  if (daysElapsedEl) {
    daysElapsedEl.textContent = `${Number(report?.days_elapsed ?? 0)} days elapsed`;
  }

  // Update WhatsApp share link
  const waBtn = document.getElementById('btn-whatsapp-report');
  if (waBtn) {
    const shareText = buildMonthlyReportShareText(report);
    waBtn.href = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  }

  // 2. Top Summary Metric Cards (strictly from RPC, zero consistency percentage calculation)
  setText('metric-practice-days', `${Number(prac.practice_days ?? 0)} days`);
  setText(
    'metric-practice-days-sub',
    `${Number(report?.days_elapsed ?? 0)} days elapsed · Last month: ${Number(prev.practice_days ?? 0)} days`
  );

  setText('metric-entries', String(Number(prac.entries ?? 0)));
  setText(
    'metric-entries-sub',
    `${Number(prac.correct ?? 0)} / ${Number(prac.total ?? 0)} correct · ${Number(prac.rounds ?? 0)} rounds · Last month: ${Number(prev.entries ?? 0)}`
  );

  setText('metric-accuracy', formatNumOrDash(prac.accuracy, '%', 1));
  setText('metric-accuracy-sub', `Last month: ${formatNumOrDash(prev.accuracy, '%', 1)}`);

  setText('metric-qpm', formatNumOrDash(prac.qpm, ' QPM', 1));
  setText('metric-qpm-sub', `Last month: ${formatNumOrDash(prev.qpm, ' QPM', 1)}`);

  setText('metric-points', `${Number(report?.points ?? 0)} pts`);
  setText('metric-streak', `🔥 ${Number(strk.current ?? 0)}d current · Best: ${Number(strk.best ?? 0)}d`);

  // 3. Attendance & Basics Targets Summary
  const attPctStr =
    att.percent !== null && att.percent !== undefined && Number.isFinite(Number(att.percent))
      ? `${Number(att.percent).toFixed(1).replace(/\.0$/, '')}%`
      : 'No sessions';
  setText('metric-attendance-pct', attPctStr);
  setText(
    'metric-attendance-counts',
    `${Number(att.present ?? 0)} present · ${Number(att.absent ?? 0)} absent · ${Number(att.excused ?? 0)} excused`
  );

  const measuredCount = Number(tgt.measured ?? 0);
  const metCount = Number(tgt.met ?? 0);
  if (measuredCount > 0) {
    setText('metric-targets-main', `${metCount} of ${measuredCount} met target`);
    setText('metric-targets-sub', 'Basics speed & accuracy target benchmark');
  } else {
    setText('metric-targets-main', 'No target entries');
    setText('metric-targets-sub', 'No basics target-measured entries logged this month');
  }

  // 4. Weekly Breakdown Table (weeks[])
  const weeksTbody = document.getElementById('report-weeks-tbody');
  if (weeksTbody) {
    if (weeks.length === 0) {
      weeksTbody.innerHTML = `
        <tr>
          <td colspan="3" style="text-align: center; color: var(--text-muted); padding: var(--space-4);">
            No weekly breakdown data for this month.
          </td>
        </tr>
      `;
    } else {
      weeksTbody.innerHTML = weeks
        .map((w) => {
          const weekLabel = w.week_start ? `Week of ${formatDisplayDateIST(w.week_start)}` : 'Week';
          const entries = Number(w.entries ?? 0);
          const acc = formatNumOrDash(w.accuracy, '%', 1);
          return `
            <tr>
              <td style="font-weight: 600;">${escapeHtml(weekLabel)}</td>
              <td class="num" style="text-align: right;">${entries}</td>
              <td class="num" style="text-align: right; font-weight: 600;">${escapeHtml(acc)}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  // 5. Categories Breakdown (categories[] sorted by accuracy ascending, >= 3 entries)
  const categoriesTbody = document.getElementById('report-categories-tbody');
  const focusCallout = document.getElementById('report-focus-categories');
  if (focusCallout) {
    if (categories.length === 0) {
      focusCallout.textContent = 'Complete at least 3 entries in a category this month to see category accuracy rankings.';
    } else {
      const lowestThree = categories
        .slice(0, 3)
        .map((c) => `${c.name} (${formatNumOrDash(c.accuracy, '%', 1)})`)
        .join(' · ');
      focusCallout.innerHTML = `<strong>Focus areas (lowest accuracy first):</strong> ${escapeHtml(lowestThree)}`;
    }
  }

  if (categoriesTbody) {
    if (categories.length === 0) {
      categoriesTbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: var(--space-4);">
            No categories with at least 3 entries recorded this month.
          </td>
        </tr>
      `;
    } else {
      categoriesTbody.innerHTML = categories
        .map((cat, idx) => {
          const isFocus = idx < 3;
          return `
            <tr style="${isFocus ? 'background-color: var(--bg-surface-subtle);' : ''}">
              <td style="font-weight: 600;">
                ${escapeHtml(cat.name)}
                ${isFocus ? `<span style="font-size: 11px; color: var(--color-warning-text); margin-left: 6px;">Needs practice</span>` : ''}
              </td>
              <td style="color: var(--text-muted); font-size: var(--text-xs); text-transform: capitalize;">
                ${escapeHtml(cat.section || 'round')}
              </td>
              <td class="num" style="text-align: right;">${Number(cat.entries ?? 0)}</td>
              <td class="num" style="text-align: right;">${Number(cat.wrong ?? 0)}</td>
              <td class="num" style="text-align: right; font-weight: 700;">
                ${escapeHtml(formatNumOrDash(cat.accuracy, '%', 1))}
              </td>
            </tr>
          `;
        })
        .join('');
    }
  }

  // 6. Weekly Tests Table (weekly_tests[])
  const testsTbody = document.getElementById('report-weekly-tests-tbody');
  if (testsTbody) {
    if (weeklyTests.length === 0) {
      testsTbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: var(--space-4);">
            No weekly test scores recorded in this month.
          </td>
        </tr>
      `;
    } else {
      testsTbody.innerHTML = weeklyTests
        .map((wt) => {
          const dateStr = wt.date ? formatDisplayDateIST(wt.date) : '—';
          const scoreStr = `${Number(wt.correct ?? 0)} / ${Number(wt.total ?? 0)}`;
          const timeStr =
            wt.time_seconds !== null && wt.time_seconds !== undefined
              ? formatSecondsToTime(wt.time_seconds)
              : '—';
          return `
            <tr>
              <td class="num" style="font-size: var(--text-xs); white-space: nowrap;">${escapeHtml(dateStr)}</td>
              <td style="font-weight: 600;">${escapeHtml(wt.title || 'Weekly Test')}</td>
              <td style="color: var(--text-muted);">${escapeHtml(wt.category || '—')}</td>
              <td class="num" style="text-align: right; font-weight: 600;">${escapeHtml(scoreStr)}</td>
              <td class="num" style="text-align: right; color: var(--text-muted);">${escapeHtml(timeStr)}</td>
            </tr>
          `;
        })
        .join('');
    }
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function attachEventListeners(defaultYm) {
  const monthInput = document.getElementById('select-report-month');
  const btnPrevMonth = document.getElementById('btn-prev-month');
  const btnThisMonth = document.getElementById('btn-this-month');
  const studentSelect = document.getElementById('select-report-student');
  const detailLink = document.getElementById('btn-view-student-detail');

  if (monthInput) {
    monthInput.addEventListener('change', () => {
      selectedMonthStr = monthInput.value || '';
      loadAndRenderReport();
    });
  }

  if (btnPrevMonth && monthInput) {
    btnPrevMonth.addEventListener('click', () => {
      const nextYm = shiftYearMonth(monthInput.value || defaultYm, -1);
      monthInput.value = nextYm;
      selectedMonthStr = nextYm;
      loadAndRenderReport();
    });
  }

  if (btnThisMonth && monthInput) {
    btnThisMonth.addEventListener('click', () => {
      monthInput.value = defaultYm;
      selectedMonthStr = '';
      loadAndRenderReport();
    });
  }

  if (studentSelect) {
    studentSelect.addEventListener('change', () => {
      selectedStudentId = studentSelect.value;
      if (detailLink && selectedStudentId) {
        detailLink.href = `/pages/student-detail.html?id=${encodeURIComponent(selectedStudentId)}`;
      }
      loadAndRenderReport();
    });
  }

  document.getElementById('btn-retry-report')?.addEventListener('click', () => {
    loadAndRenderReport();
  });

  document.getElementById('btn-print-report')?.addEventListener('click', () => {
    downloadMonthlyReportPdf();
  });

  document.getElementById('btn-browser-print')?.addEventListener('click', () => {
    handleBrowserPrintOrFallback();
  });

  document.getElementById('btn-copy-report')?.addEventListener('click', async () => {
    if (!lastLoadedReport) {
      showToast('info', 'Please wait for the monthly report to finish loading.');
      return;
    }
    const text = buildMonthlyReportShareText(lastLoadedReport);
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', 'Monthly report summary copied to clipboard.');
    } catch {
      showToast('info', text);
    }
  });
}

/**
 * Generates and downloads a real PDF 1.4 file directly in the browser.
 * Works reliably inside sandboxed preview iframes where window.print() is blocked.
 */
function downloadMonthlyReportPdf(customToastMessage = null) {
  if (!lastLoadedReport) {
    showToast('info', 'Please wait for the monthly report to finish loading.');
    return;
  }

  try {
    const pdfBytes = buildMonthlyReportPdfBytes(lastLoadedReport);
    const filename = getMonthlyReportPdfFilename(lastLoadedReport);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('success', customToastMessage || `Downloaded PDF report (${filename}).`);
  } catch (err) {
    console.error('Failed to generate PDF report:', err);
    showToast('error', 'Could not generate PDF file. Please try again.');
  }
}

/**
 * Invokes native browser print when top-level, or falls back to direct PDF download in sandboxed iframes.
 */
function handleBrowserPrintOrFallback() {
  if (!lastLoadedReport) {
    showToast('info', 'Please wait for the monthly report to finish loading.');
    return;
  }

  let isEmbeddedIframe = false;
  try {
    isEmbeddedIframe = window.self !== window.top;
  } catch {
    isEmbeddedIframe = true;
  }

  try {
    window.print();
  } catch {
    // Ignore sandbox print exception
  }

  if (isEmbeddedIframe) {
    downloadMonthlyReportPdf(
      'Print dialog is restricted in embedded preview — downloaded PDF report instead.'
    );
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initMonthlyReportPage);
}
