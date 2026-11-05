/**
 * Trendz Tracker - Admin Per-Student Rounds Management Module (js/rounds.js)
 *
 * Phase 4c-0 / Phase 14b Architecture:
 * - Rounds belong to each student (`student_rounds`) and a simulator series (`round_series`).
 * - Admin selects a student and optional series filter ("All Series", "New simulator", "Old simulator").
 * - Table displays: Series, Round Number, Round Date, Round Type, Time Taken, Scores Recorded, Actions.
 * - Admin can create a round for the selected student in a chosen series, edit date/type/time_taken_seconds,
 *   and delete a round ONLY when it has 0 recorded results.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupAdminNav, setupModalListeners } from './modal.js';
import { formatDisplayDateIST, getISTDateString } from './stats.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS, parseTimeToSeconds } from './timeUtils.js';
import { showToast } from './toast.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';
import {
  formatJmcwcGroupLabel,
  formatActiveDurationMs,
  formatDurationSeconds,
  buildSubmittedReviewViewModel,
} from './jmcwcClient.js';

let allStudents = [];
let allSeries = [];
let selectedStudentId = '';
let selectedSeriesFilter = 'all';
let todayIST = '';
let studentRoundsList = []; // enriched with series and scores_count
let saveAndAddAnotherRoundMode = false;
let currentEditSeriesName = '';
let currentEditRoundNumber = '';

// Phase 17c Admin JMCWC state
let adminJmcwcAssignments = [];
let adminJmcwcCategories = [];
let adminJmcwcTargets = [];
let adminJmcwcPapers = [];
let adminLegacyRoundCategories = [];
let adminJmcwcAttempts = [];

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function clearCreateRoundErrors() {
  ['create-round-error', 'error-new-round-number', 'error-new-round-date', 'error-new-round-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.style.display = 'none';
    }
  });
}

function clearEditRoundErrors() {
  ['edit-round-error', 'error-edit-round-date', 'error-edit-round-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.style.display = 'none';
    }
  });
}

function updateCreateRoundLiveSummary() {
  const summaryEl = document.getElementById('create-round-live-summary');
  if (!summaryEl) return;

  const seriesSelect = document.getElementById('new-round-series');
  const seriesObj = allSeries.find(s => s.id === seriesSelect?.value);
  const seriesName = seriesObj ? seriesObj.name : '';
  const roundNum = document.getElementById('new-round-number')?.value || '';
  const roundDate = document.getElementById('new-round-date')?.value || '';
  const roundType = document.getElementById('new-round-type')?.value || 'Category wise';
  const roundTime = document.getElementById('new-round-time')?.value || '';

  summaryEl.textContent = buildModalLiveSummary('round', {
    series_name: seriesName,
    round_number: roundNum,
    round_date: roundDate,
    round_type: roundType,
    time_taken: roundTime
  });
}

function updateEditRoundLiveSummary() {
  const summaryEl = document.getElementById('edit-round-live-summary');
  if (!summaryEl) return;

  const roundDate = document.getElementById('edit-round-date')?.value || '';
  const roundType = document.getElementById('edit-round-type')?.value || 'Category wise';
  const roundTime = document.getElementById('edit-round-time')?.value || '';

  summaryEl.textContent = buildModalLiveSummary('round', {
    series_name: currentEditSeriesName,
    round_number: currentEditRoundNumber,
    round_date: roundDate,
    round_type: roundType,
    time_taken: roundTime
  });
}

/**
 * Load students, round_series, and today_ist()
 */
async function loadInitialMetadata() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const [todayRes, studentsRes, seriesRes] = await Promise.all([
      supabase.rpc('today_ist'),
      supabase
        .from('profiles')
        .select('id, student_code, full_name, level, active')
        .eq('role', 'student')
        .order('full_name', { ascending: true }),
      supabase
        .from('round_series')
        .select('*')
        .order('sort_order', { ascending: true })
    ]);

    todayIST = !todayRes.error && todayRes.data
      ? getISTDateString(String(todayRes.data).trim())
      : getISTDateString(new Date());

    if (studentsRes.error) throw new Error(studentsRes.error.message);
    if (seriesRes.error) throw new Error(seriesRes.error.message);

    allStudents = studentsRes.data || [];
    allSeries = seriesRes.data || [];
  } else {
    todayIST = await DemoDB.mockTodayIST();
    allStudents = DemoDB.getStudents().sort((a, b) =>
      String(a.full_name || '').localeCompare(String(b.full_name || ''))
    );
    allSeries = DemoDB.getRoundSeries();
  }

  populateSeriesSelects();
  populateStudentSelect('');
}

function populateSeriesSelects() {
  const filterSelect = document.getElementById('select-series-filter');
  const modalSelect = document.getElementById('new-round-series');

  if (filterSelect) {
    let html = '<option value="all">All Series</option>';
    allSeries.forEach(s => {
      const label = s.is_current ? `${s.name} (Current)` : s.name;
      html += `<option value="${escapeHtml(s.id)}">${escapeHtml(label)}</option>`;
    });
    filterSelect.innerHTML = html;
    filterSelect.value = selectedSeriesFilter;
  }

  if (modalSelect) {
    let html = '';
    const current = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1];
    allSeries.forEach(s => {
      const label = s.is_current ? `${s.name} (Current)` : s.name;
      html += `<option value="${escapeHtml(s.id)}">${escapeHtml(label)}</option>`;
    });
    modalSelect.innerHTML = html;
    if (current) modalSelect.value = current.id;
  }
}

