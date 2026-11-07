/**
 * Trendz Tracker - Admin Review Controller (js/review.js)
 * 
 * Review student practice entries with verification, flagging, corrections, and audit history:
 * - Admin-only route guard
 * - Server-side paginated list (50/page, newest first)
 * - Default filter: Unverified
 * - Bulk verify up to 200 rows with count confirmation
 * - RPCs used strictly:
 *     - admin_set_verified(p_ids, p_verified, p_reason)
 *     - admin_set_flag(p_id, p_flagged, p_note)
 *     - admin_correct_result(p_id, p_correct, p_total, p_time_seconds, p_note, p_reason)
 * - Result audit history drawer (result_audit)
 * - Indian Standard Time (IST) formatting
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToTime, getISTDateString, formatDisplayDateIST } from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { sendStudentMessage } from './studentMessages.js';

export const ALLOWED_CORRECTION_TABLES = Object.freeze(['results', 'activity_results']);

export function resolveCorrectionTableName(entryOrSource) {
  if (!entryOrSource) return 'results';
  if (typeof entryOrSource === 'object') {
    if (entryOrSource.table_name && ALLOWED_CORRECTION_TABLES.includes(entryOrSource.table_name)) {
      return entryOrSource.table_name;
    }
    if (entryOrSource.activity_type) {
      return 'activity_results';
    }
    return resolveCorrectionTableName(entryOrSource.source);
  }
  const s = String(entryOrSource).toLowerCase().trim();
  const sourceTableMap = {
    results: 'results',
    typed: 'results',
    sheet_sync: 'results',
    round: 'results',
    site: 'results',
    offline: 'results',
    online: 'results',
    activity_results: 'activity_results',
    element: 'activity_results',
    elements: 'activity_results',
    flash: 'activity_results',
    flash_anzan: 'activity_results',
    memoriad: 'activity_results',
  };
  return sourceTableMap[s] || 'results';
}

let currentProfile = null;
let allCategories = [];
let currentPage = 1;
const PAGE_SIZE = 50;
let totalEntriesCount = 0;
let selectedEntryIds = new Set();
let currentEntriesList = [];

// Filters state
let activeFilters = {
  studentSearch: '',
  dateFrom: '',
  dateTo: '',
  section: 'all',
  categoryId: 'all',
  status: 'unverified'
};

async function initReviewPage() {
  currentProfile = await requireAuth(['teacher', 'admin']);
  if (!currentProfile) return;

  if (currentProfile.role === 'teacher') {
    if (currentProfile.permissions?.can_review_scores === false) {
      window.location.href = '/pages/teacher.html';
      return;
    }
    const heading = document.querySelector('h1');
    if (heading) {
      heading.innerHTML = 'Review Practice Entries <span class="badge badge-info" style="font-size: var(--text-xs); vertical-align: middle; margin-left: 8px;">Assigned students only</span>';
    }
  }

  renderHeaderUser(currentProfile);
  if (currentProfile.role === 'admin') {
    setupAdminNav(currentProfile);
  }
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  // Check URL params for student filter (from student-detail page)
  const urlParams = new URLSearchParams(window.location.search);
  const studentParam = urlParams.get('studentId');
  if (studentParam && studentParam.trim()) {
    activeFilters.studentSearch = studentParam.trim();
    const searchInput = document.getElementById('filter-student');
    if (searchInput) searchInput.value = studentParam.trim();
  }

  await loadCategories();
  setupFilterControls();
  setupBulkVerifyControls();
  setupModalHandlers();
  if (currentProfile.role === 'admin') {
    await checkPendingCorrectionRequests();
  }

  // Initial load
  await loadReviewEntries();
}

let activeSupabaseOverride = null;
let cachedPendingRequests = [];

export function getCachedPendingCorrectionRequests() {
  return cachedPendingRequests;
}

export async function checkPendingCorrectionRequests(supabaseOverride = null) {
  if (supabaseOverride) {
    activeSupabaseOverride = supabaseOverride;
  }
  if (!activeSupabaseOverride && !isSupabaseConfigured()) return;
  try {
    const supabase = activeSupabaseOverride || await getSupabase();
    const { data: requests, error } = await supabase
      .from('score_correction_requests')
      .select('id, student_id, teacher_id, proposed_correct, proposed_total, reason, created_at, profiles!score_correction_requests_student_id_fkey(full_name, student_code)')
      .eq('status', 'pending');

    if (error) {
      console.warn('Check pending correction requests query failed:', error);
      // Distinguish query failure from empty response: do not clear banner or assume 0 requests on error
      return { success: false, error };
    }

    cachedPendingRequests = Array.isArray(requests) ? requests : [];

    // Successful empty response
    if (cachedPendingRequests.length === 0) {
      const banner = document.getElementById('pending-corrections-banner');
      if (banner) {
        banner.remove();
      }
      const modal = document.getElementById('admin-corrections-modal');
      if (modal) {
        closeModal('admin-corrections-modal');
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) modalBody.innerHTML = '';
      }
      return { success: true, count: 0, requests: [] };
    }

    // Successful response with pending requests
    let banner = document.getElementById('pending-corrections-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pending-corrections-banner';
      banner.className = 'banner banner-info';
      banner.style.cssText = 'margin-bottom: var(--space-4); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2);';
      const main = document.querySelector('main .container') || document.querySelector('main') || document.body;
      if (main) {
        if (main.firstChild) {
          main.insertBefore(banner, main.firstChild);
        } else {
          main.appendChild(banner);
        }
      }
    }
    banner.style.display = '';

    banner.innerHTML = `
      <div>
        <strong>📝 Teacher Score Corrections:</strong> There are <strong>${cachedPendingRequests.length}</strong> pending correction request(s) awaiting your decision.
      </div>
      <button type="button" id="btn-view-corrections" class="btn btn-outline btn-sm" style="background:#fff;">
        Review Requests (${cachedPendingRequests.length})
      </button>
    `;

    const btnView = document.getElementById('btn-view-corrections');
    if (btnView) {
      btnView.onclick = () => {
        openAdminCorrectionsModal(cachedPendingRequests, btnView);
      };
    }

    // If modal is currently open, refresh its content in place
    const modal = document.getElementById('admin-corrections-modal');
    if (modal && (modal.classList.contains('open') || modal.classList.contains('is-open'))) {
      renderAdminCorrectionsModalContent(modal, cachedPendingRequests);
    }

    return { success: true, count: cachedPendingRequests.length, requests: cachedPendingRequests };
  } catch (err) {
    console.warn('Check pending correction requests warning:', err);
    return { success: false, error: err };
  }
}

export function renderAdminCorrectionsModalContent(modal, requests) {
  modal.innerHTML = `
    <div class="modal-dialog" style="max-width: 680px;">
      <header class="modal-header">
        <div>
          <h2 class="modal-title">Pending Score Correction Requests</h2>
          <p class="modal-subtitle">Review proposed adjustments submitted by teachers.</p>
        </div>
        <button type="button" class="modal-close" data-close-modal="admin-corrections-modal" aria-label="Close modal">&times;</button>
      </header>
      <div class="modal-body" style="max-height: 440px; overflow-y: auto;">
        ${requests.map((r) => `
          <div class="correction-card" data-request-id="${r.id}" style="padding: var(--space-3); border: 1px solid var(--border-color, #e2e8f0); border-radius: var(--radius-md, 6px); margin-bottom: var(--space-3); background: var(--bg-surface, #fff);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
              <strong>${escapeHtml(r.profiles?.full_name || 'Student')} (${escapeHtml(r.profiles?.student_code || '')})</strong>
              <span class="badge badge-warning">Pending</span>
            </div>
            <div style="font-size: var(--text-sm); margin-bottom: 6px;">
              Proposed Score: <strong class="num">${r.proposed_correct} / ${r.proposed_total}</strong>
            </div>
            <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0 0 var(--space-3) 0;">
              Reason: "${escapeHtml(r.reason || 'None specified')}"
            </p>
            <div class="corr-actions-row" id="corr-actions-${r.id}" style="display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap;">
              <button type="button" class="btn btn-outline btn-sm btn-reject-corr" data-id="${r.id}">Reject</button>
              <button type="button" class="btn btn-primary btn-sm btn-approve-corr" data-id="${r.id}">Approve</button>
            </div>
            <div class="corr-form-container" id="corr-form-container-${r.id}" style="display: none; border-top: 1px dashed var(--border-color, #e2e8f0); padding-top: var(--space-2); margin-top: var(--space-2);"></div>
          </div>
        `).join('')}
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn btn-ghost" data-close-modal="admin-corrections-modal">Close</button>
      </footer>
    </div>
  `;

  // Wire close controls inside modal (both Close button and '×' button) without duplicating
  modal.querySelectorAll('[data-close-modal="admin-corrections-modal"], .modal-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      closeModal('admin-corrections-modal');
    };
  });

  // Action buttons: Approve
  modal.querySelectorAll('.btn-approve-corr').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-id');
      showCorrectionDecisionForm(id, 'approve', btn, modal);
    };
  });

  // Action buttons: Reject
  modal.querySelectorAll('.btn-reject-corr').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-id');
      showCorrectionDecisionForm(id, 'reject', btn, modal);
    };
  });
}

/**
 * Displays an accessible on-page decision form replacing window.prompt
 */
