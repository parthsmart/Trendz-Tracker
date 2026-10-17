/**
 * Trendz Tracker - Admin Overview Controller (js/adminOverview.js)
 * 
 * Coordinates:
 * 1. Admin-only Route Guard
 * 2. Single call to database RPC public.admin_overview() (or DemoDB.getAdminOverview in demo mode)
 * 3. Calculation of top summary statistics (Active, Entered Today, Not Entered, Avg 7d Accuracy, Longest Streak)
 * 4. "Needs Attention" detection (active students with no entry in >= 3 days)
 * 5. In-browser instant search, level filter, status filter, multi-column sorting
 * 6. 25-row paginated student table with Indian Standard Time dates
 * 
 * STRICT COMPLIANCE:
 * - Never compute streaks in JavaScript; consume current_streak directly from admin_overview().
 * - Never use browser clock for "today"; authoritative Indian Standard Time is used.
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isDemoMode } from './demoDb.js';
import { getISTDateString, formatDisplayDateIST } from './stats.js';

const PAGE_SIZE = 25;

// State
let allOverviewData = [];
let todayIST = '';
let currentSearch = '';
let currentLevelFilter = '';
let currentStatusFilter = '';
let currentSortColumn = 'student_code';
let currentSortAsc = true;
let currentPage = 1;

/**
 * Escapes HTML characters for safe DOM insertion
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Calculates calendar day difference between two YYYY-MM-DD IST dates.
 */
function getDaysDifference(dateStrA, dateStrB) {
  if (!dateStrA || !dateStrB) return 999;
  const [y1, m1, d1] = dateStrA.split('-').map(Number);
  const [y2, m2, d2] = dateStrB.split('-').map(Number);
  const utcA = Date.UTC(y1, m1 - 1, d1);
  const utcB = Date.UTC(y2, m2 - 1, d2);
  return Math.round(Math.abs(utcA - utcB) / (24 * 60 * 60 * 1000));
}

/**
 * Initializes the Overview page
 */
async function initAdminOverview() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  renderDemoBanner();

  await loadOverviewData();
  attachEventListeners();
}

/**
 * Renders the visible persistent demo banner if running in demo mode
 */
function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;

  if (isDemoMode()) {
    placeholder.innerHTML = `
      <div class="banner banner-warning" style="margin-bottom: var(--space-4);" role="alert">
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 1.1rem;" aria-hidden="true">⚠️</span>
          <div>
            <strong>DEMO MODE — data is fake:</strong> Running with simulated sample students on development host.
          </div>
        </div>
      </div>
    `;
  }
}

/**
 * Fetches overview data from RPC admin_overview() once per page load
 */
async function loadOverviewData() {
  const tbody = document.getElementById('overview-table-body');
  if (tbody) {
    tbody.innerHTML = `
      <tr><td colspan="8"><div class="skeleton-row"></div></td></tr>
      <tr><td colspan="8"><div class="skeleton-row"></div></td></tr>
      <tr><td colspan="8"><div class="skeleton-row"></div></td></tr>
    `;
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        // Resolve authoritative Indian time for today
        try {
          const { data: istData } = await supabase.rpc('today_ist');
          todayIST = istData ? getISTDateString(istData) : getISTDateString(new Date());
        } catch {
          todayIST = getISTDateString(new Date());
        }

        // Call authoritative admin_overview RPC
        const { data, error } = await supabase.rpc('admin_overview');
        if (!error && Array.isArray(data)) {
          allOverviewData = data;
          updateDashboard();
          return;
        } else if (error) {
          console.warn('RPC admin_overview error, falling back:', error.message);
        }
      }
    }

    // Demo Mode fallback
    todayIST = getISTDateString(new Date());
    allOverviewData = DemoDB.getAdminOverview();
    updateDashboard();
  } catch (err) {
    console.warn('Failed to load admin overview:', err);
    todayIST = getISTDateString(new Date());
    allOverviewData = DemoDB.getAdminOverview();
    updateDashboard();
  }
}

