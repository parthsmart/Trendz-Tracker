/**
 * Trendz Tracker - Admin Per-Student Rounds Management Module (js/rounds.js)
 *
 * Phase 4c-0 Architecture:
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

let allStudents = [];
let allSeries = [];
let selectedStudentId = '';
let selectedSeriesFilter = 'all';
let todayIST = '';
let studentRoundsList = []; // enriched with series and scores_count

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
          <td colspan="7" style="text-align: center; color: var(--color-danger); padding: var(--space-6);">
            <div style="margin-bottom: var(--space-3); font-weight: 500;">Failed to load rounds: ${escapeHtml(err.message)}</div>
            <button type="button" id="btn-retry-load-rounds" class="btn btn-outline btn-sm">
              ↻ Try Again
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
    const isCurrentSeries = r.series && r.series.is_current;
    const timeFormatted = r.time_taken_seconds !== null && r.time_taken_seconds !== undefined
      ? formatSecondsToMMSS(r.time_taken_seconds)
      : '—';

    return `
      <tr>
        <td>
          <span class="badge ${isCurrentSeries ? 'badge-active' : 'badge-inactive'}" style="font-size: 11px;">
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
          <span style="font-size: var(--text-xs); color: var(--text-dim); background-color: var(--bg-surface-subtle); padding: 2px 6px; border-radius: var(--radius-sm);">
            ${escapeHtml(r.round_type || 'Category wise')}
          </span>
        </td>
        <td class="num" style="color: var(--text-muted);">
          ${escapeHtml(timeFormatted)}
        </td>
        <td class="num">
          ${hasResults ? `
            <span style="font-weight: 600; color: var(--color-primary-text);">
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

      document.getElementById('edit-round-id-hidden').value = roundId;
      document.getElementById('edit-round-display-label').textContent = `${seriesName} · Round ${roundNumber}`;
      document.getElementById('edit-round-date').value = roundDate;
      document.getElementById('edit-round-type').value = roundType;
      document.getElementById('edit-round-time').value = roundTime;
      document.getElementById('edit-round-error').style.display = 'none';

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

function openCreateModal(autoProposeNext = true) {
  if (!selectedStudentId) {
    showToast('info', 'Please select a student first.');
    return;
  }

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
  document.getElementById('create-round-error').style.display = 'none';

  openModal('create-round-modal');
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder || !isDemoMode()) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
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
  setupAdminNav();
  renderDemoBanner();

  await loadInitialMetadata();

  // Filter listeners
  const searchInput = document.getElementById('filter-student-search');
  searchInput?.addEventListener('input', () => {
    populateStudentSelect(searchInput.value);
    loadRounds();
  });

  const studentSelect = document.getElementById('select-student-rounds');
  studentSelect?.addEventListener('change', () => {
    selectedStudentId = studentSelect.value;
    loadRounds();
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
  });

  // "Quick Next Round" button
  document.getElementById('btn-quick-next-round')?.addEventListener('click', () => {
    openCreateModal(true);
  });

  // "Custom Round" button
  document.getElementById('btn-open-create-round')?.addEventListener('click', () => {
    openCreateModal(false);
  });

  // Create Round submit
  document.getElementById('create-round-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-round-error');
    const submitBtn = document.getElementById('btn-submit-create-round');
    const btnText = document.getElementById('btn-create-round-text');

    errorEl.style.display = 'none';

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
    if (isNaN(round_number) || round_number < 1) {
      errorEl.textContent = 'Please enter a valid round number (>= 1).';
      errorEl.style.display = 'block';
      return;
    }
    if (!round_date) {
      errorEl.textContent = 'Please select a round date.';
      errorEl.style.display = 'block';
      return;
    }

    let time_taken_seconds = null;
    if (timeRaw !== '') {
      time_taken_seconds = parseTimeToSeconds(timeRaw);
      if (time_taken_seconds === null) {
        errorEl.textContent = 'Time Taken must be in h:mm:ss, mm:ss, or seconds format.';
        errorEl.style.display = 'block';
        return;
      }
    }

    submitBtn.disabled = true;
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
      closeModal('create-round-modal');
      await loadRounds();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create round.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Create Round';
    }
  });

  // Edit Round submit
  document.getElementById('edit-round-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('edit-round-error');
    const submitBtn = document.getElementById('btn-submit-edit-round');
    const btnText = document.getElementById('btn-edit-round-text');

    errorEl.style.display = 'none';

    const roundId = document.getElementById('edit-round-id-hidden').value;
    const round_date = document.getElementById('edit-round-date').value;
    const round_type = document.getElementById('edit-round-type').value.trim();
    const timeRaw = document.getElementById('edit-round-time').value.trim();

    if (!round_date) {
      errorEl.textContent = 'Please enter a round date.';
      errorEl.style.display = 'block';
      return;
    }

    let time_taken_seconds = null;
    if (timeRaw !== '') {
      time_taken_seconds = parseTimeToSeconds(timeRaw);
      if (time_taken_seconds === null) {
        errorEl.textContent = 'Time Taken must be in h:mm:ss, mm:ss, or seconds format.';
        errorEl.style.display = 'block';
        return;
      }
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
}

document.addEventListener('DOMContentLoaded', initRounds);