function populateStudentSelect(searchQuery = '') {
  const studentSelect = document.getElementById('select-student-rounds');
  if (!studentSelect) return;

  const q = searchQuery.trim().toLowerCase();
  const filtered = allStudents.filter(s => {
    if (!q) return true;
    const name = String(s.full_name || '').toLowerCase();
    const code = String(s.student_code || '').toLowerCase();
    return name.includes(q) || code.includes(q);
  });

  if (filtered.length === 0) {
    studentSelect.innerHTML = '<option value="">No matching students</option>';
    selectedStudentId = '';
    return;
  }

  studentSelect.innerHTML = filtered.map(s => {
    const inactiveTag = s.active === false ? ' [Inactive]' : '';
    return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name)} (${escapeHtml(s.student_code)})${inactiveTag}</option>`;
  }).join('');

  if (!selectedStudentId || !filtered.some(s => s.id === selectedStudentId)) {
    selectedStudentId = filtered[0].id;
  }
  studentSelect.value = selectedStudentId;
}

/**
 * Load student_rounds and score counts for the selected student and series filter
 */
async function loadRounds() {
  const tbody = document.getElementById('rounds-table-body');
  const emptyState = document.getElementById('rounds-empty-state');
  const studentLabelEl = document.getElementById('stat-selected-student');
  const totalRoundsEl = document.getElementById('stat-total-rounds');
  const latestRoundEl = document.getElementById('stat-latest-round');

  const studentObj = allStudents.find(s => s.id === selectedStudentId);
  if (studentLabelEl) {
    studentLabelEl.textContent = studentObj
      ? `${studentObj.full_name} (${studentObj.student_code})`
      : 'None selected';
  }

  if (!selectedStudentId) {
    if (tbody) tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'flex';
    if (totalRoundsEl) totalRoundsEl.textContent = '0';
    if (latestRoundEl) latestRoundEl.textContent = '—';
    return;
  }

  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton-row"></div></td></tr>';
  }

  try {
    const seriesMap = new Map(allSeries.map(s => [s.id, s]));

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      let q = supabase
        .from('student_rounds')
        .select('*')
        .eq('student_id', selectedStudentId)
        .order('round_number', { ascending: false });

      if (selectedSeriesFilter && selectedSeriesFilter !== 'all') {
        q = q.eq('series_id', selectedSeriesFilter);
      }

      const { data: rounds, error: roundsErr } = await q;
      if (roundsErr) throw new Error(roundsErr.message);

      const roundIds = (rounds || []).map(r => r.id);
      const countMap = new Map();

      if (roundIds.length > 0) {
        const { data: resultsData, error: resErr } = await supabase
          .from('results')
          .select('student_round_id')
          .in('student_round_id', roundIds);

        if (!resErr && Array.isArray(resultsData)) {
          resultsData.forEach(row => {
            const c = countMap.get(row.student_round_id) || 0;
            countMap.set(row.student_round_id, c + 1);
          });
        }
      }

      studentRoundsList = (rounds || []).map(r => ({
        ...r,
        series: seriesMap.get(r.series_id) || null,
        scores_count: countMap.get(r.id) || 0
      })).sort((a, b) => {
        if (a.series_id !== b.series_id) {
          const ordA = a.series?.sort_order ?? 0;
          const ordB = b.series?.sort_order ?? 0;
          if (ordA !== ordB) return ordB - ordA;
        }
        return (b.round_number || 0) - (a.round_number || 0);
      });
    } else {
      studentRoundsList = DemoDB.getStudentRounds(selectedStudentId, selectedSeriesFilter);
    }

    if (totalRoundsEl) totalRoundsEl.textContent = String(studentRoundsList.length);

    const currentSeries = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1];
    const currentSeriesRounds = currentSeries
      ? studentRoundsList.filter(r => r.series_id === currentSeries.id)
      : studentRoundsList;

    if (latestRoundEl) {
      latestRoundEl.textContent = currentSeriesRounds.length > 0
        ? `Round ${currentSeriesRounds[0].round_number}`
        : 'None';
    }

    renderRoundsTable();
  } catch (err) {
    console.error('Error loading student rounds:', err);
    showToast('error', 'Failed to load rounds: ' + err.message);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--color-danger-text); padding: var(--space-6);">
            <div style="margin-bottom: var(--space-3); font-weight: 500;">Failed to load rounds: ${escapeHtml(err.message)}</div>
            <button type="button" id="btn-retry-load-rounds" class="btn btn-outline btn-sm">
              Try Again
            </button>
          </td>
        </tr>
      `;
      document.getElementById('btn-retry-load-rounds')?.addEventListener('click', loadRounds);
    }
  }
}

/**
 * Render the student rounds table
 */
