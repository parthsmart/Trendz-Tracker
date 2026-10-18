/**
 * Trendz Tracker - Admin Weekly Tests Controller (js/weeklyTests.js)
 * 
 * Manage weekly tests and official teacher test score entry:
 * - Admin-only route guard
 * - Lists tests newest first (date, title, number of scores entered)
 * - Create & edit test modal (date, title, notes; no delete in this phase)
 * - Category dropdown grouped by section (basics first; never mix sections in one list)
 * - Scoring grid for ALL active students with Correct, Total, Time (mm:ss) inputs
 * - Live wrong count and shared score color (js/scoreColors.js)
 * - Empty rows skipped ("Not entered"); scores labeled "Entered by teacher"
 * - Keyboard flow: Enter moves Correct -> Total -> Time -> next student Correct
 * - Summary: "N of M students entered"
 * - In-browser validation (correct <= total, total > 0)
 * - Unsaved changes warning before leaving page
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getScoreFeedback } from './scoreColors.js';
import {
  getISTDateString,
  formatDisplayDateIST,
  formatSecondsToTime,
  parseTimeToSeconds
} from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';

let currentProfile = null;
let allTests = [];
let activeTestId = null;
let allCategories = [];
let activeCategoryId = null;
let activeStudents = [];
let studentLevels = new Set();

// student_id -> { id?: string, correct: number|string, total: number|string, time_seconds: number|null, formatted_time?: string, is_saved: boolean }
let currentScoresMap = new Map();
let initialScoresJson = '{}';
let hasUnsavedChanges = false;

let searchQuery = '';
let selectedLevelFilter = '';

async function initWeeklyTestsPage() {
  currentProfile = await requireAuth(['admin']);
  if (!currentProfile) return;

  renderHeaderUser(currentProfile);
  setupAdminNav();
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupTestModalHandlers();
  setupFilterHandlers();
  setupUnsavedChangesGuard();

  // Load active students and categories
  await Promise.all([
    loadActiveStudents(),
    loadCategories()
  ]);

  // Load tests list
  await loadTests();
}

/**
 * Loads all active students for score entry
 */
async function loadActiveStudents() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profiles')
        .select('id, student_code, full_name, level, active')
        .eq('role', 'student')
        .eq('active', true)
        .order('student_code', { ascending: true });

      if (error) throw error;
      activeStudents = data || [];
    } else {
      activeStudents = DemoDB.getStudents()
        .filter(s => s.role === 'student' && s.active !== false)
        .sort((a, b) => String(a.student_code).localeCompare(String(b.student_code)));
    }

    studentLevels.clear();
    activeStudents.forEach(s => {
      if (s.level && s.level.trim()) studentLevels.add(s.level.trim());
    });

    populateLevelFilter();
  } catch (err) {
    console.error('Failed to load active students:', err);
    showToast('error', 'Failed to load active students roster.');
  }
}

/**
 * Populates the level filter dropdown
 */
function populateLevelFilter() {
  const select = document.getElementById('student-level-filter');
  if (!select) return;

  const sortedLevels = Array.from(studentLevels).sort();
  select.innerHTML = `
    <option value="">All Levels</option>
    ${sortedLevels.map(lvl => `
      <option value="${escapeHtml(lvl)}">${escapeHtml(lvl)}</option>
    `).join('')}
  `;
}

/**
 * Loads categories and groups them with basics first
 */
async function loadCategories() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      allCategories = data || [];
    } else {
      allCategories = DemoDB.getCategories()
        .filter(c => c.active !== false)
        .sort((a, b) => a.sort_order - b.sort_order);
    }

    renderGroupedCategorySelect();
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

/**
 * Renders the category dropdown grouped by section:
 * Basics first; never mix sections in one list.
 */