export function showCorrectionDecisionForm(requestId, action, openerBtn, modal) {
  const actionsRow = modal.querySelector(`#corr-actions-${requestId}`);
  const formContainer = modal.querySelector(`#corr-form-container-${requestId}`);
  if (!actionsRow || !formContainer) return;

  actionsRow.style.display = 'none';
  formContainer.style.display = 'block';

  const isApprove = action === 'approve';
  const labelText = isApprove
    ? 'Approval Note <span style="font-weight: 400; color: var(--text-muted);">(optional)</span>'
    : 'Rejection Reason <span style="color: var(--color-danger-text, #ef4444);" aria-hidden="true">*</span>';
  const placeholderText = isApprove
    ? 'Admin approval note (optional)'
    : 'Provide a reason for rejection (required)';
  const defaultVal = isApprove ? 'Approved by admin' : '';
  const confirmBtnText = isApprove ? 'Confirm Approval' : 'Confirm Rejection';
  const confirmBtnClass = isApprove ? 'btn-primary' : 'btn-danger';

  formContainer.innerHTML = `
    <form class="correction-decision-form" data-id="${requestId}" data-action="${action}" novalidate>
      <div class="form-group" style="margin-bottom: var(--space-2);">
        <label for="corr-note-${requestId}" style="display: block; font-size: var(--text-xs); font-weight: 600; margin-bottom: 4px; color: var(--text-main);">
          ${labelText}
        </label>
        <textarea
          id="corr-note-${requestId}"
          name="decision_note"
          class="form-control corr-decision-textarea"
          rows="2"
          style="width: 100%; box-sizing: border-box; font-size: var(--text-sm); font-family: inherit; padding: var(--space-2);"
          placeholder="${placeholderText}"
          ${!isApprove ? 'required aria-required="true"' : ''}
        >${escapeHtml(defaultVal)}</textarea>
        <div id="corr-error-${requestId}" class="corr-decision-error" role="alert" style="display: none; color: var(--color-danger-text, #ef4444); font-size: var(--text-xs); margin-top: 4px; font-weight: 500;"></div>
      </div>
      <div style="display: flex; gap: var(--space-2); justify-content: flex-end; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-ghost btn-sm btn-cancel-corr" data-id="${requestId}">Cancel</button>
        <button type="submit" class="btn ${confirmBtnClass} btn-sm btn-confirm-corr" data-id="${requestId}">
          ${confirmBtnText}
        </button>
      </div>
    </form>
  `;

  const form = formContainer.querySelector('form');
  const textarea = formContainer.querySelector('textarea');
  const cancelBtn = formContainer.querySelector('.btn-cancel-corr');
  const confirmBtn = formContainer.querySelector('.btn-confirm-corr');
  const errorEl = formContainer.querySelector('.corr-decision-error');

  // Focus textarea
  if (textarea && typeof textarea.focus === 'function') {
    textarea.focus();
    if (isApprove && typeof textarea.select === 'function') {
      try { textarea.select(); } catch (_) {}
    }
  }

  const hideForm = () => {
    formContainer.style.display = 'none';
    formContainer.innerHTML = '';
    actionsRow.style.display = 'flex';
    if (openerBtn && typeof openerBtn.focus === 'function') {
      try { openerBtn.focus(); } catch (_) {}
    }
  };

  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      hideForm();
    };
  }

  if (form) {
    // Keyboard Escape cancels decision form without closing parent modal
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
        hideForm();
      }
    });

    const submitHandler = async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();

      const rawVal = textarea ? textarea.value : '';
      const trimmed = (rawVal || '').trim();

      // Validation
      if (!isApprove) {
        if (!trimmed) {
          if (errorEl) {
            errorEl.textContent = 'Rejection reason is required. Please provide a reason.';
            errorEl.style.display = 'block';
          }
          if (textarea) {
            textarea.setAttribute('aria-invalid', 'true');
            if (typeof textarea.focus === 'function') textarea.focus();
          }
          return;
        }
      }

      if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      }
      if (textarea) {
        textarea.removeAttribute('aria-invalid');
      }

      const note = isApprove ? (trimmed || 'Approved by admin') : trimmed;

      // In-flight state: disable buttons & textarea to prevent double submission
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = isApprove ? 'Approving...' : 'Rejecting...';
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (textarea) textarea.disabled = true;

      try {
        await executeAdminDecideCorrection(requestId, action, note, activeSupabaseOverride);
        showToast(isApprove ? 'success' : 'info', isApprove ? 'Score correction approved and applied.' : 'Score correction rejected.');
        await checkPendingCorrectionRequests(activeSupabaseOverride);
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
      } catch (err) {
        showToast('error', err.message);
        if (errorEl) {
          errorEl.textContent = err.message || 'An error occurred while saving.';
          errorEl.style.display = 'block';
        }
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = confirmBtnText;
        }
        if (cancelBtn) cancelBtn.disabled = false;
        if (textarea) {
          textarea.disabled = false;
          // Preserves entered text for retry!
          if (typeof textarea.focus === 'function') textarea.focus();
        }
      }
    };

    form.onsubmit = submitHandler;
    if (confirmBtn) {
      confirmBtn.onclick = submitHandler;
    }
  }
}

export function openAdminCorrectionsModal(requests, openerEl = null) {
  if (!requests || requests.length === 0) {
    closeModal('admin-corrections-modal');
    return;
  }

  let modal = document.getElementById('admin-corrections-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'admin-corrections-modal';
    modal.className = 'modal-backdrop';
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
  }

  // Ensure backdrop click closes modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal('admin-corrections-modal');
    }
  };

  renderAdminCorrectionsModalContent(modal, requests);

  // Set focus to opener prior to openModal so modalFocusHistory records it reliably
  const opener = openerEl || document.getElementById('btn-view-corrections');
  if (opener && typeof opener.focus === 'function' && document.activeElement !== opener) {
    try {
      opener.focus();
    } catch (_) {}
  }

  openModal('admin-corrections-modal');
}

/**
 * Loads categories for filter dropdown
 */