function renderRoundsTable() {
  const tbody = document.getElementById('rounds-table-body');
  const emptyState = document.getElementById('rounds-empty-state');

  if (studentRoundsList.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  tbody.innerHTML = studentRoundsList.map(r => {
    const count = r.scores_count || 0;
    const hasResults = count > 0;
    const seriesName = r.series ? r.series.name : 'Series';
    const timeFormatted = r.time_taken_seconds !== null && r.time_taken_seconds !== undefined
      ? formatSecondsToMMSS(r.time_taken_seconds)
      : '—';

    return `
      <tr>
        <td>
          <span class="badge badge-neutral">
            ${escapeHtml(seriesName)}
          </span>
        </td>
        <td class="num" style="font-weight: 700; color: var(--text-main);">
          Round ${r.round_number}
        </td>
        <td class="num" style="color: var(--text-muted);">
          ${formatDisplayDateIST(r.round_date)}
        </td>
        <td>
          <span class="badge badge-neutral">
            ${escapeHtml(r.round_type || 'Category wise')}
          </span>
        </td>
        <td class="num" style="color: var(--text-muted);">
          ${escapeHtml(timeFormatted)}
        </td>
        <td class="num">
          ${hasResults ? `
            <span style="font-weight: 600; color: var(--text-main);">
              ${count} ${count === 1 ? 'score' : 'scores'}
            </span>
          ` : `
            <span style="color: var(--text-dim);">0 scores</span>
          `}
        </td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: var(--space-2);">
            <button
              type="button"
              class="btn btn-outline btn-sm btn-edit-round"
              data-id="${escapeHtml(r.id)}"
              data-series-name="${escapeHtml(seriesName)}"
              data-number="${r.round_number}"
              data-date="${escapeHtml(r.round_date)}"
              data-type="${escapeHtml(r.round_type || 'Category wise')}"
              data-time="${r.time_taken_seconds !== null && r.time_taken_seconds !== undefined ? formatSecondsToMMSS(r.time_taken_seconds) : ''}"
              title="Edit round date, type, and time taken"
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-delete-round"
              data-id="${escapeHtml(r.id)}"
              data-series-name="${escapeHtml(seriesName)}"
              data-number="${r.round_number}"
              data-has-results="${hasResults}"
              ${hasResults ? 'disabled title="Cannot delete round with recorded results"' : 'title="Delete empty round"'}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  attachRoundActionListeners();
}

/**
 * Attach button listeners for edit and delete
 */
function attachRoundActionListeners() {
  // Edit round
  document.querySelectorAll('.btn-edit-round').forEach(btn => {
    btn.addEventListener('click', () => {
      const roundId = btn.getAttribute('data-id');
      const seriesName = btn.getAttribute('data-series-name');
      const roundNumber = btn.getAttribute('data-number');
      const roundDate = btn.getAttribute('data-date');
      const roundType = btn.getAttribute('data-type');
      const roundTime = btn.getAttribute('data-time') || '';

      currentEditSeriesName = seriesName || '';
      currentEditRoundNumber = roundNumber || '';

      document.getElementById('edit-round-id-hidden').value = roundId;
      document.getElementById('edit-round-display-label').textContent = `${seriesName} · Round ${roundNumber}`;
      document.getElementById('edit-round-date').value = roundDate;
      document.getElementById('edit-round-type').value = roundType;
      document.getElementById('edit-round-time').value = roundTime;
      clearEditRoundErrors();

      const editMoreOptions = document.getElementById('edit-round-more-options');
      setMoreOptionsOpen(editMoreOptions, shouldOpenMoreOptions([roundTime], true));
      updateEditRoundLiveSummary();

      openModal('edit-round-modal');
    });
  });

  // Delete round
  document.querySelectorAll('.btn-delete-round').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hasResults = btn.getAttribute('data-has-results') === 'true';
      const roundId = btn.getAttribute('data-id');
      const seriesName = btn.getAttribute('data-series-name');
      const roundNumber = btn.getAttribute('data-number');

      if (hasResults) {
        showToast('error', 'Cannot delete a round that already has recorded results.');
        return;
      }

      if (!confirm(`Are you sure you want to delete empty ${seriesName} Round ${roundNumber}?`)) return;

      btn.disabled = true;
      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('student_rounds')
            .delete()
            .eq('id', roundId);

          if (error) throw new Error(error.message);
        } else {
          DemoDB.deleteStudentRoundAdmin(roundId);
        }

        showToast('success', `${seriesName} Round ${roundNumber} deleted.`);
        await loadRounds();
      } catch (err) {
        showToast('error', 'Failed to delete round: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function getNextRoundNumberForSeries(seriesId) {
  const inSeries = studentRoundsList.filter(r => r.series_id === seriesId);
  const highest = inSeries.reduce((max, r) => Math.max(max, Number(r.round_number) || 0), 0);
  return highest + 1;
}

function prepareCreateModalFields(autoProposeNext = true) {
  const studentObj = allStudents.find(s => s.id === selectedStudentId);
  const studentLabel = document.getElementById('create-round-student-label');
  if (studentLabel && studentObj) {
    studentLabel.textContent = `${studentObj.full_name} (${studentObj.student_code})`;
  }

  const form = document.getElementById('create-round-form');
  if (form) form.reset();

  const currentSeries = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1];
  const targetSeriesId = (selectedSeriesFilter && selectedSeriesFilter !== 'all')
    ? selectedSeriesFilter
    : (currentSeries ? currentSeries.id : '');

  const seriesSelect = document.getElementById('new-round-series');
  if (seriesSelect && targetSeriesId) {
    seriesSelect.value = targetSeriesId;
  }

  const numInput = document.getElementById('new-round-number');
  if (numInput) {
    numInput.value = autoProposeNext && targetSeriesId ? String(getNextRoundNumberForSeries(targetSeriesId)) : '';
  }

  document.getElementById('new-round-date').value = todayIST || getISTDateString(new Date());
  document.getElementById('new-round-type').value = 'Category wise';
  document.getElementById('new-round-time').value = '';
  clearCreateRoundErrors();

  const createMoreOptions = document.getElementById('create-round-more-options');
  setMoreOptionsOpen(createMoreOptions, false);
  updateCreateRoundLiveSummary();
}

function openCreateModal(autoProposeNext = true) {
  if (!selectedStudentId) {
    showToast('info', 'Please select a student first.');
    return;
  }

  prepareCreateModalFields(autoProposeNext);
  openModal('create-round-modal');
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder || !isDemoMode()) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Managing per-student rounds in local demo storage.
      </div>
    </div>
  `;
}

/**
 * Initialize Admin Rounds Page
 */
async function initRounds() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  if (pillContainer) pillContainer.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });

  setupModalListeners();
  setupAdminNav(profile);
  renderDemoBanner();

  await loadInitialMetadata();

  // Filter listeners
  const searchInput = document.getElementById('filter-student-search');
  searchInput?.addEventListener('input', () => {
    populateStudentSelect(searchInput.value);
    loadRounds();
    syncSelectedStudentJmcwcAdminUI();
  });

  const studentSelect = document.getElementById('select-student-rounds');
  studentSelect?.addEventListener('change', () => {
    selectedStudentId = studentSelect.value;
    loadRounds();
    syncSelectedStudentJmcwcAdminUI();
  });

  const seriesFilterSelect = document.getElementById('select-series-filter');
  seriesFilterSelect?.addEventListener('change', () => {
    selectedSeriesFilter = seriesFilterSelect.value;
    loadRounds();
  });

  // Update proposed round number when series changes in Create modal
  const modalSeriesSelect = document.getElementById('new-round-series');
  modalSeriesSelect?.addEventListener('change', () => {
    const numInput = document.getElementById('new-round-number');
    if (numInput) {
      numInput.value = String(getNextRoundNumberForSeries(modalSeriesSelect.value));
    }
    updateCreateRoundLiveSummary();
  });

  // Live summary listeners for Create & Edit modals
  ['new-round-number', 'new-round-date', 'new-round-type', 'new-round-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateCreateRoundLiveSummary);
      el.addEventListener('change', updateCreateRoundLiveSummary);
    }
  });

  ['edit-round-date', 'edit-round-type', 'edit-round-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateEditRoundLiveSummary);
      el.addEventListener('change', updateEditRoundLiveSummary);
    }
  });

  // "Quick Next Round" button
  document.getElementById('btn-quick-next-round')?.addEventListener('click', () => {
    openCreateModal(true);
  });

  // "Custom Round" button
  document.getElementById('btn-open-create-round')?.addEventListener('click', () => {
    openCreateModal(false);
  });

  // "Save and add another" button
  const btnSaveAnotherRound = document.getElementById('btn-save-add-another-round');
  const createRoundForm = document.getElementById('create-round-form');
  if (btnSaveAnotherRound && createRoundForm) {
    btnSaveAnotherRound.addEventListener('click', () => {
      saveAndAddAnotherRoundMode = true;
      createRoundForm.requestSubmit();
    });
  }

  // Create Round submit
  createRoundForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const keepOpen = saveAndAddAnotherRoundMode;
    saveAndAddAnotherRoundMode = false;

    clearCreateRoundErrors();

    const errorEl = document.getElementById('create-round-error');
    const errNum = document.getElementById('error-new-round-number');
    const errDate = document.getElementById('error-new-round-date');
    const errTime = document.getElementById('error-new-round-time');
    const submitBtn = document.getElementById('btn-submit-create-round');
    const btnText = document.getElementById('btn-create-round-text');

    const series_id = document.getElementById('new-round-series').value;
    const round_number = parseInt(document.getElementById('new-round-number').value, 10);
    const round_date = document.getElementById('new-round-date').value;
    const round_type = document.getElementById('new-round-type').value.trim();
    const timeRaw = document.getElementById('new-round-time').value.trim();

    if (!selectedStudentId) {
      errorEl.textContent = 'Please select a student.';
      errorEl.style.display = 'block';
      return;
    }
    if (!series_id) {
      errorEl.textContent = 'Please select a simulator series.';
      errorEl.style.display = 'block';
      return;
    }

    let hasFieldError = false;
    if (isNaN(round_number) || round_number < 1) {
      if (errNum) {
        errNum.textContent = 'Please enter a valid round number (>= 1).';
        errNum.style.display = 'block';
      }
      hasFieldError = true;
    }
    if (!round_date) {
      if (errDate) {
        errDate.textContent = 'Please select a round date.';
        errDate.style.display = 'block';
      }
      hasFieldError = true;
    }

    let time_taken_seconds = null;
    if (timeRaw !== '') {
      time_taken_seconds = parseTimeToSeconds(timeRaw);
      if (time_taken_seconds === null) {
        if (errTime) {
          errTime.textContent = 'Time Taken must be in h:mm:ss, mm:ss, or seconds format.';
          errTime.style.display = 'block';
        }
        setMoreOptionsOpen(document.getElementById('create-round-more-options'), true);
        hasFieldError = true;
      }
    }

    if (hasFieldError) {
      errorEl.textContent = 'Please fix the highlighted errors before saving.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    if (btnSaveAnotherRound) btnSaveAnotherRound.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Creating...';

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { error } = await supabase
          .from('student_rounds')
          .insert([{
            student_id: selectedStudentId,
            series_id,
            round_number,
            round_date,
            round_type,
            time_taken_seconds
          }]);

        if (error) {
          if (error.message.includes('unique') || error.code === '23505') {
            throw new Error(`Round ${round_number} already exists for this student in the selected series.`);
          }
          throw new Error(error.message);
        }
      } else {
        DemoDB.createStudentRoundAdmin({
          student_id: selectedStudentId,
          series_id,
          round_number,
          round_date,
          round_type,
          time_taken_seconds
        });
      }

      showToast('success', `Round ${round_number} created successfully.`);
      await loadRounds();

      if (keepOpen) {
        prepareCreateModalFields(true);
        document.getElementById('new-round-number')?.focus();
      } else {
        closeModal('create-round-modal');
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create round.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      if (btnSaveAnotherRound) btnSaveAnotherRound.disabled = false;
      btnText.textContent = 'Create Round';
    }
  });

  // Edit Round submit
  document.getElementById('edit-round-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearEditRoundErrors();

    const errorEl = document.getElementById('edit-round-error');
    const errDate = document.getElementById('error-edit-round-date');
    const errTime = document.getElementById('error-edit-round-time');
    const submitBtn = document.getElementById('btn-submit-edit-round');
    const btnText = document.getElementById('btn-edit-round-text');

    const roundId = document.getElementById('edit-round-id-hidden').value;
    const round_date = document.getElementById('edit-round-date').value;
    const round_type = document.getElementById('edit-round-type').value.trim();
    const timeRaw = document.getElementById('edit-round-time').value.trim();

    let hasFieldError = false;
    if (!round_date) {
      if (errDate) {
        errDate.textContent = 'Please enter a round date.';
        errDate.style.display = 'block';
      }
      hasFieldError = true;
    }

    let time_taken_seconds = null;
    if (timeRaw !== '') {
      time_taken_seconds = parseTimeToSeconds(timeRaw);
      if (time_taken_seconds === null) {
        if (errTime) {
          errTime.textContent = 'Time Taken must be in h:mm:ss, mm:ss, or seconds format.';
          errTime.style.display = 'block';
        }
        setMoreOptionsOpen(document.getElementById('edit-round-more-options'), true);
        hasFieldError = true;
      }
    }

    if (hasFieldError) {
      errorEl.textContent = 'Please fix the highlighted errors before saving.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { error } = await supabase
          .from('student_rounds')
          .update({ round_date, round_type, time_taken_seconds })
          .eq('id', roundId);

        if (error) throw new Error(error.message);
      } else {
        DemoDB.updateStudentRound(roundId, { round_date, round_type, time_taken_seconds });
      }

      showToast('success', 'Round updated successfully.');
      closeModal('edit-round-modal');
      await loadRounds();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to update round.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Save Changes';
    }
  });

  // Initial load
  await loadRounds();
  setupAdminJmcwcListeners();
  await loadAdminJmcwcOverview();
}