function renderGroupedCategorySelect() {
  const select = document.getElementById('score-category-select');
  if (!select) return;

  if (allCategories.length === 0) {
    select.innerHTML = '<option value="">No categories available</option>';
    return;
  }

  const basics = allCategories.filter(c => c.section === 'basics');
  const rounds = allCategories.filter(c => c.section === 'round');
  const elements = allCategories.filter(c => c.section === 'elements');
  const flash = allCategories.filter(c => c.section === 'flash');

  let html = '';

  if (basics.length > 0) {
    html += `<optgroup label="⚡ Basics Track">`;
    basics.forEach(c => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (rounds.length > 0) {
    html += `<optgroup label="🏆 Competition Rounds">`;
    rounds.forEach(c => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (elements.length > 0) {
    html += `<optgroup label="🧩 Elements Track">`;
    elements.forEach(c => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (flash.length > 0) {
    html += `<optgroup label="⚡ Flash Anzan">`;
    flash.forEach(c => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  select.innerHTML = html;

  // Set default category to first basics or first overall
  if (basics.length > 0) {
    activeCategoryId = basics[0].id;
  } else if (allCategories.length > 0) {
    activeCategoryId = allCategories[0].id;
  }
  select.value = activeCategoryId;

  select.onchange = async () => {
    if (hasUnsavedChanges) {
      const confirmLeave = confirm('You have unsaved score changes for the current category. Discard changes and switch category?');
      if (!confirmLeave) {
        select.value = activeCategoryId;
        return;
      }
    }
    activeCategoryId = select.value;
    await loadScoresForCurrentSelection();
  };
}

/**
 * Loads weekly tests list (newest first)
 */
async function loadTests(selectTestId = null) {
  const container = document.getElementById('tests-list-container');
  const badge = document.getElementById('tests-count-badge');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // Load tests
      const { data: testData, error: testErr } = await supabase
        .from('weekly_tests')
        .select('*')
        .order('test_date', { ascending: false });

      if (testErr) throw testErr;

      // Count scores for each test
      const { data: countData } = await supabase
        .from('weekly_test_scores')
        .select('test_id');

      const countsMap = new Map();
      (countData || []).forEach(row => {
        countsMap.set(row.test_id, (countsMap.get(row.test_id) || 0) + 1);
      });

      allTests = (testData || []).map(t => ({
        ...t,
        scores_count: countsMap.get(t.id) || 0
      }));
    } else {
      allTests = DemoDB.getWeeklyTests();
    }

    if (badge) badge.textContent = `${allTests.length} ${allTests.length === 1 ? 'test' : 'tests'}`;

    renderTestsList(selectTestId);
  } catch (err) {
    console.error('Failed to load tests list:', err);
    if (container) {
      container.innerHTML = `
        <div style="padding: var(--space-4); color: var(--color-danger); font-size: var(--text-xs);">
          Failed to load weekly tests: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Renders the sidebar tests list
 */
function renderTestsList(requestedSelectId = null) {
  const container = document.getElementById('tests-list-container');
  if (!container) return;

  if (allTests.length === 0) {
    container.innerHTML = `
      <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-xs);">
        No weekly tests scheduled yet.
        <br />
        Click <strong>+ New Weekly Test</strong> above to create one.
      </div>
    `;
    clearTestDetail();
    return;
  }

  let html = `<div style="display: flex; flex-direction: column;">`;

  allTests.forEach(test => {
    const isSelected = test.id === (requestedSelectId || activeTestId || allTests[0].id);
    const dateFormatted = formatDisplayDateIST(test.test_date);

    html += `
      <button type="button" class="test-item-btn ${isSelected ? 'active' : ''}" data-test-id="${test.id}" style="
        text-align: left;
        background: ${isSelected ? 'var(--color-primary-subtle)' : 'transparent'};
        border: none;
        border-bottom: 1px solid var(--border-hairline);
        border-left: 3px solid ${isSelected ? 'var(--color-primary)' : 'transparent'};
        padding: var(--space-3) var(--space-4);
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        flex-direction: column;
        gap: 3px;
        width: 100%;
      ">
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <span style="font-weight: 700; font-size: var(--text-sm); color: ${isSelected ? 'var(--color-primary)' : 'var(--text-main)'};">
            ${escapeHtml(test.title)}
          </span>
          <span class="num" style="font-size: 11px; color: var(--text-muted); font-weight: 600;">
            ${escapeHtml(dateFormatted)}
          </span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
          <span style="font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;">
            ${test.notes ? escapeHtml(test.notes) : 'No notes'}
          </span>
          <span class="status-chip ${test.scores_count > 0 ? 'chip-verified' : 'chip-unverified'}" style="font-size: 10px; padding: 1px 6px;">
            ${test.scores_count} ${test.scores_count === 1 ? 'score' : 'scores'}
          </span>
        </div>
      </button>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;

  // Bind click handlers
  container.querySelectorAll('.test-item-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-test-id');
      if (id === activeTestId) return;

      if (hasUnsavedChanges) {
        const confirmLeave = confirm('You have unsaved score changes. Discard changes and select a different test?');
        if (!confirmLeave) return;
      }

      await selectTest(id);
    };
  });

  // Select test
  const targetId = requestedSelectId || activeTestId || allTests[0].id;
  selectTest(targetId);
}

/**
 * Activates a test and loads its scores
 */
async function selectTest(testId) {
  activeTestId = testId;
  hasUnsavedChanges = false;
  setUnsavedIndicator(false);

  // Update sidebar active states
  const container = document.getElementById('tests-list-container');
  if (container) {
    container.querySelectorAll('.test-item-btn').forEach(b => {
      const match = b.getAttribute('data-test-id') === testId;
      b.classList.toggle('active', match);
      b.style.background = match ? 'var(--color-primary-subtle)' : 'transparent';
      b.style.borderLeftColor = match ? 'var(--color-primary)' : 'transparent';
    });
  }

  const activeTest = allTests.find(t => t.id === testId);
  if (!activeTest) {
    clearTestDetail();
    return;
  }

  // Update header details
  const titleEl = document.getElementById('active-test-title');
  const metaEl = document.getElementById('active-test-meta');
  const btnEdit = document.getElementById('btn-edit-active-test');

  if (titleEl) titleEl.textContent = activeTest.title;
  if (metaEl) {
    const formattedDate = formatDisplayDateIST(activeTest.test_date);
    metaEl.innerHTML = `
      <strong>Date:</strong> <span class="num">${escapeHtml(formattedDate)}</span>
      ${activeTest.notes ? ` &middot; <em>${escapeHtml(activeTest.notes)}</em>` : ''}
    `;
  }
  if (btnEdit) {
    btnEdit.style.display = 'inline-block';
    btnEdit.onclick = () => openTestModal(activeTest);
  }

  await loadScoresForCurrentSelection();
}

/**
 * Clears the test detail section when no test is selected
 */
function clearTestDetail() {
  activeTestId = null;
  const titleEl = document.getElementById('active-test-title');
  const metaEl = document.getElementById('active-test-meta');
  const btnEdit = document.getElementById('btn-edit-active-test');
  const tbody = document.getElementById('scores-roster-tbody');

  if (titleEl) titleEl.textContent = 'Select a Test';
  if (metaEl) metaEl.textContent = 'Select a test from the left to enter scores.';
  if (btnEdit) btnEdit.style.display = 'none';
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-state" style="text-align: center; padding: var(--space-8);">
          No test selected.
        </td>
      </tr>
    `;
  }
}

/**
 * Loads existing scores for the active test and active category
 */
async function loadScoresForCurrentSelection() {
  if (!activeTestId || !activeCategoryId) return;

  const tbody = document.getElementById('scores-roster-tbody');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-state" style="text-align: center; padding: var(--space-6);">
          Loading student scores...
        </td>
      </tr>
    `;
  }

  try {
    let savedScores = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('weekly_test_scores')
        .select('*')
        .eq('test_id', activeTestId)
        .eq('category_id', activeCategoryId);

      if (error) throw error;
      savedScores = data || [];
    } else {
      savedScores = DemoDB.getWeeklyTestScores(activeTestId, activeCategoryId);
    }

    currentScoresMap.clear();

    // Map existing scores
    savedScores.forEach(sc => {
      currentScoresMap.set(sc.student_id, {
        id: sc.id,
        correct: sc.correct,
        total: sc.total,
        time_seconds: sc.time_seconds,
        formatted_time: sc.time_seconds ? formatSecondsToTime(sc.time_seconds) : '',
        is_saved: true
      });
    });

    initialScoresJson = JSON.stringify(Array.from(currentScoresMap.entries()));
    hasUnsavedChanges = false;
    setUnsavedIndicator(false);

    renderScoresTable();
    updateCompletionBadge();
  } catch (err) {
    console.error('Failed to load test scores:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="color: var(--color-danger); text-align: center; padding: var(--space-4);">
            Failed to load scores: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }
}

/**
 * Updates the summary badge "N of M students entered"
 */
function updateCompletionBadge() {
  const badge = document.getElementById('completion-summary-badge');
  if (!badge) return;

  let enteredCount = 0;
  activeStudents.forEach(st => {
    const s = currentScoresMap.get(st.id);
    if (s && s.total !== '' && s.total !== null && s.total !== undefined && Number(s.total) > 0) {
      enteredCount++;
    }
  });

  const totalActive = activeStudents.length;
  badge.textContent = `${enteredCount} of ${totalActive} entered`;
  badge.className = `status-chip ${enteredCount === totalActive ? 'chip-verified' : 'chip-unverified'}`;
}

/**
 * Renders the student scoring roster grid with inputs and live feedback
 */
function renderScoresTable() {
  const tbody = document.getElementById('scores-roster-tbody');
  if (!tbody) return;

  // Filter students by search and level
  const query = searchQuery.trim().toLowerCase();
  const filtered = activeStudents.filter(s => {
    if (selectedLevelFilter && s.level !== selectedLevelFilter) return false;
    if (query) {
      const matchName = (s.full_name || '').toLowerCase().includes(query);
      const matchCode = (s.student_code || '').toLowerCase().includes(query);
      return matchName || matchCode;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: var(--space-8); color: var(--text-muted); font-size: var(--text-xs);">
          No active students match the current search / filter criteria.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';

  filtered.forEach((student, index) => {
    const score = currentScoresMap.get(student.id) || {
      correct: '',
      total: '',
      time_seconds: null,
      formatted_time: '',
      is_saved: false
    };

    const hasData = score.total !== '' && score.total !== null && score.total !== undefined && Number(score.total) > 0;
    const feedback = hasData ? getScoreFeedback(score.correct, score.total) : null;

    const statusBadge = hasData
      ? `<span class="status-chip chip-corrected" title="Official score entered by teacher">✓ Entered by teacher</span>`
      : `<span class="status-chip chip-unverified">Not entered</span>`;

    const feedbackHtml = feedback
      ? `<span class="status-chip ${feedback.badgeClass}" style="color: ${feedback.colorVar}; background: ${feedback.bgVar}; font-size: 11px;">
           ${feedback.wrongText}
         </span>`
      : `<span style="color: var(--text-dim); font-size: 11px;">—</span>`;

    html += `
      <tr data-student-id="${student.id}" data-index="${index}">
        <td>
          <div style="font-weight: 600; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(student.full_name)}
          </div>
          <div class="num" style="font-size: 11px; color: var(--text-muted);">
            ${escapeHtml(student.student_code)}
          </div>
        </td>

        <td>
          <span style="font-size: 11px; font-weight: 500; color: var(--text-main);">
            ${student.level ? escapeHtml(student.level) : '—'}
          </span>
        </td>

        <td>
          <input
            type="number"
            class="form-input score-input-correct"
            data-student-id="${student.id}"
            data-field="correct"
            data-index="${index}"
            min="0"
            value="${score.correct !== null && score.correct !== undefined ? score.correct : ''}"
            placeholder="0"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td>
          <input
            type="number"
            class="form-input score-input-total"
            data-student-id="${student.id}"
            data-field="total"
            data-index="${index}"
            min="1"
            value="${score.total !== null && score.total !== undefined ? score.total : ''}"
            placeholder="20"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td>
          <input
            type="text"
            class="form-input score-input-time"
            data-student-id="${student.id}"
            data-field="time"
            data-index="${index}"
            placeholder="1:30"
            value="${score.formatted_time || ''}"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td style="text-align: center;" class="cell-score-feedback" data-student-id="${student.id}">
          ${feedbackHtml}
        </td>

        <td style="text-align: center;" class="cell-score-status" data-student-id="${student.id}">
          ${statusBadge}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  attachScoreInputHandlers(filtered);
}

/**
 * Attaches change, input, and keyboard flow handlers to table inputs
 */
function attachScoreInputHandlers(filteredStudents) {
  const tbody = document.getElementById('scores-roster-tbody');
  if (!tbody) return;

  // Handle Input Changes & Live Validation
  tbody.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', () => {
      const studentId = input.getAttribute('data-student-id');
      const row = tbody.querySelector(`tr[data-student-id="${studentId}"]`);
      if (!row) return;

      const correctInput = row.querySelector('.score-input-correct');
      const totalInput = row.querySelector('.score-input-total');
      const timeInput = row.querySelector('.score-input-time');

      const cVal = correctInput.value.trim();
      const tVal = totalInput.value.trim();
      const timeVal = timeInput.value.trim();

      // Update current scores map
      const secVal = timeVal ? parseTimeToSeconds(timeVal) : null;
      currentScoresMap.set(studentId, {
        correct: cVal !== '' ? Number(cVal) : '',
        total: tVal !== '' ? Number(tVal) : '',
        time_seconds: secVal,
        formatted_time: timeVal,
        is_saved: false
      });

      // Update feedback cell
      const feedbackCell = row.querySelector('.cell-score-feedback');
      const statusCell = row.querySelector('.cell-score-status');

      if (tVal !== '' && Number(tVal) > 0 && cVal !== '') {
        const numC = Number(cVal);
        const numT = Number(tVal);
        const fb = getScoreFeedback(numC, numT);
        if (feedbackCell) {
          feedbackCell.innerHTML = `
            <span class="status-chip ${fb.badgeClass}" style="color: ${fb.colorVar}; background: ${fb.bgVar}; font-size: 11px;">
              ${fb.wrongText}
            </span>
          `;
        }
        if (statusCell) {
          statusCell.innerHTML = `<span class="status-chip chip-flagged">Unsaved</span>`;
        }
      } else if (cVal === '' && tVal === '') {
        if (feedbackCell) feedbackCell.innerHTML = `<span style="color: var(--text-dim); font-size: 11px;">—</span>`;
        if (statusCell) statusCell.innerHTML = `<span class="status-chip chip-unverified">Not entered</span>`;
      } else {
        if (feedbackCell) {
          feedbackCell.innerHTML = `<span class="status-chip chip-flagged" style="font-size: 10px;">Incomplete</span>`;
        }
      }

      markUnsaved();
      updateCompletionBadge();
    });

    // Keyboard Flow: Enter moves to next field, then to next student!
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const field = input.getAttribute('data-field');
        const currIdx = Number(input.getAttribute('data-index'));

        if (field === 'correct') {
          // Move to Total in same row
          const totalInp = tbody.querySelector(`.score-input-total[data-index="${currIdx}"]`);
          if (totalInp) totalInp.focus();
        } else if (field === 'total') {
          // Move to Time in same row
          const timeInp = tbody.querySelector(`.score-input-time[data-index="${currIdx}"]`);
          if (timeInp) timeInp.focus();
        } else if (field === 'time') {
          // Move to Correct of NEXT student!
          const nextIdx = currIdx + 1;
          const nextCorrect = tbody.querySelector(`.score-input-correct[data-index="${nextIdx}"]`);
          if (nextCorrect) {
            nextCorrect.focus();
          } else {
            // Reached the end of visible list, focus Save button
            const saveBtn = document.getElementById('btn-save-scores');
            if (saveBtn) saveBtn.focus();
          }
        }
      }
    });
  });

  // Save Scores Button
  const btnSave = document.getElementById('btn-save-scores');
  if (btnSave) {
    btnSave.onclick = saveScores;
  }
}

/**
 * Validates and saves all entered scores for the active test and category
 */
async function saveScores() {
  if (!activeTestId || !activeCategoryId) {
    showToast('error', 'Please select a test and category first.');
    return;
  }

  const btnSave = document.getElementById('btn-save-scores');
  btnSave.disabled = true;

  try {
    const scoresToUpsert = [];
    let hasValidationError = false;

    // Validate all student entries in memory
    for (const student of activeStudents) {
      const s = currentScoresMap.get(student.id);
      if (!s) continue;

      const hasCorrect = s.correct !== '' && s.correct !== null && s.correct !== undefined;
      const hasTotal = s.total !== '' && s.total !== null && s.total !== undefined;

      // Both empty -> skip (student did not take it)
      if (!hasCorrect && !hasTotal) {
        continue;
      }

      // One filled, other empty -> validation error
      if (!hasCorrect || !hasTotal) {
        showToast('error', `Student ${student.full_name}: Please enter both Correct and Total, or leave both blank.`);
        hasValidationError = true;
        break;
      }

      const numC = Number(s.correct);
      const numT = Number(s.total);

      if (isNaN(numC) || isNaN(numT) || numT <= 0) {
        showToast('error', `Student ${student.full_name}: Total must be greater than 0.`);
        hasValidationError = true;
        break;
      }

      if (numC > numT) {
        showToast('error', `Student ${student.full_name}: Correct (${numC}) cannot exceed Total (${numT}).`);
        hasValidationError = true;
        break;
      }

      if (numC < 0) {
        showToast('error', `Student ${student.full_name}: Correct cannot be negative.`);
        hasValidationError = true;
        break;
      }

      // Time validation if entered
      let timeSec = null;
      if (s.formatted_time && s.formatted_time.trim()) {
        timeSec = parseTimeToSeconds(s.formatted_time);
        if (timeSec === null || timeSec < 0) {
          showToast('error', `Student ${student.full_name}: Time must be in mm:ss format (e.g. 1:30).`);
          hasValidationError = true;
          break;
        }
      }

      scoresToUpsert.push({
        test_id: activeTestId,
        student_id: student.id,
        category_id: activeCategoryId,
        correct: numC,
        total: numT,
        time_seconds: timeSec
      });
    }

    if (hasValidationError) {
      btnSave.disabled = false;
      return;
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // Upsert official scores
      if (scoresToUpsert.length > 0) {
        const { error: upsertErr } = await supabase
          .from('weekly_test_scores')
          .upsert(scoresToUpsert, {
            onConflict: 'test_id,student_id,category_id'
          });

        if (upsertErr) throw upsertErr;
      }

      // Delete any scores that were cleared to blank
      const clearedStudentIds = [];
      activeStudents.forEach(st => {
        const s = currentScoresMap.get(st.id);
        const hasCorrect = s && s.correct !== '' && s.correct !== null && s.correct !== undefined;
        const hasTotal = s && s.total !== '' && s.total !== null && s.total !== undefined;
        if (!hasCorrect && !hasTotal && s && s.is_saved) {
          clearedStudentIds.push(st.id);
        }
      });

      if (clearedStudentIds.length > 0) {
        await supabase
          .from('weekly_test_scores')
          .delete()
          .eq('test_id', activeTestId)
          .eq('category_id', activeCategoryId)
          .in('student_id', clearedStudentIds);
      }
    } else {
      // Demo Mode
      DemoDB.saveWeeklyTestScores(activeTestId, activeCategoryId, activeStudents.map(st => {
        const s = currentScoresMap.get(st.id);
        return {
          student_id: st.id,
          correct: s?.correct ?? '',
          total: s?.total ?? '',
          time_seconds: s?.time_seconds ?? null
        };
      }));
    }

    showToast('success', 'Weekly test scores saved successfully.');
    hasUnsavedChanges = false;
    setUnsavedIndicator(false);

    // Refresh tests list count and reload scores
    await loadTests(activeTestId);
    await loadScoresForCurrentSelection();
  } catch (err) {
    console.error('Failed to save scores:', err);
    showToast('error', 'Failed to save weekly test scores: ' + err.message);
  } finally {
    btnSave.disabled = false;
  }
}

/**
 * Sets up student search and level filtering
 */
function setupFilterHandlers() {
  const searchInput = document.getElementById('student-search-input');
  if (searchInput) {
    searchInput.oninput = () => {
      searchQuery = searchInput.value;
      renderScoresTable();
    };
  }

  const levelSelect = document.getElementById('student-level-filter');
  if (levelSelect) {
    levelSelect.onchange = () => {
      selectedLevelFilter = levelSelect.value;
      renderScoresTable();
    };
  }
}

/**
 * Sets up Create / Edit Weekly Test Modal
 */
function setupTestModalHandlers() {
  const btnCreate = document.getElementById('btn-create-test');
  if (btnCreate) {
    btnCreate.onclick = () => openTestModal(null);
  }

  const form = document.getElementById('test-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btnSubmit = document.getElementById('btn-submit-test');
      const errBanner = document.getElementById('test-error-banner');
      if (errBanner) errBanner.style.display = 'none';

      const idVal = document.getElementById('test-id-input').value;
      const dateVal = document.getElementById('test-date-input').value;
      const titleVal = document.getElementById('test-title-input').value.trim();
      const notesVal = document.getElementById('test-notes-input').value.trim();

      if (!dateVal || !titleVal) {
        showModalError('Please enter both Test Date and Title.');
        return;
      }

      btnSubmit.disabled = true;

      try {
        let savedTestId = null;

        if (idVal) {
          // UPDATE
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { error } = await supabase
              .from('weekly_tests')
              .update({
                test_date: dateVal,
                title: titleVal,
                notes: notesVal || null
              })
              .eq('id', idVal);

            if (error) throw error;
          } else {
            DemoDB.updateWeeklyTest(idVal, {
              test_date: dateVal,
              title: titleVal,
              notes: notesVal || null
            });
          }
          savedTestId = idVal;
          showToast('success', 'Weekly test details updated.');
        } else {
          // CREATE
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { data, error } = await supabase
              .from('weekly_tests')
              .insert({
                test_date: dateVal,
                title: titleVal,
                notes: notesVal || null
              })
              .select('id')
              .single();

            if (error) throw error;
            savedTestId = data.id;
          } else {
            const created = DemoDB.createWeeklyTest({
              test_date: dateVal,
              title: titleVal,
              notes: notesVal || null
            });
            savedTestId = created.id;
          }
          showToast('success', 'New weekly test created.');
        }

        closeModal('test-modal');
        await loadTests(savedTestId);
      } catch (err) {
        console.error('Failed to save test:', err);
        showModalError(err.message || 'Failed to save test.');
      } finally {
        btnSubmit.disabled = false;
      }
    };
  }
}

function openTestModal(test = null) {
  const modalTitle = document.getElementById('test-modal-title');
  const idInput = document.getElementById('test-id-input');
  const dateInput = document.getElementById('test-date-input');
  const titleInput = document.getElementById('test-title-input');
  const notesInput = document.getElementById('test-notes-input');
  const errBanner = document.getElementById('test-error-banner');

  if (errBanner) errBanner.style.display = 'none';

  if (test) {
    if (modalTitle) modalTitle.textContent = 'Edit Weekly Test';
    if (idInput) idInput.value = test.id;
    if (dateInput) dateInput.value = test.test_date;
    if (titleInput) titleInput.value = test.title;
    if (notesInput) notesInput.value = test.notes || '';
  } else {
    if (modalTitle) modalTitle.textContent = 'Create Weekly Test';
    if (idInput) idInput.value = '';
    if (dateInput) dateInput.value = getISTDateString(new Date());
    if (titleInput) titleInput.value = '';
    if (notesInput) notesInput.value = '';
  }

  openModal('test-modal');
}

function showModalError(msg) {
  const banner = document.getElementById('test-error-banner');
  if (banner) {
    banner.textContent = msg;
    banner.style.display = 'block';
  } else {
    showToast('error', msg);
  }
}

/**
 * Unsaved changes warning guard (browser navigation + beforeunload)
 */
function setupUnsavedChangesGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = 'You have unsaved weekly test score changes. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  document.querySelectorAll('a').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      if (hasUnsavedChanges) {
        const proceed = confirm('You have unsaved weekly test score changes. Are you sure you want to navigate away?');
        if (!proceed) {
          e.preventDefault();
        }
      }
    });
  });
}

function markUnsaved() {
  hasUnsavedChanges = true;
  setUnsavedIndicator(true);
}

function setUnsavedIndicator(visible) {
  const ind = document.getElementById('unsaved-warning-indicator');
  if (ind) ind.style.display = visible ? 'inline' : 'none';
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');

  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'ADMIN';
  if (container) container.style.display = 'flex';
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-warning" style="margin-bottom: var(--space-6);" role="alert">
      <strong>Demo Mode Active:</strong> You are exploring with mock data on localhost/preview. Supabase credentials are not configured.
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
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', initWeeklyTestsPage);