async function loadCategories() {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .order('sort_order', { ascending: true });
      if (!error && data) {
        allCategories = data;
      }
    } catch (err) {
      console.warn('Failed to load categories:', err);
    }
  } else {
    allCategories = DemoDB.getCategories();
  }
  populateCategorySelect();
}

function populateCategorySelect() {
  const sectionVal = document.getElementById('filter-section')?.value || 'all';
  const catSelect = document.getElementById('filter-category');
  if (!catSelect) return;

  let filteredCats = allCategories;
  if (sectionVal !== 'all') {
    filteredCats = allCategories.filter(c => c.section === sectionVal);
  }

  let options = '<option value="all">All Categories</option>';
  filteredCats.forEach(c => {
    options += `<option value="${c.id}">${escapeHtml(c.name)} (${c.section})</option>`;
  });
  catSelect.innerHTML = options;
}

/**
 * Sets up filter inputs and listeners
 */
export function buildReviewCategoryEmbed(section) {
  if (section && section !== 'all') {
    return 'category:categories!results_category_id_fkey!inner(id, name, section, sort_order)';
  }
  return 'category:categories!results_category_id_fkey(id, name, section, sort_order)';
}

export function buildReviewSelectColumns({ section, includeTargetFields = true } = {}) {
  const targetCols = includeTargetFields ? 'min_accuracy, min_questions_per_minute, max_time_seconds, meets_target,' : '';
  const categoryEmbed = buildReviewCategoryEmbed(section);
  return `
    id,
    student_id,
    student_round_id,
    category_id,
    correct,
    total,
    time_seconds,
    note,
    entry_date,
    created_at,
    source,
    practice_mode,
    verified,
    verified_by,
    verified_at,
    corrected_by,
    corrected_at,
    flagged,
    flag_note,
    ${targetCols}
    ${categoryEmbed},
    student:profiles!results_student_id_fkey(id, full_name, student_code, level)
  `;
}

function setupFilterControls() {
  const sectionSelect = document.getElementById('filter-section');
  if (sectionSelect) {
    sectionSelect.addEventListener('change', () => {
      populateCategorySelect();
      currentPage = 1;
    });
  }

  const catSelect = document.getElementById('filter-category');
  if (catSelect) {
    catSelect.addEventListener('change', () => {
      currentPage = 1;
    });
  }

  const statusSelect = document.getElementById('filter-status');
  if (statusSelect) {
    statusSelect.addEventListener('change', () => {
      currentPage = 1;
    });
  }

  const dateFrom = document.getElementById('filter-date-from');
  if (dateFrom) {
    dateFrom.addEventListener('change', () => {
      currentPage = 1;
    });
  }

  const dateTo = document.getElementById('filter-date-to');
  if (dateTo) {
    dateTo.addEventListener('change', () => {
      currentPage = 1;
    });
  }

  const studentInput = document.getElementById('filter-student');
  if (studentInput) {
    studentInput.addEventListener('input', () => {
      currentPage = 1;
    });
  }

  const btnApply = document.getElementById('btn-apply-filters');
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      readActiveFilters();
      currentPage = 1;
      selectedEntryIds.clear();
      updateSelectedUI();
      loadReviewEntries();
    });
  }

  const btnReset = document.getElementById('btn-reset-filters');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      document.getElementById('filter-student').value = '';
      document.getElementById('filter-date-from').value = '';
      document.getElementById('filter-date-to').value = '';
      document.getElementById('filter-section').value = 'all';
      populateCategorySelect();
      document.getElementById('filter-category').value = 'all';
      document.getElementById('filter-status').value = 'unverified';

      readActiveFilters();
      currentPage = 1;
      selectedEntryIds.clear();
      updateSelectedUI();
      loadReviewEntries();
    });
  }

  const btnRefresh = document.getElementById('btn-refresh-reviews');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadReviewEntries();
    });
  }

  // Pagination buttons
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        loadReviewEntries();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      const maxPages = Math.max(1, Math.ceil(totalEntriesCount / PAGE_SIZE));
      if (currentPage < maxPages) {
        currentPage++;
        loadReviewEntries();
      }
    });
  }
}

function readActiveFilters() {
  activeFilters.studentSearch = (document.getElementById('filter-student')?.value || '').trim();
  activeFilters.dateFrom = document.getElementById('filter-date-from')?.value || '';
  activeFilters.dateTo = document.getElementById('filter-date-to')?.value || '';
  activeFilters.section = document.getElementById('filter-section')?.value || 'all';
  activeFilters.categoryId = document.getElementById('filter-category')?.value || 'all';
  activeFilters.status = document.getElementById('filter-status')?.value || 'unverified';
}

/**
 * Fetches and renders entries for current page and active filters
 */