// ============================================================================
// Phase 17c — Admin JMCWC Online Simulator Management
// ============================================================================

async function callAdminJmcwcApi(payload) {
  if (!isSupabaseConfigured()) {
    throw new Error('Live Supabase configuration is required for JMCWC administration.');
  }
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  if (!token) {
    throw new Error('Admin session expired. Please sign in again.');
  }

  const response = await fetch('/api/jmcwc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const err = new Error(body?.error?.message || `Admin JMCWC request failed (${response.status})`);
    err.status = response.status;
    err.code = body?.error?.code || 'ADMIN_JMCWC_ERROR';
    throw err;
  }
  return body;
}

export function formatFriendlyAssignmentError(err) {
  const msg = String(err?.message || err || '').trim();
  if (
    msg.toLowerCase().includes('unfinished simulator attempts') ||
    err?.code === 'ASSIGNMENT_CHANGE_BLOCKED'
  ) {
    return "Complete this student's unfinished simulator attempts before changing group.";
  }
  return msg || 'Failed to update student JMCWC group assignment.';
}

async function loadAdminJmcwcOverview() {
  if (!isSupabaseConfigured()) {
    renderAdminJmcwcPapersTable([]);
    renderAdminJmcwcCategoriesTable();
    renderAdminJmcwcAttemptsTable([]);
    syncSelectedStudentJmcwcAdminUI();
    return;
  }

  try {
    const [overviewRes, papersRes] = await Promise.all([
      callAdminJmcwcApi({ action: 'admin_get_overview' }),
      callAdminJmcwcApi({ action: 'admin_get_papers' }),
    ]);

    adminJmcwcAssignments = Array.isArray(overviewRes.assignments) ? overviewRes.assignments : [];
    adminJmcwcCategories = Array.isArray(overviewRes.categories) ? overviewRes.categories : [];
    adminJmcwcTargets = Array.isArray(overviewRes.targets) ? overviewRes.targets : [];
    adminLegacyRoundCategories = Array.isArray(overviewRes.legacy_categories) ? overviewRes.legacy_categories : [];
    adminJmcwcPapers = Array.isArray(papersRes.papers) ? papersRes.papers : [];

    renderAdminJmcwcPapersTable(adminJmcwcPapers);
    renderAdminJmcwcCategoriesTable();
    await syncSelectedStudentJmcwcAdminUI();
    await loadAdminJmcwcAttempts();
  } catch (err) {
    console.warn('JMCWC Admin overview load note:', err.message);
  }
}