/**
 * Updates top summary cards, attention box, and triggers table re-render
 */
function updateDashboard() {
  const todayEl = document.getElementById('overview-today-ist');
  if (todayEl) {
    todayEl.textContent = formatDisplayDateIST(todayIST);
  }

  // 1. Calculate top summary metrics
  const activeStudents = allOverviewData.filter(s => !!s.active);
  const activeCount = activeStudents.length;

  const enteredTodayStudents = activeStudents.filter(s => !!s.entered_today);
  const enteredTodayCount = enteredTodayStudents.length;
  const notEnteredTodayCount = Math.max(0, activeCount - enteredTodayCount);

  // Average 7-day accuracy among active students with an accuracy value
  const accuracyValues = activeStudents
    .map(s => s.accuracy_7d)
    .filter(a => a !== null && a !== undefined && !isNaN(Number(a)));

  const avgAccuracy = accuracyValues.length > 0
    ? (accuracyValues.reduce((acc, v) => acc + Number(v), 0) / accuracyValues.length).toFixed(1)
    : '—';

  // Longest current streak
  let longestStreakVal = 0;
  let longestStreakName = '—';
  activeStudents.forEach(s => {
    const st = Number(s.current_streak) || 0;
    if (st > longestStreakVal) {
      longestStreakVal = st;
      longestStreakName = s.full_name || s.student_code;
    }
  });

  // Populate cards
  const elActive = document.getElementById('stat-active-students');
  const elEntered = document.getElementById('stat-entered-today');
  const elNotEntered = document.getElementById('stat-not-entered');
  const elAvgAcc = document.getElementById('stat-avg-accuracy');
  const elStreak = document.getElementById('stat-longest-streak');

  if (elActive) elActive.textContent = String(activeCount);
  if (elEntered) elEntered.textContent = `${enteredTodayCount} of ${activeCount}`;
  if (elNotEntered) elNotEntered.textContent = String(notEnteredTodayCount);
  if (elAvgAcc) elAvgAcc.textContent = avgAccuracy !== '—' ? `${avgAccuracy}%` : '—';
  if (elStreak) {
    if (longestStreakVal > 0) {
      elStreak.innerHTML = `
        <span style="color: #f97316;">🔥</span>
        <span>${longestStreakVal}d</span>
        <span style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 500; margin-left: 4px;">
          (${escapeHtml(longestStreakName)})
        </span>
      `;
    } else {
      elStreak.textContent = '0d';
    }
  }

  // 2. Needs Attention: active students with no entry in 3 or more days
  renderNeedsAttention(activeStudents);

  // 3. Render filtered, sorted & paginated table
  renderTable();
}

/**
 * Renders the "Needs Attention" alert box for active students inactive for 3+ days
 */