async function loadReviewEntries() {
  const tbody = document.getElementById('review-tbody');
  const countIndicator = document.getElementById('review-count-indicator');
  const paginationInfo = document.getElementById('pagination-info');
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="loading-state" style="padding: var(--space-8); text-align: center;">
          Loading entries (Page ${currentPage})...
        </td>
      </tr>
    `;
  }

  try {
    let entries = [];
    let totalCount = 0;

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      let teacherAssignedIds = null;
      if (currentProfile?.role === 'teacher') {
        const { data: assignments, error: assignErr } = await supabase
          .from('teacher_student_assignments')
          .select('student_id')
          .eq('teacher_id', currentProfile.id);

        if (assignErr) throw assignErr;
        teacherAssignedIds = (assignments || []).map((a) => a.student_id);

        if (teacherAssignedIds.length === 0) {
          allEntries = [];
          totalEntriesCount = 0;
          renderTable();
          updatePaginationUI();
          return;
        }
      }

      const buildReviewQuery = (tableName, includeTargetFields) => {
        const selectCols = buildReviewSelectColumns({
          section: activeFilters.section,
          includeTargetFields,
        });
        let q = supabase
          .from(tableName)
          .select(selectCols, { count: 'exact' });

        if (teacherAssignedIds) {
          q = q.in('student_id', teacherAssignedIds);
        }

        if (activeFilters.dateFrom) {
          q = q.gte('entry_date', activeFilters.dateFrom);
        }
        if (activeFilters.dateTo) {
          q = q.lte('entry_date', activeFilters.dateTo);
        }
        if (activeFilters.categoryId && activeFilters.categoryId !== 'all') {
          q = q.eq('category_id', activeFilters.categoryId);
        }
        if (activeFilters.section && activeFilters.section !== 'all') {
          q = q.eq('category.section', activeFilters.section);
        }

        if (activeFilters.status === 'unverified') {
          q = q.eq('verified', false).is('corrected_at', null);
        } else if (activeFilters.status === 'verified') {
          q = q.eq('verified', true);
        } else if (activeFilters.status === 'flagged') {
          q = q.eq('flagged', true);
        } else if (activeFilters.status === 'corrected') {
          q = q.not('corrected_at', 'is', null);
        }

        q = q.order('created_at', { ascending: false });
        const from = (currentPage - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        return q.range(from, to);
      };

      // Read entries from results_with_target view (fallback to results if view has no FK hints)
      let { data, count, error } = await buildReviewQuery('results_with_target', true);
      if (error) {
        const fallback = await buildReviewQuery('results', false);
        if (fallback.error) throw new Error(fallback.error.message);
        data = fallback.data;
        count = fallback.count;
      }

      entries = data || [];
      totalCount = count || 0;

      // Filter in-memory by student name/code if search query provided
      if (activeFilters.studentSearch) {
        const q = activeFilters.studentSearch.toLowerCase();
        entries = entries.filter(e => {
          const name = (e.student?.full_name || '').toLowerCase();
          const code = (e.student?.student_code || '').toLowerCase();
          const id = (e.student_id || '').toLowerCase();
          return name.includes(q) || code.includes(q) || id === q;
        });
      }

    } else {
      // Demo Mode Fallback
      const res = DemoDB.getReviewEntries({
        page: currentPage,
        pageSize: PAGE_SIZE,
        studentId: activeFilters.studentSearch.startsWith('usr-') ? activeFilters.studentSearch : null,
        search: activeFilters.studentSearch,
        dateFrom: activeFilters.dateFrom,
        dateTo: activeFilters.dateTo,
        section: activeFilters.section,
        categoryId: activeFilters.categoryId,
        status: activeFilters.status
      });
      entries = res.entries;
      totalCount = res.totalCount;
    }

    currentEntriesList = entries;
    totalEntriesCount = totalCount;

    // Update counts & pagination UI
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    if (countIndicator) {
      countIndicator.textContent = `Showing ${entries.length} of ${totalCount} entries (Filter: ${activeFilters.status})`;
    }
    if (paginationInfo) {
      paginationInfo.textContent = `Page ${currentPage} of ${totalPages} (${PAGE_SIZE} per page)`;
    }
    if (btnPrev) btnPrev.disabled = currentPage <= 1;
    if (btnNext) btnNext.disabled = currentPage >= totalPages;

    renderReviewTable(entries);

  } catch (err) {
    console.error('Error loading review entries:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="padding: var(--space-6); text-align: center; color: #DC2626;">
            Failed to load entries: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }
}

/**
 * Renders table rows
 */
function renderReviewTable(entries) {
  const tbody = document.getElementById('review-tbody');
  const thSelectAll = document.getElementById('th-select-all');
  if (!tbody) return;

  if (entries.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state" style="padding: var(--space-12); text-align: center;">
          <div style="font-size: 2rem; margin-bottom: 8px;">✓</div>
          <h3 class="empty-state-title" style="margin-bottom: 4px;">No entries match this filter</h3>
          <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
            Try switching the status filter, widening the date range, or resetting filters.
          </p>
        </td>
      </tr>
    `;
    if (thSelectAll) thSelectAll.checked = false;
    return;
  }

  // Update select all checkbox state
  const allPageSelected = entries.every(e => selectedEntryIds.has(e.id));
  if (thSelectAll) thSelectAll.checked = allPageSelected;

  let html = '';
  entries.forEach(entry => {
    const isSelected = selectedEntryIds.has(entry.id);
    const student = entry.student || { full_name: 'Unknown', student_code: '—', level: '—' };
    const category = entry.category || { name: 'Unknown', section: 'other' };

    const isSite = entry.source === 'site';
    const practiceMode = entry.practice_mode === 'timed' ? 'Timed' : (entry.practice_mode === 'unlimited' ? 'Unlimited' : null);
    const isVerified = entry.verified === true || !!entry.verified_at || !!entry.verified_by;
    const isCorrected = !!entry.corrected_at || !!entry.corrected_by;
    const isFlagged = entry.flagged === true;

    // Score & Wrong calculation
    const correct = entry.correct ?? 0;
    const total = entry.total ?? 0;
    const feedback = getScoreFeedback(correct, total);

    // Formatted time & attempted per minute speed for timed/unlimited practice
    const timeDisplay = entry.time_seconds !== null && entry.time_seconds !== undefined
      ? formatSecondsToTime(entry.time_seconds)
      : '—';
    const attemptedPerMinute = practiceMode && Number(total) > 0 && Number(entry.time_seconds) > 0
      ? `${(Math.round((Number(total) / (Number(entry.time_seconds) / 60)) * 10) / 10).toFixed(1)} / min`
      : null;

    // Round / Task
    const roundLabel = entry.student_round_id
      ? 'Round Entry'
      : (category.section === 'basics' ? 'Basics Sprint' : 'Practice');

    // Date in IST
    const entryDateIST = entry.entry_date ? formatDisplayDateIST(entry.entry_date) : '—';
    const savedTimeIST = entry.created_at ? formatTimestampIST(entry.created_at) : '';

    // Status chips
    let statusChipsHtml = '';
    if (isSite) {
      statusChipsHtml += `<div style="display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;"><span class="status-chip chip-verified" title="Recorded by the site">Recorded by the site</span>${practiceMode ? `<span class="status-chip chip-unverified">${practiceMode}</span>` : ''}</div>`;
    } else {
      statusChipsHtml += `<div style="display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;"><span class="status-chip chip-unverified" title="Typed by student">Typed</span>${practiceMode ? `<span class="status-chip chip-unverified">${practiceMode}</span>` : ''}</div>`;
      if (isVerified) {
        statusChipsHtml += `<span class="status-chip chip-verified" title="Verified by teacher">🔒 Verified</span>`;
      }
    }
    if (isCorrected) {
      statusChipsHtml += `<span class="status-chip chip-corrected" title="Corrected: ${escapeHtml(entry.note || '')}">✏️ Corrected</span>`;
    }
    if (isFlagged) {
      statusChipsHtml += `<span class="status-chip chip-flagged" title="Flag note: ${escapeHtml(entry.flag_note || '')}">⚠️ Flagged</span>`;
    }
    if (!isSite && !isVerified && !isCorrected && !isFlagged) {
      statusChipsHtml += `<span class="status-chip chip-unverified">Unverified</span>`;
    }
    if (entry.meets_target === true) {
      statusChipsHtml += `<span class="badge badge-success" title="Meets target benchmark">🎯 Meets target</span>`;
    } else if (entry.meets_target === false) {
      statusChipsHtml += `<span class="badge badge-warning" title="Below target benchmark">⚠️ Below target</span>`;
    }

    html += `
      <tr class="${isSelected ? 'row-selected' : ''}" style="${isSelected ? 'background-color: var(--bg-surface-subtle);' : ''}">
        <!-- Checkbox -->
        <td style="text-align: center;">
          ${isSite ? `
            <span style="font-size: 11px; color: var(--text-dim);" title="Recorded by the site">—</span>
          ` : `
            <input
              type="checkbox"
              class="row-select-checkbox"
              data-id="${entry.id}"
              ${isSelected ? 'checked' : ''}
              aria-label="Select entry for bulk verify"
            />
          `}
        </td>

        <!-- Student -->
        <td>
          <a href="/pages/student-detail.html?id=${encodeURIComponent(entry.student_id)}" class="student-name-link" title="Open student practice profile">
            ${escapeHtml(student.full_name)}
          </a>
          <div style="font-size: 11px; color: var(--text-dim); display: flex; gap: 4px;">
            <span>${escapeHtml(student.student_code)}</span>
            <span>·</span>
            <span>${escapeHtml(student.level || 'Level —')}</span>
          </div>
        </td>

        <!-- Category & Section -->
        <td>
          <strong style="font-size: var(--text-xs); color: var(--text-main);">${escapeHtml(category.name)}</strong>
          <div style="font-size: 10px; color: var(--text-muted); text-transform: capitalize;">${escapeHtml(category.section)}</div>
        </td>

        <!-- Round / Task -->
        <td>
          <span style="font-size: var(--text-xs); font-weight: 600;">${escapeHtml(roundLabel)}</span>
          ${entry.note ? `<div style="font-size: 10px; color: var(--text-dim);">${escapeHtml(entry.note)}</div>` : ''}
        </td>

        <!-- Score & Wrong -->
        <td>
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-weight: 700; font-size: var(--text-xs);">${correct}/${total}</span>
            <span class="score-tag ${feedback.badgeClass}" style="font-size: 10px; padding: 1px 4px;">
              ${feedback.wrongText}
            </span>
          </div>
        </td>

        <!-- Time -->
        <td>
          <div class="num" style="font-size: var(--text-xs);">${timeDisplay}</div>
          ${attemptedPerMinute ? `<div class="num" style="font-size: 10px; color: var(--text-muted);">${attemptedPerMinute}</div>` : ''}
        </td>

        <!-- Date & Time (IST) -->
        <td>
          <div style="font-size: var(--text-xs); font-weight: 600;">${entryDateIST}</div>
          <div style="font-size: 10px; color: var(--text-dim);">${savedTimeIST}</div>
        </td>

        <!-- Status Chips -->
        <td>
          <div style="display: flex; flex-direction: column; gap: 2px; align-items: flex-start;">
            ${statusChipsHtml}
          </div>
        </td>

        <!-- Actions -->
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 4px; align-items: center;">
            ${isSite ? `
              <span style="font-size: 11px; color: var(--text-dim); padding-right: 4px;" title="Recorded by the site (read-only)">
                Read-only
              </span>
            ` : `
              <!-- Verify / Unverify -->
              <button
                type="button"
                class="btn btn-outline btn-sm btn-action-verify"
                data-id="${entry.id}"
                data-verified="${isVerified ? 'true' : 'false'}"
                style="padding: 2px 6px; font-size: 11px;"
                title="${isVerified ? 'Mark as Unverified' : 'Mark as Verified'}"
              >
                ${isVerified ? 'Unverify' : '✓ Verify'}
              </button>

              <!-- Flag / Unflag -->
              <button
                type="button"
                class="btn btn-outline btn-sm btn-action-flag"
                data-id="${entry.id}"
                data-flagged="${isFlagged ? 'true' : 'false'}"
                data-note="${escapeHtml(entry.flag_note || '')}"
                style="padding: 2px 6px; font-size: 11px;"
                title="${isFlagged ? 'Clear flag' : 'Flag entry for student'}"
              >
                ${isFlagged ? 'Unflag' : '⚑ Flag'}
              </button>

              <!-- Correct -->
              <button
                type="button"
                class="btn btn-outline btn-sm btn-action-correct"
                data-id="${entry.id}"
                data-table="${resolveCorrectionTableName(entry)}"
                data-source="${escapeHtml(entry.source || '')}"
                data-correct="${correct}"
                data-total="${total}"
                data-time="${entry.time_seconds || 0}"
                data-note="${escapeHtml(entry.note || '')}"
                data-student="${escapeHtml(student.full_name)}"
                data-cat="${escapeHtml(category.name)}"
                data-round="${escapeHtml(roundLabel)}"
                style="padding: 2px 6px; font-size: 11px;"
                title="${currentProfile?.role === 'teacher' ? 'Request score correction' : 'Correct score'}"
              >
                ✏️ ${currentProfile?.role === 'teacher' ? 'Request Correction' : 'Correct'}
              </button>
            `}

            <!-- Send Note to Student -->
            <button
              type="button"
              class="btn btn-outline btn-sm btn-action-message"
              data-id="${entry.id}"
              data-student-id="${entry.student_id}"
              data-student-name="${escapeHtml(student.full_name)}"
              data-student-code="${escapeHtml(student.student_code)}"
              data-category-name="${escapeHtml(category.name)}"
              data-correct="${correct}"
              data-total="${total}"
              data-entry-date="${escapeHtml(entryDateIST)}"
              style="padding: 2px 6px; font-size: 11px;"
              title="Send private note to student about this score"
            >
              ✉ Note
            </button>

            <!-- History -->
            <button
              type="button"
              class="btn btn-outline btn-sm btn-action-history"
              data-id="${entry.id}"
              data-meta="${escapeHtml(student.full_name)} — ${escapeHtml(category.name)} (${escapeHtml(roundLabel)})"
              style="padding: 2px 6px; font-size: 11px;"
              title="View change audit history"
            >
              📜
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  attachRowActionListeners();
}

/**
 * Formats a full ISO timestamp into human readable IST format
 */
function formatTimestampIST(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return '';
  }
}

/**
 * Attaches event listeners to rows, actions, and selection checkboxes
 */
function attachRowActionListeners() {
  // Checkboxes
  document.querySelectorAll('.row-select-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) {
        if (selectedEntryIds.size >= 200) {
          e.target.checked = false;
          showToast('error', 'Bulk selection limit reached (maximum 200 entries).');
          return;
        }
        selectedEntryIds.add(id);
      } else {
        selectedEntryIds.delete(id);
      }
      updateSelectedUI();
    });
  });

  // Select all on current page header checkbox
  const thSelectAll = document.getElementById('th-select-all');
  if (thSelectAll) {
    thSelectAll.onchange = (e) => {
      const shouldSelect = e.target.checked;
      currentEntriesList.forEach(item => {
        if (shouldSelect) {
          if (selectedEntryIds.size < 200) {
            selectedEntryIds.add(item.id);
          }
        } else {
          selectedEntryIds.delete(item.id);
        }
      });
      document.querySelectorAll('.row-select-checkbox').forEach(cb => {
        cb.checked = selectedEntryIds.has(cb.getAttribute('data-id'));
      });
      updateSelectedUI();
    };
  }

  // Row Action: Verify / Unverify
  document.querySelectorAll('.btn-action-verify').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const isCurrentlyVerified = btn.getAttribute('data-verified') === 'true';
      const targetState = !isCurrentlyVerified;

      openConfirmModal({
        title: targetState ? 'Verify Practice Entry' : 'Unverify Entry',
        body: targetState
          ? 'Mark this student entry as verified? Verified entries are locked from student edits.'
          : 'Remove verification from this entry? The student will be able to edit it again.',
        defaultReason: targetState ? 'Verified by teacher' : 'Verification revoked by teacher',
        onProceed: async (reason) => {
          await executeSetVerified([id], targetState, reason);
        }
      });
    });
  });

  // Row Action: Flag / Unflag
  document.querySelectorAll('.btn-action-flag').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const isCurrentlyFlagged = btn.getAttribute('data-flagged') === 'true';
      const existingNote = btn.getAttribute('data-note') || '';

      if (isCurrentlyFlagged) {
        // Unflag confirmation
        openConfirmModal({
          title: 'Remove Flag from Entry',
          body: 'Remove the warning flag from this entry? The student will no longer see a review request banner.',
          defaultReason: 'Flag resolved',
          onProceed: async (reason) => {
            await executeSetFlag(id, false, null);
          }
        });
      } else {
        // Open flag note modal
        openFlagModal(id, existingNote);
      }
    });
  });

  // Row Action: Correct
  document.querySelectorAll('.btn-action-correct').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const tableName = btn.getAttribute('data-table') || resolveCorrectionTableName(btn.getAttribute('data-source'));
      const correct = btn.getAttribute('data-correct');
      const total = btn.getAttribute('data-total');
      const timeSec = Number(btn.getAttribute('data-time') || 0);
      const note = btn.getAttribute('data-note') || '';
      const meta = `${btn.getAttribute('data-student')} · ${btn.getAttribute('data-cat')} (${btn.getAttribute('data-round')})`;

      openCorrectModal(id, correct, total, timeSec, note, meta, tableName);
    });
  });

  // Row Action: Send Note to Student
  document.querySelectorAll('.btn-action-message').forEach(btn => {
    btn.addEventListener('click', () => {
      const entryId = btn.getAttribute('data-id');
      const studentId = btn.getAttribute('data-student-id');
      const studentName = btn.getAttribute('data-student-name') || 'Student';
      const studentCode = btn.getAttribute('data-student-code') || '—';
      const categoryName = btn.getAttribute('data-category-name') || 'Practice';
      const correct = btn.getAttribute('data-correct') || '0';
      const total = btn.getAttribute('data-total') || '0';
      const entryDate = btn.getAttribute('data-entry-date') || '—';

      openReviewMessageModal({
        id: entryId,
        studentId,
        studentName,
        studentCode,
        categoryName,
        correct,
        total,
        entryDate
      });
    });
  });

  // Row Action: History Drawer
  document.querySelectorAll('.btn-action-history').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const meta = btn.getAttribute('data-meta') || 'Practice Entry';
      openAuditDrawer(id, meta);
    });
  });
}

/**
 * Bulk verify controls
 */
function setupBulkVerifyControls() {
  const btnSelectPage = document.getElementById('btn-select-all-page');
  const btnClearSelection = document.getElementById('btn-clear-selection');
  const btnBulkCancel = document.getElementById('btn-bulk-cancel');
  const btnBulkVerify = document.getElementById('btn-bulk-verify');

  if (btnSelectPage) {
    btnSelectPage.addEventListener('click', () => {
      currentEntriesList.forEach(e => {
        if (selectedEntryIds.size < 200) selectedEntryIds.add(e.id);
      });
      document.querySelectorAll('.row-select-checkbox').forEach(cb => {
        cb.checked = selectedEntryIds.has(cb.getAttribute('data-id'));
      });
      updateSelectedUI();
    });
  }

  if (btnClearSelection) {
    btnClearSelection.addEventListener('click', () => {
      selectedEntryIds.clear();
      document.querySelectorAll('.row-select-checkbox').forEach(cb => { cb.checked = false; });
      updateSelectedUI();
    });
  }

  if (btnBulkCancel) {
    btnBulkCancel.addEventListener('click', () => {
      selectedEntryIds.clear();
      document.querySelectorAll('.row-select-checkbox').forEach(cb => { cb.checked = false; });
      updateSelectedUI();
    });
  }

  if (btnBulkVerify) {
    btnBulkVerify.addEventListener('click', () => {
      if (selectedEntryIds.size === 0) return;
      const count = selectedEntryIds.size;

      openConfirmModal({
        title: `Bulk Verify ${count} Entries`,
        body: `Are you sure you want to verify all ${count} selected practice entries? They will be permanently stamped as verified and locked from student modification.`,
        defaultReason: `Bulk verified (${count} entries) by teacher`,
        onProceed: async (reason) => {
          const ids = Array.from(selectedEntryIds);
          await executeSetVerified(ids, true, reason);
          selectedEntryIds.clear();
          updateSelectedUI();
        }
      });
    });
  }
}

function updateSelectedUI() {
  const count = selectedEntryIds.size;
  const bulkBar = document.getElementById('bulk-verify-bar');
  const bulkBarCount = document.getElementById('bulk-bar-count');
  const selectedLabel = document.getElementById('selected-count-label');
  const btnClearSelection = document.getElementById('btn-clear-selection');

  if (count > 0) {
    if (bulkBar) bulkBar.style.display = 'flex';
    if (bulkBarCount) bulkBarCount.textContent = `${count} ${count === 1 ? 'entry' : 'entries'} selected`;
    if (selectedLabel) {
      selectedLabel.style.display = 'inline-block';
      selectedLabel.textContent = `${count} selected`;
    }
    if (btnClearSelection) btnClearSelection.style.display = 'inline-block';
  } else {
    if (bulkBar) bulkBar.style.display = 'none';
    if (selectedLabel) selectedLabel.style.display = 'none';
    if (btnClearSelection) btnClearSelection.style.display = 'none';
  }

  const thSelectAll = document.getElementById('th-select-all');
  if (thSelectAll && currentEntriesList.length > 0) {
    thSelectAll.checked = currentEntriesList.every(e => selectedEntryIds.has(e.id));
  }
}

/**
 * Database RPC: admin_set_verified / teacher_verify_scores
 */
export async function executeSetVerified(ids, verified, reason, supabaseOverride = null, profileOverride = null) {
  const profile = profileOverride || currentProfile;
  try {
    if (isSupabaseConfigured() || supabaseOverride) {
      const supabase = supabaseOverride || (await getSupabase());
      if (profile?.role === 'teacher') {
        const { data, error } = await supabase.rpc('teacher_verify_scores', {
          p_ids: ids,
          p_verified: verified,
          p_reason: reason || (verified ? 'Verified by teacher' : 'Unverified by teacher')
        });
        if (error) throw new Error(error.message);
        showToast('success', `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} ${verified ? 'verified' : 'unverified'}.`);
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
        return data;
      } else {
        const { data, error } = await supabase.rpc('admin_set_verified', {
          p_ids: ids,
          p_verified: verified,
          p_reason: reason || (verified ? 'Verified by teacher' : 'Unverified by teacher')
        });
        if (error) throw new Error(error.message);
        showToast('success', `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} ${verified ? 'verified' : 'unverified'}.`);
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
        return data;
      }
    } else {
      DemoDB.adminSetVerified(ids, verified, reason, profile?.id);
      showToast('success', `${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} ${verified ? 'verified' : 'unverified'}.`);
      if (typeof loadReviewEntries === 'function') await loadReviewEntries();
    }
  } catch (err) {
    console.error('Failed to set verified status:', err);
    showToast('error', 'Verification failed: ' + err.message);
    throw err;
  }
}

/**
 * Database RPC: admin_set_flag / teacher_flag_score
 */
export async function executeSetFlag(id, flagged, note, supabaseOverride = null, profileOverride = null) {
  const profile = profileOverride || currentProfile;
  try {
    if (isSupabaseConfigured() || supabaseOverride) {
      const supabase = supabaseOverride || (await getSupabase());
      if (profile?.role === 'teacher') {
        const { data, error } = await supabase.rpc('teacher_flag_score', {
          p_id: id,
          p_flagged: flagged,
          p_note: note
        });
        if (error) throw new Error(error.message);
        showToast('success', flagged ? 'Entry flagged for student review.' : 'Flag cleared.');
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
        return data;
      } else {
        const { data, error } = await supabase.rpc('admin_set_flag', {
          p_id: id,
          p_flagged: flagged,
          p_note: note
        });
        if (error) throw new Error(error.message);
        showToast('success', flagged ? 'Entry flagged for student review.' : 'Flag cleared.');
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
        return data;
      }
    } else {
      DemoDB.adminSetFlag(id, flagged, note, profile?.id);
      showToast('success', flagged ? 'Entry flagged for student review.' : 'Flag cleared.');
      if (typeof loadReviewEntries === 'function') await loadReviewEntries();
    }
  } catch (err) {
    console.error('Failed to update flag:', err);
    showToast('error', 'Flagging failed: ' + err.message);
    throw err;
  }
}

/**
 * Database RPC: admin_correct_result / teacher_request_score_correction
 */
export async function executeCorrectResult(id, correct, total, timeSeconds, note, reason, tableName = null, supabaseOverride = null, profileOverride = null) {
  const profile = profileOverride || currentProfile;
  const resolvedTable = resolveCorrectionTableName(tableName);
  try {
    if (isSupabaseConfigured() || supabaseOverride) {
      const supabase = supabaseOverride || (await getSupabase());
      if (profile?.role === 'teacher') {
        const { data, error } = await supabase.rpc('teacher_request_score_correction', {
          p_result_id: id,
          p_table_name: resolvedTable,
          p_proposed_correct: correct,
          p_proposed_total: total,
          p_proposed_time_seconds: timeSeconds,
          p_reason: reason
        });
        if (error) throw new Error(error.message);
        showToast('success', 'Score correction request submitted for administrator approval.');
        if (typeof loadReviewEntries === 'function') await loadReviewEntries();
        return data;
      }

      const { data, error } = await supabase.rpc('admin_correct_result', {
        p_id: id,
        p_correct: correct,
        p_total: total,
        p_time_seconds: timeSeconds,
        p_note: note || null,
        p_reason: reason
      });
      if (error) throw new Error(error.message);
      showToast('success', 'Score corrected and stamped successfully.');
      if (typeof loadReviewEntries === 'function') await loadReviewEntries();
      return data;
    } else {
      DemoDB.adminCorrectResult(id, correct, total, timeSeconds, note, reason, profile?.id);
      showToast('success', 'Score corrected and stamped successfully.');
      if (typeof loadReviewEntries === 'function') await loadReviewEntries();
    }
  } catch (err) {
    console.error('Correction failed:', err);
    showToast('error', 'Correction failed: ' + err.message);
    throw err;
  }
}

/**
 * Database RPC: admin_decide_score_correction
 */
export async function executeAdminDecideCorrection(requestId, action, decisionNote, supabaseOverride = null) {
  if (action !== 'approve' && action !== 'reject') {
    throw new Error("Invalid action: must be 'approve' or 'reject'.");
  }
  const supabase = supabaseOverride || (await getSupabase());
  const { data, error } = await supabase.rpc('admin_decide_score_correction', {
    p_request_id: requestId,
    p_action: action,
    p_decision_note: decisionNote || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Modal Handling Setup
 */
let confirmCallback = null;

function setupModalHandlers() {
  // Confirm Modal Proceed
  const btnProceedConfirm = document.getElementById('btn-proceed-confirm');
  if (btnProceedConfirm) {
    btnProceedConfirm.onclick = async () => {
      const reasonInput = document.getElementById('confirm-reason-input');
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (confirmCallback) {
        const cb = confirmCallback;
        closeModal('confirm-verify-modal');
        confirmCallback = null;
        await cb(reason);
      }
    };
  }

  // Flag Modal Form
  const flagForm = document.getElementById('flag-form');
  if (flagForm) {
    flagForm.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('flag-entry-id').value;
      const note = document.getElementById('flag-note-input').value.trim();
      closeModal('flag-modal');
      await executeSetFlag(id, true, note);
    };
  }

  // Correct Modal Form
  const correctForm = document.getElementById('correct-form');
  if (correctForm) {
    correctForm.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('correct-entry-id')?.value;
      const tableName = document.getElementById('correct-entry-table')?.value || 'results';
      const correct = Number(document.getElementById('correct-input-correct')?.value);
      const total = Number(document.getElementById('correct-input-total')?.value);
      const timeStr = document.getElementById('correct-input-time')?.value?.trim() || '';
      const note = document.getElementById('correct-input-note')?.value?.trim() || '';
      const reason = document.getElementById('correct-input-reason')?.value?.trim() || '';

      if (reason.length < 3) {
        showToast('error', 'Audit reason must be at least 3 characters.');
        return;
      }

      if (correct > total) {
        showToast('error', 'Correct answers cannot exceed total attempted.');
        return;
      }

      const timeSeconds = parseTimeStringToSeconds(timeStr);

      closeModal('correct-modal');
      await executeCorrectResult(id, correct, total, timeSeconds, note, reason, tableName);
    };
  }

  // Audit Drawer
  const auditDrawer = document.getElementById('audit-drawer-overlay');
  const btnCloseAudit = document.getElementById('btn-close-audit-drawer');
  if (btnCloseAudit && auditDrawer) {
    btnCloseAudit.onclick = () => { auditDrawer.style.display = 'none'; };
    auditDrawer.onclick = (e) => {
      if (e.target === auditDrawer) auditDrawer.style.display = 'none';
    };
  }

  // Review Message Modal
  const needsAttentionCb = document.getElementById('modal-review-msg-needs-attention');
  const attentionReasonWrap = document.getElementById('modal-review-msg-attention-reason-wrap');
  if (needsAttentionCb && attentionReasonWrap) {
    needsAttentionCb.addEventListener('change', () => {
      attentionReasonWrap.style.display = needsAttentionCb.checked ? 'block' : 'none';
    });
  }

  const reviewMsgForm = document.getElementById('form-send-review-message');
  if (reviewMsgForm) {
    reviewMsgForm.onsubmit = async (e) => {
      e.preventDefault();
      if (!activeReviewMessageEntry) return;

      const titleInput = document.getElementById('modal-review-msg-title-input');
      const bodyInput = document.getElementById('modal-review-msg-body-input');
      const attentionReasonInput = document.getElementById('modal-review-msg-attention-reason');
      const submitBtn = document.getElementById('btn-submit-review-message');

      const title = titleInput?.value?.trim() || '';
      const body = bodyInput?.value?.trim() || '';
      const needsAttention = needsAttentionCb?.checked || false;
      const attentionReason = needsAttention ? (attentionReasonInput?.value?.trim() || null) : null;

      if (!title) {
        showToast('error', 'Subject is required.');
        return;
      }
      if (!body) {
        showToast('error', 'Message body is required.');
        return;
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Sending...';
        }

        await sendStudentMessage({
          studentId: activeReviewMessageEntry.studentId,
          title,
          body,
          needsAttention,
          attentionReason,
          linkedType: 'score',
          linkedId: activeReviewMessageEntry.id,
          clientNonce: activeReviewMessageNonce,
        });

        showToast('success', 'Private note sent to student.');
        activeReviewMessageNonce = null;
        closeModal('modal-send-review-message');
        if (needsAttention) {
          await loadReviewEntries();
        }
      } catch (err) {
        console.error('Failed to send review message:', err);
        showToast('error', err.message || 'Failed to send note');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Message';
        }
      }
    };
  }
}

let activeReviewMessageEntry = null;
let activeReviewMessageNonce = null;

function openReviewMessageModal(entry) {
  activeReviewMessageEntry = entry;
  activeReviewMessageNonce = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `nonce-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const studentEl = document.getElementById('modal-review-msg-student');
  const summaryEl = document.getElementById('modal-review-msg-score-summary');
  const titleInput = document.getElementById('modal-review-msg-title-input');
  const bodyInput = document.getElementById('modal-review-msg-body-input');
  const needsAttentionCb = document.getElementById('modal-review-msg-needs-attention');
  const reasonWrap = document.getElementById('modal-review-msg-attention-reason-wrap');
  const reasonInput = document.getElementById('modal-review-msg-attention-reason');

  if (studentEl) studentEl.textContent = `${entry.studentName} (${entry.studentCode})`;
  if (summaryEl) summaryEl.textContent = `${entry.categoryName} · Score: ${entry.correct}/${entry.total} · ${entry.entryDate}`;
  if (titleInput) titleInput.value = `Feedback: ${entry.categoryName}`;
  if (bodyInput) bodyInput.value = '';
  if (needsAttentionCb) needsAttentionCb.checked = false;
  if (reasonWrap) reasonWrap.style.display = 'none';
  if (reasonInput) reasonInput.value = '';

  openModal('modal-send-review-message');
}