async function syncSelectedStudentJmcwcAdminUI() {
  const studentObj = allStudents.find(s => s.id === selectedStudentId);
  const labelEl = document.getElementById('admin-jmcwc-student-label');
  const groupSelect = document.getElementById('select-admin-jmcwc-group');
  const errEl = document.getElementById('admin-jmcwc-assignment-error');

  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  if (labelEl) {
    labelEl.textContent = studentObj
      ? `${studentObj.full_name} (${studentObj.student_code})`
      : 'None selected';
  }

  const assignment = adminJmcwcAssignments.find(a => a.student_id === selectedStudentId);
  if (groupSelect) {
    groupSelect.value = assignment?.group_key || '';
    groupSelect.disabled = !selectedStudentId;
  }

  // Load deletion preview counts for the selected student
  await loadSelectedStudentDeletionPreview();

  const scopeSelect = document.getElementById('filter-jmcwc-attempt-student');
  if (scopeSelect?.value === 'selected') {
    await loadAdminJmcwcAttempts();
  }
}

async function loadSelectedStudentDeletionPreview() {
  const assignEl = document.getElementById('del-preview-assignments');
  const attEl = document.getElementById('del-preview-attempts');
  const payEl = document.getElementById('del-preview-payloads');
  const scEl = document.getElementById('del-preview-scores');

  if (!selectedStudentId || !isSupabaseConfigured()) {
    if (assignEl) assignEl.textContent = '0';
    if (attEl) attEl.textContent = '0';
    if (payEl) payEl.textContent = '0';
    if (scEl) scEl.textContent = '0';
    return;
  }

  try {
    const res = await callAdminJmcwcApi({
      action: 'admin_get_student_deletion_preview',
      student_id: selectedStudentId,
    });
    const counts = res.counts || {};
    if (assignEl) assignEl.textContent = String(counts.jmcwc_assignments ?? 0);
    if (attEl) attEl.textContent = String(counts.jmcwc_attempts ?? 0);
    if (payEl) payEl.textContent = String(counts.jmcwc_payloads ?? 0);
    if (scEl) scEl.textContent = String(counts.jmcwc_scores ?? 0);
  } catch {
    if (assignEl) assignEl.textContent = '0';
    if (attEl) attEl.textContent = '0';
    if (payEl) payEl.textContent = '0';
    if (scEl) scEl.textContent = '0';
  }
}