function renderNeedsAttention(activeStudents) {
  const container = document.getElementById('needs-attention-box');
  const listEl = document.getElementById('attention-list');
  const countEl = document.getElementById('attention-count');
  if (!container || !listEl || !countEl) return;

  const inactiveList = activeStudents.filter(s => {
    if (!s.last_entry_date) return true; // never entered
    const days = getDaysDifference(todayIST, s.last_entry_date);
    return days >= 3;
  });

  if (inactiveList.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  countEl.textContent = `${inactiveList.length} student${inactiveList.length === 1 ? '' : 's'}`;

  listEl.innerHTML = inactiveList.map(s => {
    const daysAgo = s.last_entry_date
      ? getDaysDifference(todayIST, s.last_entry_date)
      : null;
    const daysLabel = daysAgo !== null ? `${daysAgo} days ago` : 'Never recorded';

    return `
      <div class="attention-item">
        <div style="min-width: 0;">
          <div>
            <a href="/pages/student-detail.html?id=${encodeURIComponent(s.student_id)}" class="student-name-link" style="color: var(--color-primary); font-weight: 600; text-decoration: none;">
              ${escapeHtml(s.full_name)}
            </a>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); display: flex; gap: 4px; align-items: center;">
            <span class="num">${escapeHtml(s.student_code)}</span>
            <span aria-hidden="true">·</span>
            <span>${escapeHtml(s.level || 'Unassigned')}</span>
          </div>
        </div>
        <div style="text-align: right; white-space: nowrap;">
          <span style="font-size: 11px; font-weight: 700; color: var(--color-warning-text); display: block;">
            ${daysLabel}
          </span>
          <span style="font-size: 10px; color: var(--text-dim);">
            ${s.last_entry_date ? formatDisplayDateIST(s.last_entry_date) : 'No entries'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Filters, sorts, and renders the current page of students
 */
function renderTable() {
  const tbody = document.getElementById('overview-table-body');
  if (!tbody) return;

  // 1. Filter
  let filtered = allOverviewData.filter(student => {
    // Search query: match student_code or full_name
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      const matchName = String(student.full_name || '').toLowerCase().includes(q);
      const matchCode = String(student.student_code || '').toLowerCase().includes(q);
      if (!matchName && !matchCode) return false;
    }

    // Level filter
    if (currentLevelFilter) {
      if (student.level !== currentLevelFilter) return false;
    }

    // Status filter
    if (currentStatusFilter) {
      if (currentStatusFilter === 'done' && (!student.active || !student.entered_today)) return false;
      if (currentStatusFilter === 'pending' && (!student.active || student.entered_today)) return false;
      if (currentStatusFilter === 'inactive' && student.active) return false;
    }

    return true;
  });

  // 2. Sort
  filtered.sort((a, b) => {
    let valA = a[currentSortColumn];
    let valB = b[currentSortColumn];

    if (currentSortColumn === 'today_status') {
      valA = !a.active ? 0 : (a.entered_today ? 2 : 1);
      valB = !b.active ? 0 : (b.entered_today ? 2 : 1);
    } else if (currentSortColumn === 'accuracy_7d') {
      valA = valA !== null && valA !== undefined ? Number(valA) : -1;
      valB = valB !== null && valB !== undefined ? Number(valB) : -1;
    } else if (currentSortColumn === 'current_streak' || currentSortColumn === 'entries_7d') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
    } else if (typeof valA === 'string' || typeof valB === 'string') {
      valA = String(valA || '').toLowerCase();
      valB = String(valB || '').toLowerCase();
    }

    if (valA < valB) return currentSortAsc ? -1 : 1;
    if (valA > valB) return currentSortAsc ? 1 : -1;
    return 0;
  });

  // 3. Paginate
  const totalStudents = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalStudents / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(startIndex, startIndex + PAGE_SIZE);

  // Update pagination indicators
  const pageInfoEl = document.getElementById('overview-pagination-info');
  const pageCurEl = document.getElementById('overview-page-current');
  const btnPrev = document.getElementById('btn-page-prev');
  const btnNext = document.getElementById('btn-page-next');

  if (pageInfoEl) {
    if (totalStudents === 0) {
      pageInfoEl.textContent = 'Showing 0 of 0 students';
    } else {
      const endCount = Math.min(startIndex + PAGE_SIZE, totalStudents);
      pageInfoEl.textContent = `Showing ${startIndex + 1}–${endCount} of ${totalStudents} students`;
    }
  }
  if (pageCurEl) {
    pageCurEl.textContent = `Page ${currentPage} of ${totalPages}`;
  }
  if (btnPrev) btnPrev.disabled = currentPage <= 1;
  if (btnNext) btnNext.disabled = currentPage >= totalPages;

  // 4. Render rows or empty state
  if (pageRows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state-cell">
          <div class="empty-state" style="padding: var(--space-8) var(--space-4);">
            <div class="empty-state-icon" aria-hidden="true">🔍</div>
            <h3 class="empty-state-title">No students match your filter</h3>
            <p class="empty-state-desc">Try clearing your search term or selecting "All Levels" and "All Statuses".</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = pageRows.map(student => {
    // Today's Status Chip
    let statusChip = '';
    if (!student.active) {
      statusChip = '<span class="status-chip chip-inactive">Inactive</span>';
    } else if (student.entered_today) {
      statusChip = '<span class="status-chip chip-done">✓ Done</span>';
    } else {
      statusChip = '<span class="status-chip chip-pending">⏳ Not yet</span>';
    }

    // Last Entry Date
    const lastEntryStr = student.last_entry_date
      ? formatDisplayDateIST(student.last_entry_date)
      : '<span style="color: var(--text-dim);">No entries</span>';

    // 7-Day Accuracy
    const accStr = student.accuracy_7d !== null && student.accuracy_7d !== undefined
      ? `${Number(student.accuracy_7d).toFixed(1)}%`
      : '<span style="color: var(--text-dim);">—</span>';

    // Current Streak Display
    const streakNum = Number(student.current_streak) || 0;
    const streakDisplay = streakNum > 0
      ? `<span style="color: #f97316; font-weight: 700;">🔥 ${streakNum}d</span>`
      : '<span style="color: var(--text-dim);">0d</span>';

    return `
      <tr class="${student.active ? '' : 'row-inactive'}">
        <td style="font-weight: 600;">
          <a href="/pages/student-detail.html?id=${encodeURIComponent(student.student_id)}" class="student-name-link" style="color: var(--color-primary); font-weight: 600; text-decoration: none;">
            ${escapeHtml(student.full_name)}
          </a>
        </td>
        <td class="num" style="color: var(--text-muted); font-size: var(--text-xs);">
          ${escapeHtml(student.student_code)}
        </td>
        <td style="color: var(--text-muted);">
          ${student.level ? escapeHtml(student.level) : '<span style="color: var(--text-dim);">—</span>'}
        </td>
        <td>
          ${streakDisplay}
        </td>
        <td>
          ${statusChip}
        </td>
        <td style="font-size: var(--text-xs);">
          ${lastEntryStr}
        </td>
        <td class="num" style="text-align: right; font-weight: 500;">
          ${Number(student.entries_7d) || 0}
        </td>
        <td class="num" style="text-align: right; font-weight: 600; color: ${student.accuracy_7d && student.accuracy_7d >= 90 ? 'var(--color-accent-text)' : 'inherit'};">
          ${accStr}
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Attaches search, filter, sort, and pagination listeners
 */
function attachEventListeners() {
  // Search input
  const searchInput = document.getElementById('search-overview');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.trim();
      currentPage = 1;
      renderTable();
    });
  }

  // Level filter
  const levelSelect = document.getElementById('filter-overview-level');
  if (levelSelect) {
    levelSelect.addEventListener('change', (e) => {
      currentLevelFilter = e.target.value;
      currentPage = 1;
      renderTable();
    });
  }

  // Status filter
  const statusSelect = document.getElementById('filter-overview-status');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      currentStatusFilter = e.target.value;
      currentPage = 1;
      renderTable();
    });
  }

  // Table header sorting
  document.querySelectorAll('#overview-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-sort');
      if (currentSortColumn === col) {
        currentSortAsc = !currentSortAsc;
      } else {
        currentSortColumn = col;
        currentSortAsc = true;
      }

      // Update sort indicators
      document.querySelectorAll('#overview-table th[data-sort] .sort-icon').forEach(icon => {
        icon.textContent = '↕';
      });
      const icon = th.querySelector('.sort-icon');
      if (icon) {
        icon.textContent = currentSortAsc ? '▲' : '▼';
      }

      renderTable();
    });
  });

  // Pagination buttons
  const btnPrev = document.getElementById('btn-page-prev');
  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        renderTable();
      }
    });
  }

  const btnNext = document.getElementById('btn-page-next');
  if (btnNext) {
    btnNext.addEventListener('click', () => {
      currentPage++;
      renderTable();
    });
  }
}

// Bootstrap
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAdminOverview);
}