function openConfirmModal({ title, body, defaultReason, onProceed }) {
  const titleEl = document.getElementById('confirm-modal-title');
  const bodyEl = document.getElementById('confirm-modal-body');
  const reasonInput = document.getElementById('confirm-reason-input');

  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = body;
  if (reasonInput) reasonInput.value = defaultReason || '';
  confirmCallback = onProceed;

  openModal('confirm-verify-modal');
}

function openFlagModal(id, existingNote) {
  document.getElementById('flag-entry-id').value = id;
  document.getElementById('flag-note-input').value = existingNote || '';
  openModal('flag-modal');
}

export function openCorrectModal(id, correct, total, timeSeconds, note, meta, tableName = 'results') {
  const idEl = document.getElementById('correct-entry-id');
  if (idEl) idEl.value = id;

  const tableEl = document.getElementById('correct-entry-table');
  if (tableEl) tableEl.value = resolveCorrectionTableName(tableName);

  const metaEl = document.getElementById('correct-entry-meta');
  if (metaEl) metaEl.textContent = meta;

  const correctEl = document.getElementById('correct-input-correct');
  if (correctEl) correctEl.value = correct;

  const totalEl = document.getElementById('correct-input-total');
  if (totalEl) totalEl.value = total;

  const timeEl = document.getElementById('correct-input-time');
  if (timeEl) timeEl.value = formatSecondsToTime(timeSeconds);

  const noteEl = document.getElementById('correct-input-note');
  if (noteEl) noteEl.value = note || '';

  const reasonEl = document.getElementById('correct-input-reason');
  if (reasonEl) reasonEl.value = '';

  const noteGroup = noteEl?.closest('.form-group') || document.getElementById('correct-note-group');
  if (noteGroup) {
    noteGroup.style.display = currentProfile?.role === 'teacher' ? 'none' : 'block';
  }

  const titleEl = document.querySelector('#correct-modal .modal-title');
  const subtitleEl = document.querySelector('#correct-modal .modal-subtitle');
  const submitBtn = document.getElementById('btn-submit-correct');

  if (currentProfile?.role === 'teacher') {
    if (titleEl) titleEl.textContent = 'Request Score Correction';
    if (subtitleEl) subtitleEl.textContent = 'Submit score correction request for administrator approval.';
    if (submitBtn) submitBtn.textContent = 'Submit Correction Request';
  } else {
    if (titleEl) titleEl.textContent = 'Correct & Stamp Score';
    if (subtitleEl) subtitleEl.textContent = 'Admin correction stamps corrected_by and locks the row from student edits.';
    if (submitBtn) submitBtn.textContent = 'Apply Correction';
  }

  openModal('correct-modal');
}