function renderAdminJmcwcPapersTable(papers) {
  const tbody = document.getElementById('admin-jmcwc-papers-tbody');
  if (!tbody) return;

  if (!Array.isArray(papers) || papers.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="font-size: var(--text-xs); color: var(--text-muted); text-align: center;">
          No JMCWC papers loaded.
        </td>
      </tr>
    `;
    return;
  }

  // Strictly read-only: NO publication controls exposed
  tbody.innerHTML = papers.map(p => `
    <tr>
      <td style="font-weight: 700;">${escapeHtml(formatJmcwcGroupLabel(p.group_key))} <span class="num" style="font-size: 11px; color: var(--text-muted);">(${escapeHtml(p.group_key)})</span></td>
      <td class="num"><code>${escapeHtml(p.version)}</code></td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(p.title)}</div>
        <div style="font-size: 11px; color: var(--text-muted);">Source: ${escapeHtml(p.source_workbook || '—')}</div>
      </td>
      <td class="num" style="text-align: right;">${Number(p.section_count) || 0}</td>
      <td class="num" style="text-align: right;">${Number(p.question_count) || 0}</td>
      <td class="num" style="text-align: right;">${Number(p.baseline_max_marks) || 0}</td>
      <td class="num" style="text-align: right;">${Number(p.dynamic_slot_count) || 0}</td>
      <td>
        <span class="badge ${p.published ? 'badge-active' : 'badge-inactive'}">
          ${p.published ? 'Published' : 'Unpublished (Read-only)'}
        </span>
      </td>
    </tr>
  `).join('');
}

function renderAdminJmcwcCategoriesTable() {
  const tbody = document.getElementById('admin-jmcwc-categories-tbody');
  const groupSelect = document.getElementById('select-admin-jmcwc-cat-group');
  if (!tbody || !groupSelect) return;

  const groupKey = groupSelect.value || 'junior1';
  const groupCats = adminJmcwcCategories
    .filter(c => !c.group_key || c.group_key === groupKey)
    .sort((a, b) => (a.section_order ?? a.position ?? 0) - (b.section_order ?? b.position ?? 0));

  if (groupCats.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="font-size: var(--text-xs); color: var(--text-muted); text-align: center;">
          No categories found for ${escapeHtml(formatJmcwcGroupLabel(groupKey))}.
        </td>
      </tr>
    `;
    return;
  }

  const targetByCatId = new Map();
  for (const t of adminJmcwcTargets) {
    if (t.group_key === groupKey) {
      targetByCatId.set(t.category_key || t.category_id, t.target_seconds);
    }
  }

  tbody.innerHTML = groupCats.map(cat => {
    const catKey = cat.key || cat.id;
    const targetSec = targetByCatId.get(catKey);
    const targetDisplay = Number.isInteger(targetSec) && targetSec > 0
      ? formatSecondsToMMSS(targetSec)
      : '';

    return `
      <tr data-jmcwc-cat-row="${escapeHtml(cat.id)}">
        <td class="num" style="font-weight: 700;">#${cat.section_order}</td>
        <td style="font-weight: 600;">${escapeHtml(cat.display_name)}</td>
        <td class="num"><code style="font-size: 11px;">${escapeHtml(cat.category_slug)}</code></td>
        <td>
          <input
            type="text"
            class="form-input num input-admin-jmcwc-target"
            data-cat-id="${escapeHtml(cat.id)}"
            placeholder="Optional (e.g. 3:00)"
            value="${escapeHtml(targetDisplay)}"
            aria-label="Optional target time for ${escapeHtml(cat.display_name)}"
            style="max-width: 140px; min-height: 36px; font-size: var(--text-xs);"
          />
        </td>
        <td>
          <select
            class="form-select select-admin-legacy-map"
            data-cat-id="${escapeHtml(cat.id)}"
            aria-label="Legacy Round category mapping for ${escapeHtml(cat.display_name)}"
            style="min-height: 36px; font-size: var(--text-xs);"
          >
            <option value="">-- Unmapped --</option>
            ${adminLegacyRoundCategories.map(leg => `
              <option value="${escapeHtml(leg.id)}" ${cat.legacy_category_id === leg.id ? 'selected' : ''}>
                ${escapeHtml(leg.name)}${leg.active === false ? ' [Inactive]' : ''}
              </option>
            `).join('')}
          </select>
        </td>
        <td style="text-align: right;">
          <button
            type="button"
            class="btn btn-outline btn-sm btn-save-jmcwc-cat-row"
            data-cat-id="${escapeHtml(cat.id)}"
            data-group-key="${escapeHtml(groupKey)}"
          >
            Save
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-save-jmcwc-cat-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catId = btn.getAttribute('data-cat-id');
      const gKey = btn.getAttribute('data-group-key');
      const row = tbody.querySelector(`[data-jmcwc-cat-row="${catId}"]`);
      if (!row || !catId) return;

      const targetInput = row.querySelector('.input-admin-jmcwc-target');
      const mapSelect = row.querySelector('.select-admin-legacy-map');
      const rawTarget = (targetInput?.value || '').trim();
      const legacyCategoryId = mapSelect?.value || null;

      let targetSeconds = null;
      if (rawTarget !== '') {
        targetSeconds = parseTimeToSeconds(rawTarget);
        if (!targetSeconds || targetSeconds <= 0) {
          showToast('error', 'Target time must be a positive mm:ss or seconds value (or leave blank to clear).');
          return;
        }
      }

      btn.disabled = true;
      try {
        await Promise.all([
          callAdminJmcwcApi({
            action: 'admin_set_target',
            group_key: gKey,
            category_id: catId,
            target_seconds: targetSeconds,
          }),
          callAdminJmcwcApi({
            action: 'admin_set_category_mapping',
            category_id: catId,
            legacy_category_id: legacyCategoryId,
          }),
        ]);
        showToast('success', 'Saved category target & legacy mapping.');
        await loadAdminJmcwcOverview();
      } catch (err) {
        showToast('error', err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function loadAdminJmcwcAttempts() {
  const tbody = document.getElementById('admin-jmcwc-attempts-tbody');
  if (!tbody) return;

  if (!isSupabaseConfigured()) {
    renderAdminJmcwcAttemptsTable([]);
    return;
  }

  const scopeVal = document.getElementById('filter-jmcwc-attempt-student')?.value || 'selected';
  const groupVal = document.getElementById('filter-jmcwc-attempt-group')?.value || '';
  const modeVal = document.getElementById('filter-jmcwc-attempt-mode')?.value || '';
  const statusVal = document.getElementById('filter-jmcwc-attempt-status')?.value || '';

  const reqPayload = {
    action: 'admin_list_attempts',
    limit: 100,
  };
  if (scopeVal === 'selected' && selectedStudentId) {
    reqPayload.student_id = selectedStudentId;
  }
  if (groupVal) reqPayload.group_key = groupVal;
  if (modeVal) reqPayload.mode = modeVal;
  if (statusVal) reqPayload.status = statusVal;

  try {
    const res = await callAdminJmcwcApi(reqPayload);
    adminJmcwcAttempts = Array.isArray(res.attempts) ? res.attempts : [];
    renderAdminJmcwcAttemptsTable(adminJmcwcAttempts);
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="font-size: var(--text-xs); color: var(--color-danger-text); text-align: center;">
          ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

function renderAdminJmcwcAttemptsTable(attempts) {
  const tbody = document.getElementById('admin-jmcwc-attempts-tbody');
  if (!tbody) return;

  if (!Array.isArray(attempts) || attempts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="font-size: var(--text-xs); color: var(--text-muted); text-align: center; padding: var(--space-4);">
          No simulator attempts match the current filters.
        </td>
      </tr>
    `;
    return;
  }

  const studentById = new Map(allStudents.map(s => [s.id, s]));

  // Strictly NO delete attempt button/shortcut so the 3-unfinished-flat-round cap cannot be bypassed
  tbody.innerHTML = attempts.map(att => {
    const stu = studentById.get(att.student_id) || att.student;
    const stuLabel = stu ? `${stu.full_name} (${stu.student_code})` : att.student_id;
    const catKey = att.category_key || att.category_id;
    const cat = catKey ? adminJmcwcCategories.find(c => (c.key || c.id) === catKey) : null;
    const modeLabel = att.mode === 'flat'
      ? 'Flat Round'
      : `Category: ${cat ? (cat.display_name || cat.label) : (catKey || 'Single Category')}`;
    const scoreObj = att.score || att.score_summary || null;
    const earnedVal = scoreObj ? (scoreObj.marks ?? scoreObj.earned_marks) : null;
    const scoreText = att.status === 'submitted' && scoreObj && earnedVal !== null && earnedVal !== undefined
      ? `${earnedVal} / ${scoreObj.max_marks}`
      : '—';
    const createdIso = att.created_at || att.started_at || '';

    return `
      <tr>
        <td style="font-weight: 600;">${escapeHtml(stuLabel)}</td>
        <td>${escapeHtml(formatJmcwcGroupLabel(att.group_key))}</td>
        <td>${escapeHtml(modeLabel)}</td>
        <td>
          <span class="badge ${att.status === 'submitted' ? 'badge-active' : att.status === 'running' ? 'badge-primary' : 'badge-warning'}">
            ${escapeHtml(att.status)}
          </span>
        </td>
        <td class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
          ${escapeHtml(createdIso ? formatDisplayDateIST(createdIso.slice(0, 10)) : '—')}
        </td>
        <td class="num">${escapeHtml(formatActiveDurationMs(att.active_ms || 0))}</td>
        <td class="num" style="font-weight: 700;">${escapeHtml(scoreText)}</td>
        <td style="text-align: right;">
          ${att.status === 'submitted' ? `
            <button
              type="button"
              class="btn btn-outline btn-sm btn-admin-inspect-jmcwc-review"
              data-attempt-id="${escapeHtml(att.id)}"
            >
              Inspect Review
            </button>
          ` : `
            <span style="font-size: var(--text-xs); color: var(--text-dim);">In progress</span>
          `}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-admin-inspect-jmcwc-review').forEach(btn => {
    btn.addEventListener('click', async () => {
      const attemptId = btn.getAttribute('data-attempt-id');
      if (attemptId) {
        await handleOpenAdminAttemptReview(attemptId);
      }
    });
  });
}

async function handleOpenAdminAttemptReview(attemptId) {
  try {
    const res = await callAdminJmcwcApi({
      action: 'admin_get_attempt_review',
      attempt_id: attemptId,
    });

    const vm = buildSubmittedReviewViewModel({
      attempt: res.attempt,
      score: res.score,
      review_questions: res.review_questions || [],
    });

    const marksEl = document.getElementById('admin-review-marks');
    const partialEl = document.getElementById('admin-review-partial-marks');
    const countsEl = document.getElementById('admin-review-counts');
    const timeEl = document.getElementById('admin-review-active-time');
    const tbody = document.getElementById('admin-review-questions-tbody');

    if (marksEl) marksEl.textContent = `${vm.earnedMarks} / ${vm.maxMarks}`;
    if (partialEl) partialEl.textContent = `Partial marks: ${vm.partialMarks} (${vm.partialCount} questions)`;
    if (countsEl) {
      countsEl.textContent = `${vm.correctCount} correct · ${vm.partialCount} partial · ${vm.wrongCount} wrong · ${vm.skippedCount} skipped`;
    }
    if (timeEl) timeEl.textContent = vm.activeTimeFormatted;

    if (tbody) {
      tbody.innerHTML = vm.questions.map(q => `
        <tr>
          <td class="num" style="font-weight: 700;">${escapeHtml(q.question_key)}</td>
          <td style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(q.category_name)}</td>
          <td class="num" style="font-weight: 600;">${escapeHtml(q.prompt)}</td>
          <td class="num">${q.submitted_raw ? escapeHtml(q.submitted_raw) : '<span style="color: var(--text-dim);">Skipped</span>'}</td>
          <td class="num">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">${escapeHtml(q.expected_answer_label)}:</div>
            <div style="font-weight: 700;">${escapeHtml(q.expected_display)}</div>
          </td>
          <td class="num" style="text-align: right; font-weight: 700;">${q.awarded_marks} / ${q.max_marks}</td>
          <td style="font-size: var(--text-xs);">
            <strong>${escapeHtml(q.verdict)}</strong>
            ${q.explanation ? `<div style="color: var(--text-muted);">${escapeHtml(q.explanation)}</div>` : ''}
          </td>
        </tr>
      `).join('');
    }

    openModal('admin-jmcwc-review-modal');
  } catch (err) {
    showToast('error', err.message);
  }
}

function setupAdminJmcwcListeners() {
  document.getElementById('btn-refresh-jmcwc-admin')?.addEventListener('click', () => {
    loadAdminJmcwcOverview();
  });

  document.getElementById('select-admin-jmcwc-cat-group')?.addEventListener('change', () => {
    renderAdminJmcwcCategoriesTable();
  });

  document.getElementById('btn-save-jmcwc-assignment')?.addEventListener('click', async () => {
    const errEl = document.getElementById('admin-jmcwc-assignment-error');
    const groupSelect = document.getElementById('select-admin-jmcwc-group');
    const saveBtn = document.getElementById('btn-save-jmcwc-assignment');

    if (errEl) {
      errEl.style.display = 'none';
      errEl.textContent = '';
    }

    if (!selectedStudentId) {
      showToast('info', 'Please select a student first.');
      return;
    }

    const groupKey = groupSelect?.value || null;
    if (saveBtn) saveBtn.disabled = true;

    try {
      await callAdminJmcwcApi({
        action: 'admin_set_assignment',
        student_id: selectedStudentId,
        group_key: groupKey,
      });
      showToast('success', 'Student JMCWC group assignment updated.');
      await loadAdminJmcwcOverview();
    } catch (err) {
      const friendly = formatFriendlyAssignmentError(err);
      if (errEl) {
        errEl.textContent = friendly;
        errEl.style.display = 'block';
      }
      showToast('error', friendly);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  ['filter-jmcwc-attempt-student', 'filter-jmcwc-attempt-group', 'filter-jmcwc-attempt-mode', 'filter-jmcwc-attempt-status'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      loadAdminJmcwcAttempts();
    });
  });
}

document.addEventListener('DOMContentLoaded', initRounds);