/**
 * Loads and displays the Audit Trail Drawer for an entry
 */
async function openAuditDrawer(resultId, meta) {
  const drawer = document.getElementById('audit-drawer-overlay');
  const subtitle = document.getElementById('audit-drawer-subtitle');
  const container = document.getElementById('audit-timeline-container');

  if (drawer) drawer.style.display = 'flex';
  if (subtitle) subtitle.textContent = meta;
  if (container) container.innerHTML = '<div class="loading-state">Loading audit history...</div>';

  try {
    let audits = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('result_audit')
        .select(`
          id,
          action,
          changed_at,
          reason,
          old_values,
          new_values,
          changer:profiles!result_audit_changed_by_fkey(full_name, student_code)
        `)
        .eq('result_id', resultId)
        .order('changed_at', { ascending: false });

      if (error) throw new Error(error.message);
      audits = (data || []).map(a => ({
        ...a,
        changed_by_name: a.changer?.full_name || 'Teacher'
      }));
    } else {
      audits = DemoDB.getAuditHistory(resultId);
    }

    if (audits.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: var(--space-8); text-align: center;">
          <div style="font-size: 1.5rem; margin-bottom: 4px;">📜</div>
          <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: 2px;">No Audit Events</h4>
          <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
            This entry has not yet been verified, flagged, or corrected by an administrator.
          </p>
        </div>
      `;
      return;
    }

    let html = '';
    audits.forEach(item => {
      const timeIST = item.changed_at ? formatDisplayDateIST(item.changed_at.split('T')[0]) + ' ' + formatTimestampIST(item.changed_at) : '—';
      const actionBadge = formatActionBadge(item.action);

      html += `
        <div class="audit-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              ${actionBadge}
              <strong style="font-size: var(--text-xs); color: var(--text-main);">${escapeHtml(item.changed_by_name || 'Admin')}</strong>
            </div>
            <span style="font-size: 10px; color: var(--text-muted);">${timeIST}</span>
          </div>

          ${item.reason ? `
            <div style="font-size: var(--text-xs); background: var(--bg-surface-subtle); padding: 4px 8px; border-radius: 4px; border-left: 3px solid var(--color-primary); margin-bottom: 6px;">
              <strong>Reason:</strong> ${escapeHtml(item.reason)}
            </div>
          ` : ''}

          ${renderAuditDiff(item.old_values, item.new_values)}
        </div>
      `;
    });

    container.innerHTML = html;

  } catch (err) {
    console.error('Failed to load audit history:', err);
    if (container) {
      container.innerHTML = `
        <div style="color: #DC2626; font-size: var(--text-xs); padding: var(--space-4);">
          Failed to load audit history: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

function formatActionBadge(action) {
  const act = (action || '').toLowerCase();
  if (act === 'verify') return `<span class="status-chip chip-verified">Verify</span>`;
  if (act === 'unverify') return `<span class="status-chip chip-unverified">Unverify</span>`;
  if (act === 'flag') return `<span class="status-chip chip-flagged">Flag</span>`;
  if (act === 'unflag') return `<span class="status-chip chip-unverified">Unflag</span>`;
  if (act === 'correct') return `<span class="status-chip chip-corrected">Correct</span>`;
  return `<span class="status-chip chip-unverified">${escapeHtml(action)}</span>`;
}

function renderAuditDiff(oldVals, newVals) {
  if (!oldVals && !newVals) return '';
  const o = oldVals || {};
  const n = newVals || {};

  const allKeys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)])).filter(k => !['student_id', 'result_id', 'id'].includes(k));
  if (allKeys.length === 0) return '';

  let rows = '';
  allKeys.forEach(k => {
    const oldV = o[k] !== undefined ? JSON.stringify(o[k]) : '—';
    const newV = n[k] !== undefined ? JSON.stringify(n[k]) : '—';
    rows += `
      <tr>
        <td style="color: var(--text-muted); font-weight: 600;">${escapeHtml(k)}</td>
        <td style="color: #EF4444; background: rgba(239, 68, 68, 0.05);">${escapeHtml(oldV)}</td>
        <td style="color: #10B981; background: rgba(16, 185, 129, 0.05);">${escapeHtml(newV)}</td>
      </tr>
    `;
  });

  return `
    <table class="audit-diff-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Previous</th>
          <th>New</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

/**
 * Converts mm:ss or seconds string to number of seconds
 */
function parseTimeStringToSeconds(str) {
  if (!str) return 0;
  if (str.includes(':')) {
    const parts = str.split(':');
    const mins = parseInt(parts[0], 10) || 0;
    const secs = parseInt(parts[1], 10) || 0;
    return mins * 60 + secs;
  }
  return parseInt(str, 10) || 0;
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const btnLogout = document.getElementById('btn-header-logout');

  if (container) container.style.display = 'inline-flex';
  const roleLabel = profile.role === 'admin' ? 'Admin' : (profile.role === 'teacher' ? 'Teacher' : 'Staff');
  if (nameEl) nameEl.textContent = profile.full_name || profile.name || roleLabel;
  if (roleEl) roleEl.textContent = roleLabel;

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      const { logoutUser } = await import('./auth.js');
      await logoutUser();
    });
  }
}

function renderDemoBanner() {
  const bannerPlaceholder = document.getElementById('demo-banner-placeholder');
  if (!bannerPlaceholder) return;
  bannerPlaceholder.innerHTML = `
    <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; color: #92400E; padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-xs); margin-bottom: var(--space-4); display: flex; align-items: center; justify-content: space-between;">
      <div>
        <strong>Demo Mode (Local Preview):</strong> Reviewing interactive mock student records. Connect Supabase to run live audits.
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initReviewPage);
}
