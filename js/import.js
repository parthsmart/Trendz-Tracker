/**
 * Trendz Tracker — Admin CSV Score Sheet Import Controller (js/import.js)
 *
 * STRICT PHASE 4c-1, 4c-2a, 4c-2b, 4c-2c & 4c-2d RULES:
 * - Admin-only route guard (`requireAuth(['admin'])`).
 * - NEVER inserts, updates, or deletes `results`, `student_rounds`, or `categories` directly.
 * - Uses ONLY the authoritative database RPCs for import mutations:
 *   1. `admin_start_import(p_student, p_file_name, p_name_in_file, p_mark_verified, p_rows_found, p_summary)`
 *   2. `admin_import_ensure_category(p_batch, p_series, p_category, p_new_name)`
 *   3. `admin_import_rounds(p_batch, p_series, p_rounds, p_on_date_conflict)`
 *      (1 to 100 rounds and at most 3000 cells per call; `p_on_date_conflict` is 'skip' or 'use_existing')
 *   4. `admin_finish_import(p_batch)`
 *   5. `admin_undo_import(p_batch, p_reason)`
 * - Reads `import_batches` and reads/writes `category_aliases`.
 * - Phase 4c-2d: Supports live non-destructive round & cell editing in the preview, live cross-check
 *   and date-check recalculation, "Edited" chips with "Reset to sheet value", record of edits in
 *   `p_summary.edits` (capped at 500 entries + count), history display, and unsaved-edits guard.
 * - Renders all strings coming from the CSV file strictly via `textContent` (never `innerHTML`).
 */

import { requireAuth } from './guard.js';
import { logoutUser } from './auth.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { showToast } from './toast.js';
import { getISTDateString, formatDisplayDateIST } from './stats.js';
import {
  parseScoreSheetCsv,
  formatSecondsDisplay,
  SAMPLE_TWO_BLOCK_CSV,
} from './importParser.js';
import {
  toMatchingKey,
  suggestSeriesForBlock,
  buildImportPreviewState,
  buildImportExecutionPlan,
  materializeBlockRoundChunks,
  validatePayload,
  createEmptyEditState,
  validateRoundEdit,
  validateCellEdit,
} from './importPlan.js';

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Formats an integer with thousands separators (e.g. 1677 -> "1,677").
 *
 * @param {number} n
 * @returns {string}
 */
function formatNum(n) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

/**
 * Clean 2-block sample CSV fixture for Demo Mode where all cells have valid ratios and times
 * so the admin can immediately test confirming series, saving the import, viewing history, and undoing.
 */
const CLEAN_READY_TWO_BLOCK_CSV = SAMPLE_TWO_BLOCK_CSV.replace(
  '1,ADD,,75/75,75,75/75,1:15,',
  '1,ADD,,75/75,1:12,75/75,1:15,'
);

let currentAdmin = null;
let allStudents = [];
let filteredStudents = [];
let roundCategories = [];
let roundSeries = [];
let categorySeries = [];
let categoryAliases = [];
let importBatches = [];
let todayIST = '';
let showInfoLines = true;

// Existing data for the currently selected student
let selectedStudentIdLoaded = null;
let existingStudentRounds = [];
let existingStudentResults = [];
let isLoadingStudentData = false;
let isImporting = false;

// Current CSV & per-block interactive UI state
let currentCsvText = '';
let currentFileName = '';
let currentParsedResult = null; // Immutable original parsed sheet from parseScoreSheetCsv
let currentPreviewState = null;
let currentExecutionPlan = null;
let blockUiState = {}; // { [blockNumber]: { seriesId: string, confirmed: boolean, adminMappings: { [rawKey]: { action, targetCategoryId, saveAlias } } } }

// Phase 4c-2d: Live preview edit state & inline editor UI state
let previewEditState = createEmptyEditState();
let expandedRoundKeys = new Set(); // Set of `${blockNumber}-${roundNumber}`
let activeRoundEditor = null; // { blockNumber, roundNumber, focusField: 'date'|'type'|'time'|'skip'|null } | null
let activeCellEditor = null; // { blockNumber, roundNumber, rowIndex } | null

/**
 * Returns true when the admin has any active unsaved edits in the current preview.
 *
 * @returns {boolean}
 */
function hasUnsavedPreviewEdits() {
  if (!currentPreviewState || !Array.isArray(currentPreviewState.editsList)) {
    const rKeys = Object.keys(previewEditState?.rounds || {});
    const cKeys = Object.keys(previewEditState?.cells || {});
    return rKeys.length > 0 || cKeys.length > 0;
  }
  return currentPreviewState.editsList.length > 0;
}

/**
 * Initialize the Admin Import Page
 */
async function initImportPage() {
  currentAdmin = await requireAuth(['admin']);
  if (!currentAdmin) return;

  renderHeaderUser(currentAdmin);
  setupAdminNav(currentAdmin);
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
    const sampleWrapper = document.getElementById('demo-sample-action-wrapper');
    if (sampleWrapper) sampleWrapper.style.display = 'flex';
  }

  bindStep1Listeners();
  bindImportOptionsAndModals();
  bindHistoryAndAliasesListeners();
  bindUnsavedEditsBeforeUnloadGuard();

  await loadReferenceData();
  await loadImportBatches();
}

/**
 * Warns the admin before closing or leaving the page if there are unsaved preview edits
 */
function bindUnsavedEditsBeforeUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedPreviewEdits() && !isImporting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/**
 * Shows an inline confirmation prompt when the admin attempts to start over or load a new file
 * while unsaved preview edits exist (avoids window.confirm / window.alert in iframe).
 *
 * @param {string} actionLabel
 * @param {Function} onConfirmDiscard
 */
function promptUnsavedEditsGuard(actionLabel, onConfirmDiscard) {
  if (!hasUnsavedPreviewEdits()) {
    hideUnsavedEditsWarning();
    onConfirmDiscard();
    return;
  }

  const warnBox = document.getElementById('import-unsaved-edits-warning');
  if (!warnBox) {
    onConfirmDiscard();
    return;
  }

  const editCount = currentPreviewState?.editsList?.length || 1;
  warnBox.replaceChildren();
  warnBox.style.display = 'block';

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  row.style.alignItems = 'center';
  row.style.flexWrap = 'wrap';
  row.style.gap = 'var(--space-3)';

  const msg = document.createElement('div');
  msg.style.fontSize = 'var(--text-xs)';
  msg.style.fontWeight = '600';
  msg.textContent = `⚠️ You have ${formatNum(editCount)} unsaved edit${editCount === 1 ? '' : 's'} in this preview. Are you sure you want to ${actionLabel} and discard ${editCount === 1 ? 'it' : 'them'}?`;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = 'var(--space-2)';
  actions.style.flexWrap = 'wrap';

  const keepBtn = document.createElement('button');
  keepBtn.type = 'button';
  keepBtn.className = 'btn btn-outline btn-sm';
  keepBtn.textContent = 'Keep Editing';
  keepBtn.addEventListener('click', () => {
    hideUnsavedEditsWarning();
  });

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'btn btn-primary btn-sm';
  discardBtn.textContent = `Discard Edits & ${actionLabel}`;
  discardBtn.addEventListener('click', () => {
    hideUnsavedEditsWarning();
    onConfirmDiscard();
  });

  actions.append(keepBtn, discardBtn);
  row.append(msg, actions);
  warnBox.appendChild(row);
  warnBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideUnsavedEditsWarning() {
  const warnBox = document.getElementById('import-unsaved-edits-warning');
  if (!warnBox) return;
  warnBox.style.display = 'none';
  warnBox.replaceChildren();
}

/**
 * Populates the top bar user name and logout handler
 */
function renderHeaderUser(profile) {
  const pill = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const logoutBtn = document.getElementById('btn-header-logout');

  if (pill && nameEl && roleEl) {
    nameEl.textContent = profile.full_name || profile.student_code || 'Admin';
    roleEl.textContent = 'Admin';
    pill.style.display = 'flex';
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logoutUser();
    });
  }
}

/**
 * Shows the persistent Demo Mode banner when running in Demo Mode
 */
function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  const banner = document.createElement('div');
  banner.className = 'demo-mode-alert-banner';
  banner.setAttribute('role', 'status');
  banner.textContent = '⚠️ DEMO MODE — data is fake (Local / Preview Environment)';
  placeholder.replaceChildren(banner);
}

/**
 * Helper to unwrap a scalar UUID or ID from a Supabase RPC response
 */
function extractScalarId(data, keyHints = ['id', 'batch_id', 'category_id']) {
  if (!data) return null;
  if (typeof data === 'string') return data.trim();
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    return extractScalarId(data[0], keyHints);
  }
  if (typeof data === 'object') {
    for (const k of keyHints) {
      if (data[k] && typeof data[k] === 'string') return data[k].trim();
    }
    const vals = Object.values(data);
    if (vals.length === 1 && typeof vals[0] === 'string') return vals[0].trim();
  }
  return null;
}

/**
 * Helper to unwrap an object from a Supabase RPC response
 */
function extractRpcObject(data) {
  if (!data) return {};
  if (Array.isArray(data)) return data[0] || {};
  if (typeof data === 'object') return data;
  return {};
}

/**
 * Loads reference tables:
 * - profiles (role = 'student')
 * - categories (section = 'round', active and inactive)
 * - round_series (id, name, sort_order, is_current)
 * - category_series (category_id, series_id, sort_order)
 * - category_aliases (alias, category_id)
 * - today_ist() for Indian time date checks
 */
async function loadReferenceData(preserveStudentSelection = true) {
  const studentSelect = document.getElementById('import-student-select');
  const prevStudentId = preserveStudentSelection && studentSelect ? studentSelect.value : null;

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      const [studentsRes, catsRes, seriesRes, catSeriesRes, aliasesRes, todayRes] =
        await Promise.all([
          supabase
            .from('profiles')
            .select('id, student_code, full_name, level, active, role')
            .eq('role', 'student')
            .order('full_name', { ascending: true }),
          supabase
            .from('categories')
            .select('id, name, section, sort_order, active')
            .eq('section', 'round')
            .order('sort_order', { ascending: true }),
          supabase
            .from('round_series')
            .select('id, name, sort_order, is_current')
            .order('sort_order', { ascending: true }),
          supabase
            .from('category_series')
            .select('category_id, series_id, sort_order')
            .order('sort_order', { ascending: true }),
          supabase.from('category_aliases').select('alias, category_id'),
          supabase.rpc('today_ist'),
        ]);

      if (studentsRes.error) throw new Error(studentsRes.error.message);
      if (catsRes.error) throw new Error(catsRes.error.message);
      if (seriesRes.error) throw new Error(seriesRes.error.message);
      if (catSeriesRes.error) throw new Error(catSeriesRes.error.message);

      allStudents = studentsRes.data || [];
      roundCategories = catsRes.data || [];
      roundSeries = seriesRes.data || [];
      categorySeries = catSeriesRes.data || [];
      categoryAliases = !aliasesRes.error && Array.isArray(aliasesRes.data) ? aliasesRes.data : [];
      todayIST =
        todayRes.data && typeof todayRes.data === 'string'
          ? todayRes.data
          : getISTDateString(new Date());
    } else {
      allStudents = DemoDB.getStudents()
        .filter((s) => s.role === 'student')
        .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
      roundCategories = DemoDB.getCategories()
        .filter((c) => c.section === 'round')
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      roundSeries = DemoDB.getRoundSeries ? DemoDB.getRoundSeries() : [];
      categorySeries = DemoDB.getCategorySeries ? DemoDB.getCategorySeries() : [];
      categoryAliases = DemoDB.getCategoryAliases ? DemoDB.getCategoryAliases() : [];
      todayIST = DemoDB.mockTodayIST ? await DemoDB.mockTodayIST() : getISTDateString(new Date());
    }

    const searchInput = document.getElementById('import-student-search');
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (!q) {
      filteredStudents = [...allStudents];
    } else {
      filteredStudents = allStudents.filter(
        (s) =>
          String(s.full_name || '').toLowerCase().includes(q) ||
          String(s.student_code || '').toLowerCase().includes(q)
      );
    }

    renderStudentOptions(prevStudentId);
    renderAliasCategoryOptions();
    renderCategoryAliasesList();
  } catch (err) {
    console.error('Error loading reference data for import:', err);
    showStep1Error(
      `Failed to load students, series, or round categories: ${err.message || 'Network error'}`
    );
    if (studentSelect) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Error loading students';
      studentSelect.replaceChildren(opt);
    }
  }
}

/**
 * Loads existing `student_rounds` and `results` for the selected student.
 *
 * @param {string|null} studentId
 * @param {boolean} [forceReload=false]
 */
async function ensureStudentExistingDataLoaded(studentId, forceReload = false) {
  if (!studentId) {
    selectedStudentIdLoaded = null;
    existingStudentRounds = [];
    existingStudentResults = [];
    return;
  }

  if (!forceReload && selectedStudentIdLoaded === studentId) {
    return;
  }

  isLoadingStudentData = true;
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const [roundsRes, resultsRes] = await Promise.all([
        supabase
          .from('student_rounds')
          .select(
            'id, student_id, series_id, round_number, round_date, round_type, time_taken_seconds, import_batch_id'
          )
          .eq('student_id', studentId)
          .order('round_number', { ascending: true }),
        supabase
          .from('results')
          .select(
            'id, student_id, category_id, student_round_id, correct, total, time_seconds, entry_date, note, verified_by, verified_at, corrected_by, corrected_at, import_batch_id'
          )
          .eq('student_id', studentId)
          .not('student_round_id', 'is', null),
      ]);

      if (roundsRes.error) throw new Error(roundsRes.error.message);
      if (resultsRes.error) throw new Error(resultsRes.error.message);

      existingStudentRounds = roundsRes.data || [];
      existingStudentResults = resultsRes.data || [];
      selectedStudentIdLoaded = studentId;
    } else {
      existingStudentRounds = DemoDB.getStudentRounds
        ? DemoDB.getStudentRounds(studentId, 'all')
        : [];
      existingStudentResults = DemoDB.getResultsForStudent
        ? DemoDB.getResultsForStudent(studentId).filter((r) => Boolean(r.student_round_id))
        : [];
      selectedStudentIdLoaded = studentId;
    }
  } catch (err) {
    console.error('Failed to load existing rounds/results for student:', err);
    showToast(
      'error',
      `Could not load existing database rounds for comparison: ${err.message || 'Database error'}`
    );
    existingStudentRounds = [];
    existingStudentResults = [];
    selectedStudentIdLoaded = null;
  } finally {
    isLoadingStudentData = false;
  }
}

/**
 * Loads `import_batches` for the Import History & Undo section
 */
async function loadImportBatches() {
  const container = document.getElementById('import-history-container');
  try {
    let rawBatches = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('import_batches')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw new Error(error.message);
      rawBatches = data || [];
    } else {
      rawBatches = DemoDB.getImportBatches ? DemoDB.getImportBatches() : [];
    }

    const studentById = new Map(allStudents.map((s) => [s.id, s]));
    importBatches = rawBatches.map((b) => {
      const stu = studentById.get(b.student_id);
      const isOpen =
        b.status === 'open' ||
        b.status === 'started' ||
        (!b.finished_at &&
          b.status !== 'done' &&
          b.status !== 'completed' &&
          b.status !== 'undone' &&
          !b.undone_at &&
          b.rowsImported === undefined);
      const rawRowsImported =
        b.rows_imported !== undefined
          ? b.rows_imported
          : b.rowsImported !== undefined
            ? b.rowsImported
            : b.cells_inserted !== undefined
              ? b.cells_inserted
              : null;
      return {
        ...b,
        fileName: b.file_name || b.fileName || 'scoresheet.csv',
        nameInFile: b.name_in_file ?? b.nameInFile ?? null,
        markVerified: Boolean(b.mark_verified ?? b.markVerified),
        rowsFound: Number(b.rows_found ?? b.rowsFound ?? 0),
        rowsImported: isOpen ? null : rawRowsImported,
        importedAt:
          b.created_at || b.finished_at || b.imported_at || b.importedAt || null,
        undoneAt: b.undone_at || b.undoneAt || null,
        undoReason: b.undo_reason || b.undoReason || null,
        studentName: stu ? stu.full_name : b.studentName || 'Student',
        studentCode: stu ? stu.student_code : b.studentCode || '—',
      };
    });

    renderImportHistoryTable();
  } catch (err) {
    console.error('Failed to load import_batches:', err);
    if (container) {
      const errDiv = document.createElement('div');
      errDiv.className = 'banner banner-error';
      errDiv.textContent = `Could not load import history: ${err.message || 'Database error'}`;
      container.replaceChildren(errDiv);
    }
  }
}

/**
 * Renders the unified searchable student picker dropdown & selected student pill
 */
function renderStudentOptions(selectedId = null) {
  const hiddenInput = document.getElementById('import-student-select');
  const badgeEl = document.getElementById('import-student-selected-badge');
  const clearBtn = document.getElementById('btn-clear-student-selection');
  const searchInput = document.getElementById('import-student-search');
  const dropdown = document.getElementById('import-student-dropdown');
  if (!hiddenInput) return;

  if (selectedId !== null && selectedId !== undefined) {
    hiddenInput.value = selectedId;
  }

  const activeStudent = allStudents.find((s) => s.id === hiddenInput.value) || null;
  if (badgeEl && clearBtn && searchInput) {
    if (activeStudent) {
      const levelInfo = activeStudent.level ? ` · ${activeStudent.level}` : '';
      badgeEl.textContent = `✓ ${activeStudent.full_name} (${activeStudent.student_code}${levelInfo})`;
      badgeEl.style.display = 'inline-flex';
      clearBtn.style.display = 'inline-flex';
      searchInput.placeholder = 'Type to switch student...';
    } else {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
      clearBtn.style.display = 'none';
      searchInput.placeholder = 'Search and select student by name or ID (e.g. STU101)...';
    }
  }

  if (!dropdown) return;
  dropdown.replaceChildren();

  if (filteredStudents.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.style.padding = '8px 10px';
    emptyDiv.style.fontSize = 'var(--text-xs)';
    emptyDiv.style.color = 'var(--text-muted)';
    emptyDiv.textContent = 'No matching students found.';
    dropdown.appendChild(emptyDiv);
    return;
  }

  for (const stu of filteredStudents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `import-student-option${stu.id === hiddenInput.value ? ' selected' : ''}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', stu.id === hiddenInput.value ? 'true' : 'false');

    const leftSpan = document.createElement('span');
    const statusSuffix = stu.active === false ? ' [Inactive]' : '';
    const levelInfo = stu.level ? ` · ${stu.level}` : '';
    leftSpan.textContent = `${stu.full_name} (${stu.student_code}${levelInfo})${statusSuffix}`;

    const rightSpan = document.createElement('span');
    rightSpan.className = 'num';
    rightSpan.style.fontSize = '11px';
    rightSpan.style.color =
      stu.id === hiddenInput.value ? 'var(--color-primary-text)' : 'var(--text-dim)';
    rightSpan.textContent = stu.id === hiddenInput.value ? '✓ Selected' : stu.student_code;

    btn.append(leftSpan, rightSpan);
    btn.addEventListener('click', async () => {
      await selectStudentFromPicker(stu.id);
    });
    dropdown.appendChild(btn);
  }
}

/**
 * Selects a student in the unified searchable student picker and refreshes comparison & history
 */
async function selectStudentFromPicker(studentId) {
  const hiddenInput = document.getElementById('import-student-select');
  const searchInput = document.getElementById('import-student-search');
  const dropdown = document.getElementById('import-student-dropdown');

  if (hiddenInput) hiddenInput.value = studentId || '';
  if (searchInput) {
    searchInput.value = '';
    searchInput.setAttribute('aria-expanded', 'false');
  }
  filteredStudents = [...allStudents];
  renderStudentOptions(studentId || '');

  if (dropdown) {
    dropdown.style.display = 'none';
  }

  const stu = getSelectedStudent();
  await ensureStudentExistingDataLoaded(stu ? stu.id : null);
  renderImportHistoryTable();
  if (currentCsvText) {
    await runParseAndRenderPreview(false);
  }
}

/**
 * Returns the currently selected student profile object or null
 */
function getSelectedStudent() {
  const select = document.getElementById('import-student-select');
  if (!select || !select.value) return null;
  return allStudents.find((s) => s.id === select.value) || null;
}

/**
 * Binds Step 1 interactive controls
 */
function bindStep1Listeners() {
  const pickerWrap = document.getElementById('import-student-picker');
  const searchInput = document.getElementById('import-student-search');
  const studentSelect = document.getElementById('import-student-select');
  const clearStudentBtn = document.getElementById('btn-clear-student-selection');
  const dropdown = document.getElementById('import-student-dropdown');
  const fileInput = document.getElementById('import-csv-file');
  const dateFormatSelect = document.getElementById('import-date-format');
  const startOverBtn = document.getElementById('btn-import-start-over');
  const sampleBtn = document.getElementById('btn-load-sample-csv');
  const cleanSampleBtn = document.getElementById('btn-load-clean-sample-csv');

  const openDropdown = () => {
    if (!dropdown) return;
    dropdown.style.display = 'block';
    if (searchInput) searchInput.setAttribute('aria-expanded', 'true');
  };

  const closeDropdown = () => {
    if (!dropdown) return;
    dropdown.style.display = 'none';
    if (searchInput) searchInput.setAttribute('aria-expanded', 'false');
  };

  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      renderStudentOptions(studentSelect ? studentSelect.value : '');
      openDropdown();
    });

    searchInput.addEventListener('click', () => {
      renderStudentOptions(studentSelect ? studentSelect.value : '');
      openDropdown();
    });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      const currentSelected = studentSelect ? studentSelect.value : '';
      if (!q) {
        filteredStudents = [...allStudents];
      } else {
        filteredStudents = allStudents.filter(
          (s) =>
            String(s.full_name || '').toLowerCase().includes(q) ||
            String(s.student_code || '').toLowerCase().includes(q)
        );
      }
      renderStudentOptions(currentSelected);
      openDropdown();
    });

    searchInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        closeDropdown();
      } else if (e.key === 'Enter' && filteredStudents.length > 0) {
        e.preventDefault();
        await selectStudentFromPicker(filteredStudents[0].id);
      }
    });
  }

  if (clearStudentBtn) {
    clearStudentBtn.addEventListener('click', async () => {
      await selectStudentFromPicker('');
      if (searchInput) {
        searchInput.focus();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (pickerWrap && !pickerWrap.contains(e.target)) {
      closeDropdown();
    }
  });

  if (dateFormatSelect) {
    dateFormatSelect.addEventListener('change', async () => {
      if (currentCsvText) {
        await runParseAndRenderPreview(false);
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const selectedFile = fileInput.files ? fileInput.files[0] : null;
      if (!selectedFile) return;
      promptUnsavedEditsGuard('load a different CSV file', () => {
        handleFileSelected(selectedFile);
      });
    });
  }

  if (startOverBtn) {
    startOverBtn.addEventListener('click', () => {
      promptUnsavedEditsGuard('start over', () => {
        resetImportWorkflow();
      });
    });
  }

  if (cleanSampleBtn) {
    cleanSampleBtn.addEventListener('click', () => {
      promptUnsavedEditsGuard('load the ready-to-import fixture', async () => {
        clearStep1Error();
        if (studentSelect && !studentSelect.value && allStudents.length > 0) {
          await selectStudentFromPicker(allStudents[0].id);
        }
        currentFileName = 'ready-two-block-sheet.csv';
        currentCsvText = CLEAN_READY_TWO_BLOCK_CSV;
        const metaEl = document.getElementById('import-file-meta');
        if (metaEl) {
          metaEl.textContent = `${currentFileName} (${formatNum(currentCsvText.length)} bytes)`;
        }
        await runParseAndRenderPreview(true);
        showToast(
          'info',
          'Loaded ready-to-import 2-block CSV fixture. Confirm Block 1 & Block 2 series to import.'
        );
      });
    });
  }

  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      promptUnsavedEditsGuard('load the edge-case sample fixture', async () => {
        clearStep1Error();
        if (studentSelect && !studentSelect.value && allStudents.length > 0) {
          await selectStudentFromPicker(allStudents[0].id);
        }
        currentFileName = 'sample-two-block-sheet.csv';
        currentCsvText = SAMPLE_TWO_BLOCK_CSV;
        const metaEl = document.getElementById('import-file-meta');
        if (metaEl) {
          metaEl.textContent = `${currentFileName} (${formatNum(currentCsvText.length)} bytes)`;
        }
        await runParseAndRenderPreview(true);
        showToast('info', 'Loaded 2-block CSV fixture with validation edge cases.');
      });
    });
  }
}

/**
 * Binds Step 3 Import Options (`p_mark_verified`, `p_on_date_conflict`) and Confirmation Modals
 */
function bindImportOptionsAndModals() {
  const markVerifiedCheckbox = document.getElementById('import-opt-mark-verified');
  const dateConflictSelect = document.getElementById('import-opt-date-conflict');
  const importBtn = document.getElementById('btn-import-execute');
  const proceedConfirmBtn = document.getElementById('btn-proceed-confirm-import');
  const undoForm = document.getElementById('undo-import-form');

  if (markVerifiedCheckbox) {
    markVerifiedCheckbox.addEventListener('change', () => {
      if (currentParsedResult && currentParsedResult.ok) {
        renderCurrentPreviewState();
      }
    });
  }

  if (dateConflictSelect) {
    dateConflictSelect.addEventListener('change', () => {
      if (currentParsedResult && currentParsedResult.ok) {
        renderCurrentPreviewState();
      }
    });
  }

  if (importBtn) {
    importBtn.addEventListener('click', () => {
      if (!currentExecutionPlan || !currentExecutionPlan.readyToImport || isImporting) {
        return;
      }
      openConfirmImportModal(currentExecutionPlan);
    });
  }

  if (proceedConfirmBtn) {
    proceedConfirmBtn.addEventListener('click', async () => {
      if (!currentExecutionPlan || !currentExecutionPlan.readyToImport || isImporting) {
        return;
      }
      const mismatchCheckbox = document.getElementById('confirm-name-mismatch-checkbox');
      if (mismatchCheckbox && !mismatchCheckbox.checked) {
        showToast(
          'warning',
          'Please check the student name confirmation box before importing.'
        );
        return;
      }
      const ackCheckbox = document.getElementById('confirm-acknowledgments-checkbox');
      if (ackCheckbox && !ackCheckbox.checked) {
        showToast(
          'warning',
          'Please acknowledge the warnings and adjustments list before importing.'
        );
        return;
      }
      closeModal('confirm-import-modal');
      await executePlannedImport(currentExecutionPlan);
    });
  }

  if (undoForm) {
    undoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const batchIdInput = document.getElementById('undo-import-batch-id');
      const reasonInput = document.getElementById('undo-import-reason');
      const batchId = batchIdInput ? batchIdInput.value.trim() : '';
      const reason = reasonInput ? reasonInput.value.trim() : '';

      if (!batchId) return;
      if (reason.length < 3) {
        showToast('error', 'Please enter a reason of at least 3 characters to undo this import.');
        return;
      }

      closeModal('undo-import-modal');
      await executeUndoImportBatch(batchId, reason);
    });
  }
}

/**
 * Binds Import History filter/refresh and Category Aliases form listeners
 */
function bindHistoryAndAliasesListeners() {
  const historyFilter = document.getElementById('import-history-filter');
  const refreshHistoryBtn = document.getElementById('btn-refresh-import-history');
  const addAliasForm = document.getElementById('add-alias-form');

  if (historyFilter) {
    historyFilter.addEventListener('change', () => {
      renderImportHistoryTable();
    });
  }

  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', async () => {
      await loadImportBatches();
      showToast('info', 'Import history refreshed.');
    });
  }

  if (addAliasForm) {
    addAliasForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const aliasInput = document.getElementById('new-alias-input');
      const catSelect = document.getElementById('new-alias-category-select');
      const rawAlias = aliasInput ? aliasInput.value.trim() : '';
      const catId = catSelect ? catSelect.value.trim() : '';

      const key = toMatchingKey(rawAlias);
      if (!key) {
        showToast('error', 'Please enter a valid alias text.');
        return;
      }
      if (!catId) {
        showToast('error', 'Please select a target round category.');
        return;
      }

      await saveCategoryAliasToDatabase(key, catId);
      if (aliasInput) aliasInput.value = '';
      if (catSelect) catSelect.value = '';
    });
  }
}

/**
 * Validates and reads the selected .csv file in the browser via FileReader
 */
function handleFileSelected(file) {
  clearStep1Error();
  const metaEl = document.getElementById('import-file-meta');
  if (metaEl) metaEl.textContent = '';

  if (!file) {
    currentCsvText = '';
    currentFileName = '';
    hidePreview();
    return;
  }

  const fileName = String(file.name || '');
  const isCsvExt = /\.csv$/i.test(fileName);
  const allowedMimeTypes = new Set([
    '',
    'text/csv',
    'text/plain',
    'application/csv',
    'application/vnd.ms-excel',
    'text/comma-separated-values',
  ]);
  const mimeLower = String(file.type || '').toLowerCase();

  if (!isCsvExt || (mimeLower && !allowedMimeTypes.has(mimeLower))) {
    currentCsvText = '';
    currentFileName = '';
    hidePreview();
    showStep1Error(
      `Unsupported file type ("${fileName}"). Please select a valid .csv file (comma-separated values).`
    );
    return;
  }

  if (file.size > MAX_CSV_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    currentCsvText = '';
    currentFileName = '';
    hidePreview();
    showStep1Error(
      `File "${fileName}" is ${sizeMb} MB, which exceeds the 2 MB maximum limit. Please choose a smaller .csv file.`
    );
    return;
  }

  if (file.size === 0) {
    currentCsvText = '';
    currentFileName = '';
    hidePreview();
    showStep1Error(`File "${fileName}" is empty (0 bytes).`);
    return;
  }

  const kb = Math.max(1, Math.round(file.size / 1024));
  if (metaEl) {
    metaEl.textContent = `${fileName} (${kb} KB)`;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = typeof e.target?.result === 'string' ? e.target.result : '';
    currentCsvText = text;
    currentFileName = fileName;
    await runParseAndRenderPreview(true);
  };
  reader.onerror = () => {
    showStep1Error(`Could not read file "${fileName}" in browser.`);
    hidePreview();
  };
  reader.readAsText(file);
}

/**
 * Initializes default per-block UI state and clears preview edits when a new CSV file is loaded:
 * - Pre-selects the SUGGESTED simulator series (`Old simulator` or `New simulator` or `""`)
 * - Leaves `confirmed = false` so the admin must explicitly confirm each block
 * - Initializes empty `adminMappings`
 * - Resets `previewEditState`, `expandedRoundKeys`, and active inline editors
 */
function initBlockUiStateForParsedSheet(parsed) {
  const nextState = {};
  for (const blk of parsed.blocks || []) {
    const suggestion = suggestSeriesForBlock(blk.categories, roundSeries);
    nextState[blk.blockNumber] = {
      seriesId: suggestion.suggestedSeriesId || '',
      confirmed: false,
      adminMappings: {},
    };
  }
  blockUiState = nextState;
  previewEditState = createEmptyEditState();
  expandedRoundKeys = new Set();
  activeRoundEditor = null;
  activeCellEditor = null;
  hideUnsavedEditsWarning();
}

/**
 * Runs parseScoreSheetCsv + buildImportPreviewState and renders the full preview
 *
 * @param {boolean} [resetBlockState=false] - Whether to reset per-block series/category selections and edits
 */
async function runParseAndRenderPreview(resetBlockState = false) {
  clearStep1Error();

  const dateFormatSelect = document.getElementById('import-date-format');
  const dateFormat = dateFormatSelect ? dateFormatSelect.value : 'auto';
  const selectedStudent = getSelectedStudent();

  if (!selectedStudent) {
    showStep1Error('Please select a student in Step 1 to compare and import their score sheet.');
  }

  await ensureStudentExistingDataLoaded(selectedStudent ? selectedStudent.id : null);

  const parsed = parseScoreSheetCsv(currentCsvText, {
    roundCategories,
    dateFormat,
    todayIST: todayIST || getISTDateString(new Date()),
    selectedStudentName: selectedStudent ? selectedStudent.full_name : '',
  });

  currentParsedResult = parsed;

  if (!parsed.ok) {
    hidePreview();
    showStep1Error(parsed.error || 'Layout not recognised.');
    return;
  }

  if (resetBlockState || Object.keys(blockUiState).length === 0) {
    initBlockUiStateForParsedSheet(parsed);
  }

  renderCurrentPreviewState();
}

/**
 * Re-computes Phase 4c-2a/2b/2c/2d live preview state, edits list, and execution plan,
 * and updates all DOM sections while keeping `currentParsedResult` immutable for resets.
 */
function renderCurrentPreviewState() {
  if (!currentParsedResult || !currentParsedResult.ok) return;

  const selectedStudent = getSelectedStudent();
  const markVerified = Boolean(document.getElementById('import-opt-mark-verified')?.checked);
  const onDateConflict =
    document.getElementById('import-opt-date-conflict')?.value === 'skip'
      ? 'skip'
      : 'use_existing';

  const previewState = buildImportPreviewState(currentParsedResult, {
    selectedStudent,
    roundSeries,
    categorySeries,
    roundCategories,
    categoryAliases,
    existingStudentRounds,
    existingResults: existingStudentResults,
    blockUiState,
    editState: previewEditState,
  });

  const effectiveParsed = previewState.effectiveParsed || currentParsedResult;

  const executionPlan = buildImportExecutionPlan(effectiveParsed, previewState, {
    selectedStudent,
    fileName: currentFileName,
    markVerified,
    onDateConflict,
    editState: previewEditState,
  });

  currentPreviewState = previewState;
  currentExecutionPlan = executionPlan;

  const previewContainer = document.getElementById('import-preview-container');
  if (previewContainer) {
    previewContainer.style.display = 'block';
  }

  renderNeedsAttentionSection(effectiveParsed, previewState, selectedStudent);
  renderSummaryCards(effectiveParsed, selectedStudent);
  renderComparisonSummarySection(previewState, selectedStudent);
  renderBlocksSection(effectiveParsed, previewState, selectedStudent);
  renderReadinessAndActionState(previewState, executionPlan, selectedStudent);
}

/**
 * Opens the inline Round Editor for a given block and round, optionally focusing a specific field,
 * and scrolls smoothly to the round row.
 *
 * @param {number} blockNumber
 * @param {number} roundNumber
 * @param {'date'|'type'|'time'|'skip'|null} [focusField=null]
 */
function openRoundEditorAndScroll(blockNumber, roundNumber, focusField = null) {
  activeRoundEditor = {
    blockNumber: Number(blockNumber),
    roundNumber: Number(roundNumber),
    focusField,
  };
  renderCurrentPreviewState();

  requestAnimationFrame(() => {
    const editorEl = document.getElementById(
      `round-editor-${blockNumber}-${roundNumber}`
    );
    if (editorEl) {
      editorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      let targetInput = null;
      if (focusField === 'date') {
        targetInput = editorEl.querySelector('[data-field="round-date"]');
      } else if (focusField === 'time') {
        targetInput = editorEl.querySelector('[data-field="round-time"]');
      } else if (focusField === 'type') {
        targetInput = editorEl.querySelector('[data-field="round-type-select"]');
      }
      if (targetInput && typeof targetInput.focus === 'function') {
        targetInput.focus();
      }
    }
  });
}

/**
 * Expands the round's cell drawer, opens the inline Cell Editor for a given cell, and scrolls to it.
 *
 * @param {number} blockNumber
 * @param {number} roundNumber
 * @param {number} rowIndex
 */
function openCellEditorAndScroll(blockNumber, roundNumber, rowIndex) {
  const key = `${blockNumber}-${roundNumber}`;
  expandedRoundKeys.add(key);
  activeCellEditor = {
    blockNumber: Number(blockNumber),
    roundNumber: Number(roundNumber),
    rowIndex: Number(rowIndex),
  };
  renderCurrentPreviewState();

  requestAnimationFrame(() => {
    const editorEl = document.getElementById(
      `cell-editor-${blockNumber}-${roundNumber}-${rowIndex}`
    );
    if (editorEl) {
      editorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstInput = editorEl.querySelector('input[type="number"], input[type="text"]');
      if (firstInput && typeof firstInput.focus === 'function') {
        firstInput.focus();
      }
    }
  });
}

/**
 * Resets a single round edit back to its original sheet value and triggers live recalculation.
 *
 * @param {number} blockNumber
 * @param {number} roundNumber
 */
function resetRoundEditToSheetValue(blockNumber, roundNumber) {
  const key = `${blockNumber}-${roundNumber}`;
  if (previewEditState.rounds && previewEditState.rounds[key]) {
    delete previewEditState.rounds[key];
  }
  if (
    activeRoundEditor &&
    activeRoundEditor.blockNumber === Number(blockNumber) &&
    activeRoundEditor.roundNumber === Number(roundNumber)
  ) {
    activeRoundEditor = null;
  }
  renderCurrentPreviewState();
  showToast('info', `Reset Block ${blockNumber} Round ${roundNumber} to original sheet values.`);
}

/**
 * Resets a single cell edit back to its original sheet value and triggers live recalculation.
 *
 * @param {number} blockNumber
 * @param {number} roundNumber
 * @param {number} rowIndex
 */
function resetCellEditToSheetValue(blockNumber, roundNumber, rowIndex) {
  const key = `${blockNumber}-${roundNumber}-${rowIndex}`;
  if (previewEditState.cells && previewEditState.cells[key]) {
    delete previewEditState.cells[key];
  }
  if (
    activeCellEditor &&
    activeCellEditor.blockNumber === Number(blockNumber) &&
    activeCellEditor.roundNumber === Number(roundNumber) &&
    activeCellEditor.rowIndex === Number(rowIndex)
  ) {
    activeCellEditor = null;
  }
  renderCurrentPreviewState();
  showToast('info', `Reset cell in Block ${blockNumber} Round ${roundNumber} to sheet value.`);
}

/**
 * Resets all preview edits (rounds and cells) back to the original CSV sheet values.
 */
function resetAllPreviewEditsToSheetValues() {
  previewEditState = createEmptyEditState();
  activeRoundEditor = null;
  activeCellEditor = null;
  hideUnsavedEditsWarning();
  renderCurrentPreviewState();
  showToast('info', 'All preview edits have been reset to original sheet values.');
}

/**
 * Finds the original parsed cell rowIndex in `currentParsedResult` corresponding to an attention item ref
 */
function findCellByRefInBlock(blockNumber, roundNumber, ref) {
  if (!currentParsedResult || !Array.isArray(currentParsedResult.blocks) || !ref) return null;
  const blk = currentParsedResult.blocks.find((b) => b.blockNumber === Number(blockNumber));
  if (!blk) return null;
  const rnd = (blk.rounds || []).find((r) => r.roundNumber === Number(roundNumber));
  if (!rnd) return null;
  return (
    (rnd.cells || []).find((c) => c.scoreRef === ref || c.timeRef === ref) || null
  );
}

/**
 * Strips duplicate cell reference mentions from an attention message when the cell reference
 * is already displayed as a dedicated chip on the left of the row.
 *
 * @param {string} message
 * @param {string|null} ref
 * @returns {string}
 */
function stripDuplicateCellRefFromMessage(message, ref) {
  const rawMsg = String(message || '');
  const cleanRef = String(ref || '').trim();
  if (!cleanRef) return rawMsg;

  const escapedRef = cleanRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return rawMsg
    .replace(new RegExp(`\\s+at\\s+${escapedRef}\\b`, 'gi'), '')
    .replace(new RegExp(`\\s+in\\s+${escapedRef}\\b`, 'gi'), '')
    .replace(new RegExp(`\\s*\\(${escapedRef}\\)`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Renders the "Needs Attention" triage panel at the top of Step 2:
 * - Heading count matches the rows (e.g. "5 warnings, 1 info")
 * - Rows grouped by severity (Blocking Errors, Warnings, Info)
 * - "Show info lines" toggle
 * - Severity badge, block & round chip, and cell chip on the left, message text left-aligned right after them
 * - Quick action "Fix" button on rounds with date/time problems and on unreadable cells
 */
function renderNeedsAttentionSection(parsed, previewState, selectedStudent) {
  const section = document.getElementById('import-attention-section');
  if (!section) return;
  section.replaceChildren();

  const items = [...(previewState.combinedAttention || [])];
  if (!selectedStudent) {
    items.unshift({
      severity: 'error',
      type: 'no_student_selected',
      blockNumber: null,
      roundNumber: null,
      ref: null,
      message:
        'No student is currently selected in Step 1. Choose a student above to compare with existing database rounds and enable import.',
    });
  }

  const errorItems = items.filter((i) => i.severity === 'error');
  const warningItems = items.filter((i) => i.severity === 'warning');
  const infoItems = items.filter((i) => i.severity === 'info');

  const errorCount = errorItems.length;
  const warningCount = warningItems.length;
  const infoCount = infoItems.length;

  const countParts = [];
  if (errorCount > 0) {
    countParts.push(`${formatNum(errorCount)} blocking error${errorCount === 1 ? '' : 's'}`);
  }
  if (warningCount > 0) {
    countParts.push(`${formatNum(warningCount)} warning${warningCount === 1 ? '' : 's'}`);
  }
  if (infoCount > 0) {
    countParts.push(`${formatNum(infoCount)} info`);
  }
  const headingCountText = countParts.length > 0 ? countParts.join(', ') : '0 issues';

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-3)';
  headerRow.style.marginBottom = 'var(--space-3)';

  const titleEl = document.createElement('h2');
  titleEl.id = 'attention-heading';
  titleEl.style.fontSize = 'var(--text-lg)';
  titleEl.textContent = `Needs Attention (${headingCountText})`;

  const controlsWrap = document.createElement('div');
  controlsWrap.style.display = 'flex';
  controlsWrap.style.alignItems = 'center';
  controlsWrap.style.gap = 'var(--space-2)';
  controlsWrap.style.flexWrap = 'wrap';

  const errBadge = document.createElement('span');
  errBadge.className = 'badge num';
  errBadge.style.backgroundColor = 'var(--color-danger-subtle)';
  errBadge.style.color = 'var(--color-danger-text)';
  errBadge.textContent = `${formatNum(errorCount)} Blocking`;

  const warnBadge = document.createElement('span');
  warnBadge.className = 'badge badge-warning num';
  warnBadge.textContent = `${formatNum(warningCount)} Warning${warningCount === 1 ? '' : 's'}`;

  const infoBadge = document.createElement('span');
  infoBadge.className = 'badge badge-inactive num';
  infoBadge.textContent = `${formatNum(infoCount)} Info`;

  controlsWrap.append(errBadge, warnBadge, infoBadge);

  if (infoCount > 0) {
    const toggleLabel = document.createElement('label');
    toggleLabel.style.display = 'inline-flex';
    toggleLabel.style.alignItems = 'center';
    toggleLabel.style.gap = '6px';
    toggleLabel.style.fontSize = 'var(--text-xs)';
    toggleLabel.style.fontWeight = '600';
    toggleLabel.style.color = 'var(--text-main)';
    toggleLabel.style.cursor = 'pointer';
    toggleLabel.style.marginLeft = 'var(--space-2)';

    const toggleCb = document.createElement('input');
    toggleCb.type = 'checkbox';
    toggleCb.id = 'toggle-show-info-lines';
    toggleCb.checked = Boolean(showInfoLines);
    toggleCb.addEventListener('change', () => {
      showInfoLines = toggleCb.checked;
      renderNeedsAttentionSection(parsed, previewState, selectedStudent);
    });

    const toggleText = document.createElement('span');
    toggleText.textContent = `Show info lines (${formatNum(infoCount)})`;
    toggleLabel.append(toggleCb, toggleText);
    controlsWrap.appendChild(toggleLabel);
  }

  headerRow.append(titleEl, controlsWrap);
  section.appendChild(headerRow);

  if (items.length === 0) {
    const okBanner = document.createElement('div');
    okBanner.className = 'banner banner-success';
    okBanner.textContent =
      'All simulator series confirmations, category resolutions, dates, score ratios, time formats, and database comparisons passed with zero warnings.';
    section.appendChild(okBanner);
    return;
  }

  const dateProblemTypes = new Set([
    'missing_date',
    'unreadable_date',
    'future_date',
    'before_2020',
    'date_out_of_order',
    'same_date_rounds',
    'db_round_date_differs',
  ]);
  const timeProblemTypes = new Set([
    'time_taken_exceeds_limit',
    'unreadable_time_taken',
  ]);

  const renderGroup = (groupTitle, groupItems, severityKey) => {
    if (groupItems.length === 0) return;

    const groupWrap = document.createElement('div');
    groupWrap.className = 'import-attention-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'import-attention-group-header';
    const gTitleSpan = document.createElement('span');
    gTitleSpan.textContent = `${groupTitle} (${formatNum(groupItems.length)})`;
    groupHeader.appendChild(gTitleSpan);
    groupWrap.appendChild(groupHeader);

    const list = document.createElement('div');
    list.className = 'import-attention-list';

    for (const item of groupItems) {
      const row = document.createElement('div');
      row.className = `import-attention-item import-attention-${severityKey}`;

      const chipsContainer = document.createElement('div');
      chipsContainer.className = 'import-attention-chips';

      const sevTag = document.createElement('span');
      sevTag.className = 'badge num';
      if (item.severity === 'error') {
        sevTag.style.backgroundColor = 'var(--color-danger-subtle)';
        sevTag.style.color = 'var(--color-danger-text)';
        sevTag.textContent = 'BLOCKING';
      } else if (item.severity === 'warning') {
        sevTag.className = 'badge badge-warning num';
        sevTag.textContent = 'WARNING';
      } else {
        sevTag.className = 'badge badge-inactive num';
        sevTag.textContent = 'INFO';
      }
      chipsContainer.appendChild(sevTag);

      if (item.blockNumber !== null && item.blockNumber !== undefined) {
        const scopeBadge = document.createElement('span');
        scopeBadge.className = 'badge badge-inactive num';
        scopeBadge.textContent =
          item.roundNumber !== null && item.roundNumber !== undefined
            ? `Block ${item.blockNumber} · Round ${item.roundNumber}`
            : `Block ${item.blockNumber}`;
        chipsContainer.appendChild(scopeBadge);
      }

      if (item.ref) {
        const refCode = document.createElement('code');
        refCode.className = 'import-cell-ref num';
        refCode.textContent = item.ref;
        chipsContainer.appendChild(refCode);
      }

      const msgSpan = document.createElement('div');
      msgSpan.className = 'import-attention-msg';
      msgSpan.style.display = 'flex';
      msgSpan.style.alignItems = 'center';
      msgSpan.style.justifyContent = 'space-between';
      msgSpan.style.gap = 'var(--space-2)';
      msgSpan.style.flexWrap = 'wrap';

      const textSpan = document.createElement('span');
      textSpan.textContent = stripDuplicateCellRefFromMessage(item.message, item.ref);
      msgSpan.appendChild(textSpan);

      // Quick action "Fix" button for round date/time problems or unreadable cells
      if (item.blockNumber && item.roundNumber) {
        if (dateProblemTypes.has(item.type)) {
          const fixBtn = document.createElement('button');
          fixBtn.type = 'button';
          fixBtn.className = 'btn btn-outline btn-sm';
          fixBtn.style.padding = '2px 8px';
          fixBtn.style.minHeight = '24px';
          fixBtn.style.fontSize = '11px';
          fixBtn.textContent = 'Fix Date';
          fixBtn.addEventListener('click', () => {
            openRoundEditorAndScroll(item.blockNumber, item.roundNumber, 'date');
          });
          msgSpan.appendChild(fixBtn);
        } else if (timeProblemTypes.has(item.type)) {
          const fixBtn = document.createElement('button');
          fixBtn.type = 'button';
          fixBtn.className = 'btn btn-outline btn-sm';
          fixBtn.style.padding = '2px 8px';
          fixBtn.style.minHeight = '24px';
          fixBtn.style.fontSize = '11px';
          fixBtn.textContent = 'Fix Time';
          fixBtn.addEventListener('click', () => {
            openRoundEditorAndScroll(item.blockNumber, item.roundNumber, 'time');
          });
          msgSpan.appendChild(fixBtn);
        } else if (item.type === 'unreadable_cell' && item.ref) {
          const targetCell = findCellByRefInBlock(item.blockNumber, item.roundNumber, item.ref);
          if (targetCell) {
            const fixCellBtn = document.createElement('button');
            fixCellBtn.type = 'button';
            fixCellBtn.className = 'btn btn-outline btn-sm';
            fixCellBtn.style.padding = '2px 8px';
            fixCellBtn.style.minHeight = '24px';
            fixCellBtn.style.fontSize = '11px';
            fixCellBtn.textContent = 'Fix Cell';
            fixCellBtn.addEventListener('click', () => {
              openCellEditorAndScroll(item.blockNumber, item.roundNumber, targetCell.rowIndex);
            });
            msgSpan.appendChild(fixCellBtn);
          }
        }
      }

      row.append(chipsContainer, msgSpan);
      list.appendChild(row);
    }

    groupWrap.appendChild(list);
    section.appendChild(groupWrap);
  };

  renderGroup('Blocking Errors', errorItems, 'error');
  renderGroup('Warnings', warningItems, 'warning');
  if (showInfoLines && infoItems.length > 0) {
    renderGroup('Info Lines', infoItems, 'info');
  }
}

/**
 * Helper to build a non-wrapping metric column (label above number, short unit beneath)
 */
function createMetricColumn(label, value, unit) {
  const col = document.createElement('div');
  col.className = 'import-metric-col';

  const lblEl = document.createElement('span');
  lblEl.className = 'import-metric-label';
  lblEl.textContent = label;

  const numEl = document.createElement('span');
  numEl.className = 'import-metric-number num';
  numEl.textContent = typeof value === 'number' ? formatNum(value) : String(value);

  const unitEl = document.createElement('span');
  unitEl.className = 'import-metric-unit';
  unitEl.textContent = unit;

  col.append(lblEl, numEl, unitEl);
  return col;
}

/**
 * Normalizes month abbreviations in any date string so "Sept" is always written as "Sep"
 */
function normalizeShortMonths(str) {
  return String(str || '').replace(/\bSept\b/g, 'Sep');
}

/**
 * Renders the 4 Overview Summary Cards with label above number, short unit beneath,
 * thousands separators, consistent 3-letter month names (Sep, not Sept), and live skipped counts.
 */
function renderSummaryCards(parsed, selectedStudent) {
  const container = document.getElementById('import-summary-cards');
  if (!container) return;
  container.replaceChildren();

  // Card 1: Blocks & Rounds per block (label above number, short unit beneath)
  const card1 = document.createElement('div');
  card1.className = 'stat-card';

  const c1Split = document.createElement('div');
  c1Split.className = 'import-metrics-split';
  c1Split.append(
    createMetricColumn(
      'Blocks',
      formatNum(parsed.summary.blockCount),
      parsed.summary.blockCount === 1 ? 'block detected' : 'blocks detected'
    ),
    createMetricColumn(
      'Rounds',
      formatNum(parsed.summary.totalRounds),
      parsed.summary.totalRounds === 1 ? 'active round' : 'active rounds'
    )
  );

  const c1Sub = document.createElement('div');
  c1Sub.style.fontSize = 'var(--text-xs)';
  c1Sub.style.color = 'var(--text-muted)';
  c1Sub.style.marginTop = 'var(--space-2)';
  c1Sub.style.display = 'flex';
  c1Sub.style.flexWrap = 'wrap';
  c1Sub.style.gap = 'var(--space-2)';
  c1Sub.className = 'num';
  for (const b of parsed.summary.blockSummaries) {
    const bChip = document.createElement('span');
    bChip.style.whiteSpace = 'nowrap';
    const skipSuffix = b.skippedRoundCount > 0 ? ` (${formatNum(b.skippedRoundCount)} skipped)` : '';
    bChip.textContent = `Block ${b.blockNumber}: ${formatNum(b.roundCount)} round${b.roundCount === 1 ? '' : 's'}${skipSuffix}`;
    c1Sub.appendChild(bChip);
  }
  card1.append(c1Split, c1Sub);

  // Card 2: Date Range per block
  const card2 = document.createElement('div');
  card2.className = 'stat-card';
  const c2Label = document.createElement('span');
  c2Label.className = 'import-metric-label';
  c2Label.textContent = `Date Range (${parsed.resolvedDateFormat})`;
  const c2List = document.createElement('div');
  c2List.style.display = 'flex';
  c2List.style.flexDirection = 'column';
  c2List.style.gap = '4px';
  c2List.style.marginTop = 'var(--space-2)';
  for (const b of parsed.summary.blockSummaries) {
    const line = document.createElement('div');
    line.style.fontSize = 'var(--text-xs)';
    line.style.fontWeight = '600';
    line.className = 'num';
    const rangeText =
      b.minDate && b.maxDate
        ? `${normalizeShortMonths(formatDisplayDateIST(b.minDate))} – ${normalizeShortMonths(formatDisplayDateIST(b.maxDate))}`
        : 'No valid dates';
    line.textContent = `Block ${b.blockNumber}: ${rangeText}`;
    c2List.appendChild(line);
  }
  const c2Sub = document.createElement('div');
  c2Sub.style.fontSize = '11px';
  c2Sub.style.color = 'var(--text-dim)';
  c2Sub.style.marginTop = '6px';
  c2Sub.className = 'num';
  c2Sub.textContent = `IST limit: 01 Jan 2020 – ${normalizeShortMonths(formatDisplayDateIST(parsed.todayIST))}`;
  card2.append(c2Label, c2List, c2Sub);

  // Card 3: Total Cells by Status
  const tc = parsed.summary.totalCells;
  const card3 = document.createElement('div');
  card3.className = 'stat-card';

  const c3Metric = createMetricColumn(
    'OK Score Cells',
    formatNum(tc.ok),
    tc.ok === 1 ? 'valid score cell' : 'valid score cells'
  );

  const c3Sub = document.createElement('div');
  c3Sub.style.fontSize = 'var(--text-xs)';
  c3Sub.style.color = 'var(--text-muted)';
  c3Sub.style.marginTop = 'var(--space-2)';
  c3Sub.style.display = 'flex';
  c3Sub.style.flexWrap = 'wrap';
  c3Sub.style.gap = 'var(--space-2)';
  c3Sub.className = 'num';

  const cellBreakdownItems = [
    `${formatNum(tc.empty)} empty`,
    `${formatNum(tc.note)} note${tc.note === 1 ? '' : 's'}`,
    `${formatNum(tc.unreadable)} unreadable`,
  ];
  if (tc.skipped > 0) {
    cellBreakdownItems.push(`${formatNum(tc.skipped)} skipped`);
  }

  cellBreakdownItems.forEach((txt) => {
    const sp = document.createElement('span');
    sp.style.whiteSpace = 'nowrap';
    sp.textContent = txt;
    c3Sub.appendChild(sp);
  });
  card3.append(c3Metric, c3Sub);

  // Card 4: Student Name in File vs Selected Student
  const card4 = document.createElement('div');
  card4.className = 'stat-card';
  const c4Label = document.createElement('span');
  c4Label.className = 'import-metric-label';
  c4Label.textContent = 'Student Name Check';

  const c4Val = document.createElement('div');
  c4Val.style.fontSize = 'var(--text-base)';
  c4Val.style.fontWeight = '700';
  c4Val.style.marginTop = 'var(--space-1)';
  if (parsed.studentNameInFile) {
    c4Val.textContent = `${parsed.studentNameInFile}`;
  } else {
    c4Val.style.color = 'var(--text-muted)';
    c4Val.textContent = 'Not found in top rows';
  }

  const c4Sub = document.createElement('div');
  c4Sub.style.fontSize = 'var(--text-xs)';
  c4Sub.style.marginTop = '6px';
  const refPrefix = parsed.studentNameCellRef ? `Cell ${parsed.studentNameCellRef} · ` : '';
  if (!selectedStudent) {
    c4Sub.style.color = 'var(--color-danger-text)';
    c4Sub.textContent = `${refPrefix}Select a student in Step 1 to verify`;
  } else if (parsed.studentNameMatchesSelected === true) {
    c4Sub.style.color = 'var(--color-success-text)';
    c4Sub.textContent = `${refPrefix}✓ Matches ${selectedStudent.full_name} (${selectedStudent.student_code})`;
  } else if (parsed.studentNameMatchesSelected === false) {
    c4Sub.style.color = 'var(--color-warning-text)';
    c4Sub.textContent = `${refPrefix}⚠️ Differs from ${selectedStudent.full_name} (${selectedStudent.student_code})`;
  } else {
    c4Sub.style.color = 'var(--text-muted)';
    c4Sub.textContent = `Selected: ${selectedStudent.full_name} (${selectedStudent.student_code})`;
  }
  card4.append(c4Label, c4Val, c4Sub);

  container.append(card1, card2, card3, card4);
}

/**
 * Renders the overall Existing Database Comparison Summary section (Phase 4c-2a)
 */
function renderComparisonSummarySection(previewState, selectedStudent) {
  const section = document.getElementById('import-comparison-summary-section');
  if (!section) return;
  section.replaceChildren();

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-2)';
  headerRow.style.marginBottom = 'var(--space-3)';

  const h2 = document.createElement('h2');
  h2.id = 'comparison-summary-heading';
  h2.style.fontSize = 'var(--text-lg)';
  h2.textContent = 'Database Comparison & Resolution Summary';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'badge num';
  if (previewState.allBlocksReady && selectedStudent) {
    statusBadge.classList.add('badge-success');
    statusBadge.textContent = '✓ All Series Confirmed & Categories Resolved';
  } else {
    statusBadge.classList.add('badge-warning');
    statusBadge.textContent = 'Action Required Before Import';
  }

  headerRow.append(h2, statusBadge);
  section.appendChild(headerRow);

  if (!selectedStudent) {
    const info = document.createElement('div');
    info.className = 'banner banner-warning';
    info.textContent =
      'Select a student in Step 1 to compare this CSV score sheet against their existing rounds and results in the database.';
    section.appendChild(info);
    return;
  }

  const rTotals = previewState.totals.rounds;
  const cTotals = previewState.totals.cells;

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
  grid.style.gap = 'var(--space-3)';

  // Box 1: Series Confirmation Status
  const boxSeries = document.createElement('div');
  boxSeries.style.padding = 'var(--space-3)';
  boxSeries.style.backgroundColor = 'var(--bg-surface-subtle)';
  boxSeries.style.borderRadius = 'var(--radius-sm)';
  boxSeries.style.border = '1px solid var(--border-hairline)';

  const bsTitle = document.createElement('div');
  bsTitle.className = 'import-metric-label';
  bsTitle.textContent = '1. Simulator Series per Block';
  boxSeries.appendChild(bsTitle);

  for (const br of previewState.blockReports) {
    const line = document.createElement('div');
    line.style.fontSize = 'var(--text-xs)';
    line.style.marginTop = '6px';
    line.style.display = 'flex';
    line.style.justifyContent = 'space-between';
    line.style.alignItems = 'center';
    line.style.gap = '8px';

    const left = document.createElement('span');
    left.style.fontWeight = '600';
    left.textContent = `Block ${br.blockNumber}: ${br.seriesName || 'Not selected'}`;

    const tag = document.createElement('span');
    tag.className = `badge ${br.seriesConfirmed && br.seriesId ? 'badge-success' : 'badge-warning'} num`;
    tag.textContent = br.seriesConfirmed && br.seriesId ? 'Confirmed' : 'Unconfirmed';

    line.append(left, tag);
    boxSeries.appendChild(line);
  }

  // Box 2: Category Resolution Status
  const boxCats = document.createElement('div');
  boxCats.style.padding = 'var(--space-3)';
  boxCats.style.backgroundColor = 'var(--bg-surface-subtle)';
  boxCats.style.borderRadius = 'var(--radius-sm)';
  boxCats.style.border = '1px solid var(--border-hairline)';

  const bcTitle = document.createElement('div');
  bcTitle.className = 'import-metric-label';
  bcTitle.textContent = '2. Category Resolution';
  boxCats.appendChild(bcTitle);

  for (const br of previewState.blockReports) {
    const sc = br.categoryResolution.summaryCounts;
    const line = document.createElement('div');
    line.style.fontSize = 'var(--text-xs)';
    line.style.marginTop = '6px';
    line.className = 'num';
    const unresolvedText =
      sc.unresolved > 0 ? ` · ${formatNum(sc.unresolved)} unresolved` : ' · 0 unresolved';
    line.textContent = `Block ${br.blockNumber}: ${formatNum(sc.inSelectedSeries)} in series, ${formatNum(
      sc.inOtherSeriesOnly
    )} in other series, ${formatNum(sc.mappedByAdmin + sc.createHistorical + sc.skippedByAdmin)} admin-resolved${unresolvedText}`;
    boxCats.appendChild(line);
  }

  // Box 3: Round Comparison Totals
  const boxRounds = document.createElement('div');
  boxRounds.style.padding = 'var(--space-3)';
  boxRounds.style.backgroundColor = 'var(--bg-surface-subtle)';
  boxRounds.style.borderRadius = 'var(--radius-sm)';
  boxRounds.style.border = '1px solid var(--border-hairline)';

  const brTitle = document.createElement('div');
  brTitle.className = 'import-metric-label';
  brTitle.textContent = '3. Round Comparison vs DB';
  const brBody = document.createElement('div');
  brBody.style.fontSize = 'var(--text-xs)';
  brBody.style.marginTop = '6px';
  brBody.style.display = 'flex';
  brBody.style.flexDirection = 'column';
  brBody.style.gap = '3px';
  brBody.className = 'num';

  const rLines = [
    `• ${formatNum(rTotals.newRounds)} new round${rTotals.newRounds === 1 ? '' : 's'} (not in DB yet)`,
    `• ${formatNum(rTotals.existingIdentical)} existing round${rTotals.existingIdentical === 1 ? '' : 's'} with identical scores`,
    `• ${formatNum(rTotals.existingAddsCells)} existing round${rTotals.existingAddsCells === 1 ? '' : 's'} where CSV adds missing scores`,
    `• ${formatNum(rTotals.existingWithConflicts)} existing round${rTotals.existingWithConflicts === 1 ? '' : 's'} with value/date differences`,
    `• ${formatNum(rTotals.dbOnlyRounds)} round${rTotals.dbOnlyRounds === 1 ? '' : 's'} in DB only (not in sheet — kept untouched)`,
  ];
  rLines.forEach((txt) => {
    const d = document.createElement('div');
    d.textContent = txt;
    brBody.appendChild(d);
  });
  boxRounds.append(brTitle, brBody);

  // Box 4: Cell Comparison Totals (Existing Data Never Overwritten)
  const boxCells = document.createElement('div');
  boxCells.style.padding = 'var(--space-3)';
  boxCells.style.backgroundColor = 'var(--bg-surface-subtle)';
  boxCells.style.borderRadius = 'var(--radius-sm)';
  boxCells.style.border = '1px solid var(--border-hairline)';

  const bcelTitle = document.createElement('div');
  bcelTitle.className = 'import-metric-label';
  bcelTitle.textContent = '4. Score Cell Comparison (Safe Merge)';
  const bcelBody = document.createElement('div');
  bcelBody.style.fontSize = 'var(--text-xs)';
  bcelBody.style.marginTop = '6px';
  bcelBody.style.display = 'flex';
  bcelBody.style.flexDirection = 'column';
  bcelBody.style.gap = '3px';
  bcelBody.className = 'num';

  const cLines = [
    `• ${formatNum(cTotals.newCells)} new score${cTotals.newCells === 1 ? '' : 's'} (will be inserted)`,
    `• ${formatNum(cTotals.identicalCells)} identical score${cTotals.identicalCells === 1 ? '' : 's'} (already in DB)`,
    `• ${formatNum(cTotals.conflictCells)} differing score${cTotals.conflictCells === 1 ? '' : 's'} (DB kept, never overwritten)`,
    `• ${formatNum(cTotals.protectedConflictCells)} protected Verified/Corrected conflict${
      cTotals.protectedConflictCells === 1 ? '' : 's'
    } (locked in DB)`,
    `• ${formatNum(cTotals.dbOnlyCells)} score${cTotals.dbOnlyCells === 1 ? '' : 's'} in DB only (kept untouched)`,
  ];
  cLines.forEach((txt) => {
    const d = document.createElement('div');
    d.textContent = txt;
    bcelBody.appendChild(d);
  });
  boxCells.append(bcelTitle, bcelBody);

  grid.append(boxSeries, boxCats, boxRounds, boxCells);
  section.appendChild(grid);
}

/**
 * Renders each detected block with:
 * 1. Explicit Simulator Series Picker & Confirmation Banner
 * 2. Interactive Category Mapping & Resolution Table (with "also save as alias")
 * 3. Round-by-Round & Cell-by-Cell Comparison Table (with Phase 4c-2d inline Round & Cell Editors)
 */
function renderBlocksSection(parsed, previewState, selectedStudent) {
  const container = document.getElementById('import-blocks-container');
  if (!container) return;
  container.replaceChildren();

  for (let i = 0; i < parsed.blocks.length; i++) {
    const blk = parsed.blocks[i];
    const blockReport =
      previewState.blockReports.find((br) => br.blockNumber === blk.blockNumber) ||
      previewState.blockReports[i];

    const blockCard = document.createElement('section');
    blockCard.className = 'card';
    blockCard.style.marginBottom = 'var(--space-6)';

    // Block Title Header
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.flexWrap = 'wrap';
    header.style.gap = 'var(--space-3)';
    header.style.marginBottom = 'var(--space-4)';
    header.style.paddingBottom = 'var(--space-3)';
    header.style.borderBottom = '1px solid var(--border-hairline)';

    const leftWrap = document.createElement('div');
    const h2 = document.createElement('h2');
    h2.style.fontSize = 'var(--text-lg)';
    h2.textContent = `Block ${blk.blockNumber} (CSV Rows ${formatNum(blk.startRowNumber)}–${formatNum(blk.endRowNumber)})`;
    const sub = document.createElement('p');
    sub.style.fontSize = 'var(--text-xs)';
    sub.style.color = 'var(--text-muted)';
    sub.className = 'num';
    sub.textContent = `Header cell ${blk.anchorRef} · ${formatNum(blk.categories.length)} categories · ${formatNum(blk.rounds.length)} rounds (${formatNum(blk.ignoredRounds.length)} empty round column${
      blk.ignoredRounds.length === 1 ? '' : 's'
    } ignored)`;
    leftWrap.append(h2, sub);

    const badgeWrap = document.createElement('div');
    badgeWrap.style.display = 'flex';
    badgeWrap.style.gap = 'var(--space-2)';
    badgeWrap.style.alignItems = 'center';
    badgeWrap.style.flexWrap = 'wrap';

    const seriesStatusBadge = document.createElement('span');
    seriesStatusBadge.className = `badge ${
      blockReport.seriesConfirmed && blockReport.seriesId ? 'badge-success' : 'badge-warning'
    } num`;
    seriesStatusBadge.textContent =
      blockReport.seriesConfirmed && blockReport.seriesId
        ? `✓ Series: ${blockReport.seriesName}`
        : '⚠️ Confirm Series Required';

    badgeWrap.appendChild(seriesStatusBadge);
    header.append(leftWrap, badgeWrap);
    blockCard.appendChild(header);

    // Sub-panel A: Simulator Series Picker & Explicit Admin Confirmation
    blockCard.appendChild(buildBlockSeriesConfirmationPanel(blk, blockReport));

    // Sub-panel B: Category Resolution & Interactive Admin Mapping Table
    blockCard.appendChild(buildBlockCategoriesResolutionTable(blk, blockReport));

    // Sub-panel C: Rounds & Database Comparison Table (with Phase 4c-2d Round & Cell Editors)
    blockCard.appendChild(buildBlockRoundsComparisonTable(blk, blockReport, selectedStudent));

    container.appendChild(blockCard);
  }
}

/**
 * Builds Sub-panel A: Explicit Simulator Series Selector & Confirmation Controls for a Block
 */
function buildBlockSeriesConfirmationPanel(blk, blockReport) {
  const panel = document.createElement('div');
  panel.style.padding = 'var(--space-4)';
  panel.style.marginBottom = 'var(--space-5)';
  panel.style.borderRadius = 'var(--radius-md)';
  panel.style.border =
    blockReport.seriesConfirmed && blockReport.seriesId
      ? '1px solid var(--border-subtle)'
      : '2px solid var(--color-warning)';
  panel.style.backgroundColor = 'var(--bg-surface-subtle)';

  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'space-between';
  topRow.style.alignItems = 'flex-start';
  topRow.style.flexWrap = 'wrap';
  topRow.style.gap = 'var(--space-3)';

  const infoCol = document.createElement('div');
  infoCol.style.flex = '1';
  infoCol.style.minWidth = '240px';

  const title = document.createElement('h3');
  title.style.fontSize = 'var(--text-base)';
  title.style.marginBottom = '4px';
  title.textContent = `Step 2.${blk.blockNumber}a — Confirm Simulator Series for Block ${blk.blockNumber}`;

  const suggestion = blockReport.seriesSuggestion;
  const reasonP = document.createElement('p');
  reasonP.style.fontSize = 'var(--text-xs)';
  reasonP.style.color = 'var(--text-muted)';
  reasonP.style.margin = '0';
  reasonP.textContent = suggestion.reason;

  infoCol.append(title, reasonP);

  const controlsCol = document.createElement('div');
  controlsCol.style.display = 'flex';
  controlsCol.style.alignItems = 'center';
  controlsCol.style.gap = 'var(--space-2)';
  controlsCol.style.flexWrap = 'wrap';

  const select = document.createElement('select');
  select.className = 'form-select';
  select.style.width = 'auto';
  select.style.minWidth = '210px';
  select.setAttribute('aria-label', `Select simulator series for Block ${blk.blockNumber}`);

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select Simulator Series --';
  select.appendChild(emptyOpt);

  for (const s of roundSeries) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const isSuggested = suggestion.suggestedSeriesId === s.id;
    opt.textContent = `${s.name}${s.is_current ? ' (Current)' : ''}${isSuggested ? ' [Suggested]' : ''}`;
    if (blockReport.seriesId === s.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  const isConfirmed = Boolean(blockReport.seriesConfirmed && blockReport.seriesId);
  confirmBtn.className = isConfirmed ? 'btn btn-outline btn-sm' : 'btn btn-primary btn-sm';
  confirmBtn.textContent = isConfirmed ? '✓ Series Confirmed' : 'Confirm Series';

  select.addEventListener('change', () => {
    const chosenId = select.value;
    if (!blockUiState[blk.blockNumber]) {
      blockUiState[blk.blockNumber] = { seriesId: '', confirmed: false, adminMappings: {} };
    }
    blockUiState[blk.blockNumber].seriesId = chosenId;
    blockUiState[blk.blockNumber].confirmed = Boolean(chosenId);
    renderCurrentPreviewState();
  });

  confirmBtn.addEventListener('click', () => {
    const chosenId = select.value;
    if (!chosenId) {
      showToast('error', `Please select a simulator series for Block ${blk.blockNumber} first.`);
      return;
    }
    if (!blockUiState[blk.blockNumber]) {
      blockUiState[blk.blockNumber] = { seriesId: chosenId, confirmed: true, adminMappings: {} };
    } else {
      blockUiState[blk.blockNumber].seriesId = chosenId;
      blockUiState[blk.blockNumber].confirmed = !blockUiState[blk.blockNumber].confirmed;
    }
    renderCurrentPreviewState();
  });

  controlsCol.append(select, confirmBtn);
  topRow.append(infoCol, controlsCol);
  panel.appendChild(topRow);

  return panel;
}

/**
 * Builds Sub-panel B: Category Resolution & Interactive Admin Mapping Table for a Block
 */
function buildBlockCategoriesResolutionTable(blk, blockReport) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = 'var(--space-5)';

  const headingRow = document.createElement('div');
  headingRow.style.display = 'flex';
  headingRow.style.justifyContent = 'space-between';
  headingRow.style.alignItems = 'center';
  headingRow.style.flexWrap = 'wrap';
  headingRow.style.gap = 'var(--space-2)';
  headingRow.style.marginBottom = 'var(--space-2)';

  const h3 = document.createElement('h3');
  h3.style.fontSize = 'var(--text-base)';
  h3.textContent = `Step 2.${blk.blockNumber}b — Block ${blk.blockNumber} Categories (${formatNum(blk.categories.length)})`;

  const sc = blockReport.categoryResolution.summaryCounts;
  const summaryBadge = document.createElement('span');
  summaryBadge.className = `badge ${sc.unresolved === 0 ? 'badge-success' : 'badge-warning'} num`;
  summaryBadge.textContent =
    sc.unresolved === 0
      ? `✓ All ${formatNum(sc.total)} Categories Resolved`
      : `⚠️ ${formatNum(sc.unresolved)} Unresolved Categor${sc.unresolved === 1 ? 'y' : 'ies'}`;

  headingRow.append(h3, summaryBadge);
  wrap.appendChild(headingRow);

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-wrapper';
  tableWrapper.style.border = '1px solid var(--border-hairline)';
  tableWrapper.style.borderRadius = 'var(--radius-md)';

  const table = document.createElement('table');
  table.className = 'table data-table';

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  [
    'CSV Row',
    'S.No',
    'Sheet Category Name',
    'Resolution Status',
    'Resolved DB Category & Series',
    'Admin Resolution / Override',
  ].forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const catItem of blockReport.categoryResolution.items) {
    const tr = document.createElement('tr');

    // 1. CSV Row
    const tdRow = document.createElement('td');
    const codeRow = document.createElement('code');
    codeRow.className = 'import-cell-ref num';
    codeRow.textContent = catItem.nameRef || `Row ${catItem.rowNumber}`;
    tdRow.appendChild(codeRow);

    // 2. S.No
    const tdSno = document.createElement('td');
    tdSno.className = 'num';
    tdSno.textContent = String(catItem.sNo ?? '');

    // 3. Sheet Category Name
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '600';
    tdName.textContent = catItem.rawName;

    // 4. Resolution Status Badge
    const tdStatus = document.createElement('td');
    const statusBadgeEl = document.createElement('span');
    statusBadgeEl.className = 'badge num';

    if (catItem.resolutionStatus === 'in_selected_series') {
      statusBadgeEl.classList.add('badge-success');
      statusBadgeEl.textContent =
        catItem.matchedVia === 'db_alias'
          ? 'In Series (Saved Alias)'
          : catItem.matchedVia === 'builtin_alias'
            ? 'In Series (Built-in Alias)'
            : 'In Selected Series';
    } else if (catItem.resolutionStatus === 'in_other_series_only') {
      statusBadgeEl.classList.add('badge-warning');
      statusBadgeEl.textContent = 'In Another Series Only (Will Link)';
    } else if (catItem.resolutionStatus === 'mapped_by_admin') {
      statusBadgeEl.classList.add('badge-success');
      statusBadgeEl.textContent = 'Mapped by Admin';
    } else if (catItem.resolutionStatus === 'create_historical') {
      statusBadgeEl.classList.add('badge-warning');
      statusBadgeEl.textContent = 'New Inactive Category (Historical)';
    } else if (catItem.resolutionStatus === 'skipped_by_admin') {
      statusBadgeEl.classList.add('badge-inactive');
      statusBadgeEl.textContent = 'Skipped by Admin';
    } else {
      statusBadgeEl.style.backgroundColor = 'var(--color-danger-subtle)';
      statusBadgeEl.style.color = 'var(--color-danger-text)';
      statusBadgeEl.textContent = 'Unknown / Unresolved';
    }
    tdStatus.appendChild(statusBadgeEl);

    // 5. Resolved DB Category & Series membership
    const tdTarget = document.createElement('td');
    tdTarget.style.fontSize = 'var(--text-xs)';
    if (catItem.resolvedCategoryName) {
      const strong = document.createElement('strong');
      strong.textContent = catItem.resolvedCategoryName;
      tdTarget.appendChild(strong);

      if (catItem.resolvedCategoryActive === false) {
        const inactTag = document.createElement('span');
        inactTag.className = 'badge badge-inactive';
        inactTag.style.marginLeft = '6px';
        inactTag.textContent = 'Inactive';
        tdTarget.appendChild(inactTag);
      }

      if (catItem.seriesNames && catItem.seriesNames.length > 0) {
        const serSub = document.createElement('div');
        serSub.style.color = 'var(--text-muted)';
        serSub.style.marginTop = '2px';
        serSub.textContent = `Linked series: ${catItem.seriesNames.join(', ')}`;
        tdTarget.appendChild(serSub);
      }
    } else if (catItem.resolutionStatus === 'skipped_by_admin') {
      tdTarget.style.color = 'var(--text-muted)';
      tdTarget.textContent = 'Row will be ignored during import';
    } else {
      tdTarget.style.color = 'var(--color-danger-text)';
      tdTarget.textContent = 'Choose action on the right →';
    }

    // 6. Admin Resolution / Override Controls
    const tdControls = document.createElement('td');
    tdControls.appendChild(buildCategoryAdminDecisionControl(blk.blockNumber, catItem));

    tr.append(tdRow, tdSno, tdName, tdStatus, tdTarget, tdControls);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  wrap.appendChild(tableWrapper);

  return wrap;
}

/**
 * Builds the interactive resolution dropdown + target category picker + "also save as alias" checkbox
 * for a single category row inside a block
 */
function buildCategoryAdminDecisionControl(blockNumber, catItem) {
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '6px';
  container.style.minWidth = '240px';

  const bState = blockUiState[blockNumber] || {
    seriesId: '',
    confirmed: false,
    adminMappings: {},
  };
  const currentDecision = bState.adminMappings?.[catItem.rawKey] || {
    action: 'auto',
    targetCategoryId: '',
    saveAlias: false,
  };

  const actionSelect = document.createElement('select');
  actionSelect.className = 'form-select';
  actionSelect.style.fontSize = 'var(--text-xs)';
  actionSelect.style.padding = '4px 24px 4px 8px';
  actionSelect.style.minHeight = '30px';
  actionSelect.setAttribute('aria-label', `Resolution action for ${catItem.rawName}`);

  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent =
    catItem.matchedVia !== 'none'
      ? `Auto match (${catItem.resolvedCategoryName || 'Matched'})`
      : '-- Choose how to resolve --';
  actionSelect.appendChild(autoOpt);

  const mapOpt = document.createElement('option');
  mapOpt.value = 'map_existing';
  mapOpt.textContent = 'Map to existing category...';
  actionSelect.appendChild(mapOpt);

  const createOpt = document.createElement('option');
  createOpt.value = 'create_historical';
  createOpt.textContent = `Create "${catItem.rawName}" as historical (inactive) category`;
  actionSelect.appendChild(createOpt);

  const skipOpt = document.createElement('option');
  skipOpt.value = 'skip';
  skipOpt.textContent = 'Skip this category';
  actionSelect.appendChild(skipOpt);

  actionSelect.value = currentDecision.action || 'auto';
  container.appendChild(actionSelect);

  if (currentDecision.action === 'map_existing') {
    const targetSelect = document.createElement('select');
    targetSelect.className = 'form-select';
    targetSelect.style.fontSize = 'var(--text-xs)';
    targetSelect.style.padding = '4px 24px 4px 8px';
    targetSelect.style.minHeight = '30px';

    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = '-- Select target category --';
    targetSelect.appendChild(placeholderOpt);

    for (const rc of roundCategories) {
      const opt = document.createElement('option');
      opt.value = rc.id;
      opt.textContent = `${rc.name}${rc.active === false ? ' [Inactive]' : ''}`;
      if (currentDecision.targetCategoryId === rc.id) {
        opt.selected = true;
      }
      targetSelect.appendChild(opt);
    }

    targetSelect.addEventListener('change', () => {
      if (!blockUiState[blockNumber].adminMappings) {
        blockUiState[blockNumber].adminMappings = {};
      }
      blockUiState[blockNumber].adminMappings[catItem.rawKey] = {
        ...currentDecision,
        action: 'map_existing',
        targetCategoryId: targetSelect.value,
      };
      renderCurrentPreviewState();
    });

    container.appendChild(targetSelect);

    // "Also save as alias" checkbox + immediate save button
    const aliasRow = document.createElement('div');
    aliasRow.style.display = 'flex';
    aliasRow.style.alignItems = 'center';
    aliasRow.style.justifyContent = 'space-between';
    aliasRow.style.gap = '6px';
    aliasRow.style.flexWrap = 'wrap';

    const aliasLabel = document.createElement('label');
    aliasLabel.style.display = 'inline-flex';
    aliasLabel.style.alignItems = 'center';
    aliasLabel.style.gap = '4px';
    aliasLabel.style.fontSize = '11px';
    aliasLabel.style.color = 'var(--text-muted)';
    aliasLabel.style.cursor = 'pointer';

    const aliasCheckbox = document.createElement('input');
    aliasCheckbox.type = 'checkbox';
    aliasCheckbox.checked = Boolean(currentDecision.saveAlias);
    aliasCheckbox.addEventListener('change', () => {
      blockUiState[blockNumber].adminMappings[catItem.rawKey] = {
        ...currentDecision,
        action: 'map_existing',
        saveAlias: aliasCheckbox.checked,
      };
      renderCurrentPreviewState();
    });

    const aliasText = document.createElement('span');
    aliasText.textContent = `Save "${catItem.rawKey}" as alias`;
    aliasLabel.append(aliasCheckbox, aliasText);
    aliasRow.appendChild(aliasLabel);

    if (currentDecision.targetCategoryId) {
      const saveNowBtn = document.createElement('button');
      saveNowBtn.type = 'button';
      saveNowBtn.className = 'btn btn-outline btn-sm';
      saveNowBtn.style.padding = '2px 6px';
      saveNowBtn.style.minHeight = '22px';
      saveNowBtn.style.fontSize = '11px';
      saveNowBtn.textContent = 'Save alias now';
      saveNowBtn.addEventListener('click', async () => {
        await saveCategoryAliasToDatabase(catItem.rawKey, currentDecision.targetCategoryId);
      });
      aliasRow.appendChild(saveNowBtn);
    }

    container.appendChild(aliasRow);
  }

  actionSelect.addEventListener('change', () => {
    const nextAction = actionSelect.value;
    if (!blockUiState[blockNumber].adminMappings) {
      blockUiState[blockNumber].adminMappings = {};
    }
    if (nextAction === 'auto') {
      delete blockUiState[blockNumber].adminMappings[catItem.rawKey];
    } else {
      blockUiState[blockNumber].adminMappings[catItem.rawKey] = {
        action: nextAction,
        targetCategoryId:
          nextAction === 'map_existing' ? currentDecision.targetCategoryId || '' : '',
        saveAlias: nextAction === 'map_existing' ? Boolean(currentDecision.saveAlias) : false,
      };
    }
    renderCurrentPreviewState();
  });

  return container;
}

/**
 * Builds the inline Round Editor row (`<tr>`) for Phase 4c-2d:
 * - Round date (`YYYY-MM-DD`, date picker)
 * - Round type (choose `Flat Round`, `Category wise`, or type a custom value up to 40 characters)
 * - Total time (`h:mm:ss`; empty means no total time)
 * - "Skip this round" switch
 * - "Save Round Edit", "Cancel", and "Reset to sheet value"
 */
function buildInlineRoundEditorTr(blk, rnd, colSpan) {
  const editorTr = document.createElement('tr');
  editorTr.id = `round-editor-${blk.blockNumber}-${rnd.roundNumber}`;

  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.style.padding = 'var(--space-3) var(--space-4)';
  td.style.backgroundColor = 'var(--bg-surface)';

  const box = document.createElement('div');
  box.className = 'import-inline-editor';

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-2)';
  headerRow.style.marginBottom = 'var(--space-3)';

  const title = document.createElement('strong');
  title.style.fontSize = 'var(--text-sm)';
  title.textContent = `Edit Block ${blk.blockNumber} · Round ${rnd.roundNumber}`;

  const origMeta = document.createElement('span');
  origMeta.className = 'num';
  origMeta.style.fontSize = '11px';
  origMeta.style.color = 'var(--text-muted)';
  const origValues = rnd.originalValues || {};
  origMeta.textContent = `Sheet values — Date: ${origValues.dateISO || origValues.rawDate || '—'} · Type: ${origValues.roundType || '—'} · Time: ${origValues.timeTakenDisplay || origValues.timeTakenRaw || '—'}`;

  headerRow.append(title, origMeta);
  box.appendChild(headerRow);

  const grid = document.createElement('div');
  grid.className = 'import-inline-editor-grid';

  // 1. Round Date (YYYY-MM-DD)
  const dateGroup = document.createElement('div');
  dateGroup.className = 'form-group';
  dateGroup.style.marginBottom = '0';
  const dateLbl = document.createElement('label');
  dateLbl.className = 'form-label';
  dateLbl.style.fontSize = 'var(--text-xs)';
  dateLbl.textContent = 'Round Date (YYYY-MM-DD)';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'form-input num';
  dateInput.style.fontSize = 'var(--text-xs)';
  dateInput.min = '2020-01-01';
  dateInput.max = todayIST || getISTDateString(new Date());
  dateInput.value = rnd.dateISO || '';
  dateInput.setAttribute('data-field', 'round-date');
  dateGroup.append(dateLbl, dateInput);

  // 2. Round Type (Flat Round, Category wise, or custom up to 40 chars)
  const typeGroup = document.createElement('div');
  typeGroup.className = 'form-group';
  typeGroup.style.marginBottom = '0';
  const typeLbl = document.createElement('label');
  typeLbl.className = 'form-label';
  typeLbl.style.fontSize = 'var(--text-xs)';
  typeLbl.textContent = 'Round Type (max 40 chars)';

  const currentType = rnd.summary.roundType || '';
  const presetTypes = ['Flat Round', 'Category wise'];
  const isCustomType = currentType !== '' && !presetTypes.includes(currentType);

  const typeSelect = document.createElement('select');
  typeSelect.className = 'form-select';
  typeSelect.style.fontSize = 'var(--text-xs)';
  typeSelect.setAttribute('data-field', 'round-type-select');

  [
    { value: 'Flat Round', label: 'Flat Round' },
    { value: 'Category wise', label: 'Category wise' },
    { value: '__custom__', label: 'Custom value (up to 40 chars)...' },
    { value: '', label: '(Empty / None)' },
  ].forEach((optItem) => {
    const opt = document.createElement('option');
    opt.value = optItem.value;
    opt.textContent = optItem.label;
    typeSelect.appendChild(opt);
  });

  if (isCustomType) {
    typeSelect.value = '__custom__';
  } else {
    typeSelect.value = currentType;
  }

  const customTypeInput = document.createElement('input');
  customTypeInput.type = 'text';
  customTypeInput.className = 'form-input';
  customTypeInput.style.fontSize = 'var(--text-xs)';
  customTypeInput.style.marginTop = '6px';
  customTypeInput.maxLength = 40;
  customTypeInput.placeholder = 'Enter custom round type (max 40 chars)...';
  customTypeInput.value = isCustomType ? currentType : '';
  customTypeInput.style.display = isCustomType ? 'block' : 'none';

  typeSelect.addEventListener('change', () => {
    if (typeSelect.value === '__custom__') {
      customTypeInput.style.display = 'block';
      customTypeInput.focus();
    } else {
      customTypeInput.style.display = 'none';
    }
  });

  typeGroup.append(typeLbl, typeSelect, customTypeInput);

  // 3. Total Time (h:mm:ss; empty means no total time)
  const timeGroup = document.createElement('div');
  timeGroup.className = 'form-group';
  timeGroup.style.marginBottom = '0';
  const timeLbl = document.createElement('label');
  timeLbl.className = 'form-label';
  timeLbl.style.fontSize = 'var(--text-xs)';
  timeLbl.textContent = 'Total Time (h:mm:ss, max 8:00:00)';
  const timeInput = document.createElement('input');
  timeInput.type = 'text';
  timeInput.className = 'form-input num';
  timeInput.style.fontSize = 'var(--text-xs)';
  timeInput.placeholder = 'e.g. 0:59:23 (empty = no total time)';
  timeInput.setAttribute('data-field', 'round-time');
  timeInput.value =
    rnd.summary.timeTakenSeconds !== null && rnd.summary.timeTakenSeconds !== undefined
      ? formatSecondsDisplay(rnd.summary.timeTakenSeconds, true)
      : '';
  timeGroup.append(timeLbl, timeInput);

  // 4. "Skip this round" switch
  const skipGroup = document.createElement('div');
  skipGroup.className = 'form-group';
  skipGroup.style.marginBottom = '0';
  const skipLblHeader = document.createElement('span');
  skipLblHeader.className = 'form-label';
  skipLblHeader.style.fontSize = 'var(--text-xs)';
  skipLblHeader.style.display = 'block';
  skipLblHeader.textContent = 'Skip Round';

  const skipSwitchLabel = document.createElement('label');
  skipSwitchLabel.style.display = 'inline-flex';
  skipSwitchLabel.style.alignItems = 'center';
  skipSwitchLabel.style.gap = '8px';
  skipSwitchLabel.style.fontSize = 'var(--text-xs)';
  skipSwitchLabel.style.fontWeight = '600';
  skipSwitchLabel.style.cursor = 'pointer';
  skipSwitchLabel.style.marginTop = '8px';

  const skipCheckbox = document.createElement('input');
  skipCheckbox.type = 'checkbox';
  skipCheckbox.checked = Boolean(rnd.roundSkippedByAdmin);

  const skipSpan = document.createElement('span');
  skipSpan.textContent = 'Skip this round (do not import)';
  skipSwitchLabel.append(skipCheckbox, skipSpan);
  skipGroup.append(skipLblHeader, skipSwitchLabel);

  grid.append(dateGroup, typeGroup, timeGroup, skipGroup);
  box.appendChild(grid);

  const errorBanner = document.createElement('div');
  errorBanner.className = 'banner banner-error';
  errorBanner.style.display = 'none';
  errorBanner.style.marginTop = 'var(--space-3)';
  errorBanner.style.fontSize = 'var(--text-xs)';
  box.appendChild(errorBanner);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'import-inline-editor-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    activeRoundEditor = null;
    renderCurrentPreviewState();
  });

  if (rnd.isEdited || rnd.roundSkippedByAdmin) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-outline btn-sm';
    resetBtn.textContent = 'Reset to sheet value';
    resetBtn.addEventListener('click', () => {
      resetRoundEditToSheetValue(blk.blockNumber, rnd.roundNumber);
    });
    actionsRow.appendChild(resetBtn);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = 'Save Round Edit';
  saveBtn.addEventListener('click', () => {
    errorBanner.style.display = 'none';
    const chosenType =
      typeSelect.value === '__custom__' ? customTypeInput.value.trim() : typeSelect.value;

    const validation = validateRoundEdit(
      {
        skip: skipCheckbox.checked,
        roundDate: dateInput.value.trim(),
        roundType: chosenType,
        timeTakenRaw: timeInput.value.trim(),
      },
      { todayIST: todayIST || getISTDateString(new Date()) }
    );

    if (!validation.ok) {
      errorBanner.textContent = validation.error;
      errorBanner.style.display = 'block';
      return;
    }

    const rKey = `${blk.blockNumber}-${rnd.roundNumber}`;
    if (!previewEditState.rounds) previewEditState.rounds = {};
    previewEditState.rounds[rKey] = {
      skip: validation.value.skip,
      roundDate: validation.value.roundDate,
      roundType: validation.value.roundType,
      timeTakenSeconds: validation.value.timeTakenSeconds,
    };

    activeRoundEditor = null;
    renderCurrentPreviewState();
    showToast('success', `Updated Block ${blk.blockNumber} · Round ${rnd.roundNumber} in preview.`);
  });

  actionsRow.append(cancelBtn, saveBtn);
  box.appendChild(actionsRow);
  td.appendChild(box);
  editorTr.appendChild(td);

  return editorTr;
}

/**
 * Builds Sub-panel C: Rounds & Cell-by-Cell Database Comparison Table for a Block,
 * including Phase 4c-2d Round Edits ("Edit", "Fix", "Edited" chip, "Reset to sheet value")
 * and Cell Edits inside the expandable drawer.
 */
function buildBlockRoundsComparisonTable(blk, blockReport, selectedStudent) {
  const wrap = document.createElement('div');
  const dataComp = blockReport.dataComparison;
  const roundCompByNum = new Map(
    (dataComp.rounds || []).map((rc) => [Number(rc.roundNumber), rc])
  );

  const headingRow = document.createElement('div');
  headingRow.style.display = 'flex';
  headingRow.style.justifyContent = 'space-between';
  headingRow.style.alignItems = 'center';
  headingRow.style.flexWrap = 'wrap';
  headingRow.style.gap = 'var(--space-2)';
  headingRow.style.marginBottom = 'var(--space-3)';

  const h3 = document.createElement('h3');
  h3.style.fontSize = 'var(--text-base)';
  h3.textContent = `Block ${blk.blockNumber} Rounds & Database Comparison (${formatNum(blk.rounds.length)})`;

  const rc = dataComp.summaryCounts.rounds;
  const compSummaryBadge = document.createElement('span');
  compSummaryBadge.className = 'badge badge-inactive num';
  compSummaryBadge.textContent =
    selectedStudent && blockReport.seriesId
      ? `${formatNum(rc.newRounds)} New · ${formatNum(rc.existingIdentical)} Identical · ${formatNum(rc.existingAddsCells)} Add Scores · ${formatNum(rc.existingWithConflicts)} Diff/Conflict`
      : 'Select student & series to compare';

  headingRow.append(h3, compSummaryBadge);
  wrap.appendChild(headingRow);

  if (blk.ignoredRounds.length > 0) {
    const infoBar = document.createElement('div');
    infoBar.style.marginBottom = 'var(--space-3)';
    infoBar.style.fontSize = 'var(--text-xs)';
    infoBar.style.color = 'var(--text-muted)';
    infoBar.textContent = blk.ignoredRounds.map((ir) => `ℹ️ ${ir.message}`).join(' ');
    wrap.appendChild(infoBar);
  }

  if (dataComp.dbOnlyRounds && dataComp.dbOnlyRounds.length > 0) {
    const dbOnlyBar = document.createElement('div');
    dbOnlyBar.style.marginBottom = 'var(--space-3)';
    dbOnlyBar.style.padding = 'var(--space-2) var(--space-3)';
    dbOnlyBar.style.backgroundColor = 'var(--bg-surface-subtle)';
    dbOnlyBar.style.borderRadius = 'var(--radius-sm)';
    dbOnlyBar.style.fontSize = 'var(--text-xs)';
    dbOnlyBar.style.color = 'var(--text-muted)';
    dbOnlyBar.className = 'num';
    const listStr = dataComp.dbOnlyRounds
      .map(
        (r) =>
          `Round ${r.roundNumber} (${normalizeShortMonths(formatDisplayDateIST(r.roundDate))}, ${formatNum(r.scoresCount)} scores)`
      )
      .join(' · ');
    dbOnlyBar.textContent = `ℹ️ Existing rounds in "${blockReport.seriesName}" not in this sheet (${formatNum(dataComp.dbOnlyRounds.length)}, kept untouched): ${listStr}`;
    wrap.appendChild(dbOnlyBar);
  }

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-wrapper';
  tableWrapper.style.border = '1px solid var(--border-hairline)';
  tableWrapper.style.borderRadius = 'var(--radius-md)';

  const table = document.createElement('table');
  table.className = 'table data-table';

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  const colHeaders = [
    'Round #',
    'Date (IST)',
    'Round Type',
    'Time Taken',
    'DB Comparison',
    'Cells Status',
    'Cross-Checks (Tap chip)',
    'Date Flags',
    'Actions & Cells',
  ];
  colHeaders.forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const rnd of blk.rounds) {
    const rComp = roundCompByNum.get(Number(rnd.roundNumber)) || null;
    const roundKey = `${blk.blockNumber}-${rnd.roundNumber}`;
    const isRoundExpanded = expandedRoundKeys.has(roundKey);
    const isEditorOpen =
      activeRoundEditor &&
      activeRoundEditor.blockNumber === blk.blockNumber &&
      activeRoundEditor.roundNumber === rnd.roundNumber;

    const tr = document.createElement('tr');
    if (rnd.roundSkippedByAdmin) {
      tr.classList.add('import-row-skipped');
    } else if (rnd.roundExcluded) {
      tr.style.opacity = '0.78';
    }

    // 1. Round # + Edited / Skipped / Excluded Badges
    const tdRound = document.createElement('td');
    tdRound.className = 'num';
    tdRound.style.whiteSpace = 'nowrap';
    const rStrong = document.createElement('strong');
    rStrong.textContent = `Round ${rnd.roundNumber}`;
    const rRef = document.createElement('code');
    rRef.className = 'import-cell-ref num';
    rRef.style.marginLeft = '6px';
    rRef.textContent = rnd.headerRef;
    tdRound.append(rStrong, rRef);

    const statusChipsDiv = document.createElement('div');
    statusChipsDiv.style.display = 'flex';
    statusChipsDiv.style.flexWrap = 'wrap';
    statusChipsDiv.style.gap = '4px';
    statusChipsDiv.style.marginTop = '4px';

    if (rnd.isEdited || rnd.roundSkippedByAdmin) {
      const editedChip = document.createElement('span');
      editedChip.className = 'import-edited-chip num';
      editedChip.textContent = rnd.roundSkippedByAdmin ? '✏️ Skipped' : '✏️ Edited';
      statusChipsDiv.appendChild(editedChip);
    }

    if (rnd.roundExcluded && !rnd.roundSkippedByAdmin) {
      const exclBadge = document.createElement('span');
      exclBadge.className = 'badge badge-warning num';
      exclBadge.textContent = 'EXCLUDED';
      exclBadge.title = rnd.roundExclusionReason || 'Excluded by DB validation limits';
      statusChipsDiv.appendChild(exclBadge);
    }

    if (statusChipsDiv.childNodes.length > 0) {
      tdRound.appendChild(statusChipsDiv);
    }

    // 2. Date (consistent 3-letter month name, e.g. Sep not Sept)
    const tdDate = document.createElement('td');
    tdDate.className = 'num';
    tdDate.style.whiteSpace = 'nowrap';
    if (rnd.dateStatus === 'ok' && rnd.dateISO) {
      const dateMain = document.createElement('div');
      dateMain.style.fontWeight = '600';
      dateMain.textContent = normalizeShortMonths(formatDisplayDateIST(rnd.dateISO));
      const dateSub = document.createElement('div');
      dateSub.style.fontSize = '11px';
      dateSub.style.color = 'var(--text-dim)';
      dateSub.textContent = `${rnd.dateISO} · ${rnd.dateRef}`;
      tdDate.append(dateMain, dateSub);

      if (rnd.editedFields?.roundDate) {
        const edTag = document.createElement('span');
        edTag.className = 'import-edited-chip';
        edTag.style.marginTop = '2px';
        edTag.textContent = 'Edited';
        tdDate.appendChild(edTag);
      }

      if (rComp && rComp.dateDiffers && rComp.existingRound) {
        const dbDateDiff = document.createElement('div');
        dbDateDiff.style.fontSize = '11px';
        dbDateDiff.style.color = 'var(--color-warning-text)';
        dbDateDiff.textContent = `DB Date: ${normalizeShortMonths(formatDisplayDateIST(rComp.existingRound.round_date))}`;
        tdDate.appendChild(dbDateDiff);
      }
    } else {
      const errBadge = document.createElement('span');
      errBadge.className = 'badge';
      errBadge.style.backgroundColor = 'var(--color-danger-subtle)';
      errBadge.style.color = 'var(--color-danger-text)';
      errBadge.textContent =
        rnd.dateStatus === 'missing' ? 'Missing Date' : `Unreadable: "${rnd.rawDate}"`;
      tdDate.appendChild(errBadge);
    }

    // 3. Round Type
    const tdType = document.createElement('td');
    const typeMain = document.createElement('div');
    typeMain.textContent = rnd.summary.roundType || '—';
    tdType.appendChild(typeMain);
    if (rnd.editedFields?.roundType) {
      const edTag = document.createElement('span');
      edTag.className = 'import-edited-chip';
      edTag.style.marginTop = '2px';
      edTag.textContent = 'Edited';
      tdType.appendChild(edTag);
    }
    if (rnd.summary.roundTypeTruncated) {
      const truncNote = document.createElement('div');
      truncNote.style.fontSize = '11px';
      truncNote.style.color = 'var(--color-warning-text)';
      truncNote.textContent = 'Cut to 40 chars';
      tdType.appendChild(truncNote);
    }
    if (rComp && rComp.typeDiffers && rComp.existingRound) {
      const dbTypeDiff = document.createElement('div');
      dbTypeDiff.style.fontSize = '11px';
      dbTypeDiff.style.color = 'var(--color-warning-text)';
      dbTypeDiff.textContent = `DB: ${rComp.existingRound.round_type}`;
      tdType.appendChild(dbTypeDiff);
    }

    // 4. Time Taken
    const tdTime = document.createElement('td');
    tdTime.className = 'num';
    tdTime.style.whiteSpace = 'nowrap';
    if (rnd.summary.timeTakenExceedsLimit) {
      const overTime = document.createElement('span');
      overTime.className = 'badge badge-warning num';
      overTime.textContent = `${rnd.summary.timeTakenRaw} (> 8h → NULL)`;
      overTime.title = `Cell ${rnd.summary.timeTakenRef} exceeds 28,800s (8h); round will be imported WITHOUT a total time`;
      tdTime.appendChild(overTime);
    } else if (rnd.summary.timeTakenUnreadable) {
      const badTime = document.createElement('span');
      badTime.className = 'badge badge-warning num';
      badTime.textContent = `Unreadable: "${rnd.summary.timeTakenRaw}"`;
      tdTime.appendChild(badTime);
    } else {
      const timeMain = document.createElement('div');
      timeMain.textContent = rnd.summary.timeTakenDisplay || '—';
      tdTime.appendChild(timeMain);
      if (rnd.editedFields?.timeTakenSeconds) {
        const edTag = document.createElement('span');
        edTag.className = 'import-edited-chip';
        edTag.style.marginTop = '2px';
        edTag.textContent = 'Edited';
        tdTime.appendChild(edTag);
      }
      if (rComp && rComp.timeTakenDiffers && rComp.existingRound) {
        const dbTimeDiff = document.createElement('div');
        dbTimeDiff.style.fontSize = '11px';
        dbTimeDiff.style.color = 'var(--color-warning-text)';
        dbTimeDiff.textContent = `DB: ${formatSecondsDisplay(rComp.existingRound.time_taken_seconds, true)}`;
        tdTime.appendChild(dbTimeDiff);
      }
    }

    // 5. DB Comparison Status
    const tdDbComp = document.createElement('td');
    tdDbComp.className = 'num';
    if (rnd.roundSkippedByAdmin) {
      const skipStatus = document.createElement('span');
      skipStatus.className = 'badge badge-inactive';
      skipStatus.textContent = 'Skipped by Admin';
      tdDbComp.appendChild(skipStatus);
    } else if (rnd.roundExcluded) {
      const exclStatus = document.createElement('span');
      exclStatus.className = 'badge badge-warning';
      exclStatus.textContent = 'Excluded from Import';
      tdDbComp.appendChild(exclStatus);
    } else if (!selectedStudent || !blockReport.seriesId || !rComp) {
      const pendingBadge = document.createElement('span');
      pendingBadge.className = 'badge badge-inactive';
      pendingBadge.textContent = 'Select student & series';
      tdDbComp.appendChild(pendingBadge);
    } else {
      const compBadge = document.createElement('span');
      const cCounts = rComp.counts;
      if (rComp.roundComparisonStatus === 'new') {
        compBadge.className = 'badge badge-success num';
        compBadge.textContent = `NEW ROUND (+${formatNum(cCounts.newCells)})`;
      } else if (rComp.roundComparisonStatus === 'identical') {
        compBadge.className = 'badge badge-inactive num';
        compBadge.textContent = `IDENTICAL IN DB (${formatNum(cCounts.identicalCells)})`;
      } else if (rComp.roundComparisonStatus === 'adds_cells') {
        compBadge.className = 'badge badge-success num';
        compBadge.textContent = `EXISTING · +${formatNum(cCounts.newCells)} NEW`;
      } else {
        compBadge.className = 'badge badge-warning num';
        compBadge.textContent = 'EXISTING · HAS DIFFERENCES';
      }
      tdDbComp.appendChild(compBadge);

      const subComp = document.createElement('div');
      subComp.style.fontSize = '11px';
      subComp.style.color = 'var(--text-dim)';
      subComp.style.marginTop = '3px';
      const detailParts = [];
      if (cCounts.newCells > 0) detailParts.push(`${formatNum(cCounts.newCells)} new`);
      if (cCounts.identicalCells > 0)
        detailParts.push(`${formatNum(cCounts.identicalCells)} identical`);
      if (cCounts.conflictCells > 0)
        detailParts.push(`${formatNum(cCounts.conflictCells)} conflict`);
      if (cCounts.protectedConflictCells > 0)
        detailParts.push(`${formatNum(cCounts.protectedConflictCells)} protected`);
      if (cCounts.dbOnlyCells > 0) detailParts.push(`${formatNum(cCounts.dbOnlyCells)} DB-only`);
      subComp.textContent = detailParts.join(' · ') || 'No score diffs';
      tdDbComp.appendChild(subComp);
    }

    // 6. Cells OK count
    const tdCells = document.createElement('td');
    tdCells.className = 'num';
    tdCells.style.whiteSpace = 'nowrap';
    const okSpan = document.createElement('div');
    okSpan.style.fontWeight = '600';
    okSpan.textContent = `${formatNum(rnd.computed.okCount)} OK`;
    const subParts = [];
    if (rnd.computed.emptyCount > 0) subParts.push(`${formatNum(rnd.computed.emptyCount)} empty`);
    if (rnd.computed.noteCount > 0) subParts.push(`${formatNum(rnd.computed.noteCount)} note`);
    if (rnd.computed.unreadableCount > 0)
      subParts.push(`${formatNum(rnd.computed.unreadableCount)} unreadable`);
    if (rnd.computed.skippedCount > 0)
      subParts.push(`${formatNum(rnd.computed.skippedCount)} skipped`);
    const subSpan = document.createElement('div');
    subSpan.style.fontSize = '11px';
    subSpan.style.color =
      rnd.computed.unreadableCount > 0 ? 'var(--color-warning-text)' : 'var(--text-dim)';
    subSpan.textContent = subParts.join(' · ') || '0 empty';
    tdCells.append(okSpan, subSpan);

    // 7. Cross-Checks (Final Score, Total Attempt, Marks TO BE CORRECTED)
    const tdChecks = document.createElement('td');
    const checksWrap = document.createElement('div');
    checksWrap.style.display = 'flex';
    checksWrap.style.flexWrap = 'wrap';
    checksWrap.style.gap = '6px';

    const checkDetailBox = document.createElement('div');
    checkDetailBox.style.fontSize = '11px';
    checkDetailBox.style.marginTop = '4px';
    checkDetailBox.style.padding = '4px 8px';
    checkDetailBox.style.borderRadius = 'var(--radius-sm)';
    checkDetailBox.style.backgroundColor = 'var(--bg-surface-subtle)';
    checkDetailBox.className = 'num';
    checkDetailBox.style.display = 'none';

    const checkEntries = [
      { key: 'finalScore', shortLabel: 'Score', check: rnd.crossChecks.finalScore },
      { key: 'totalAttempt', shortLabel: 'Attempt', check: rnd.crossChecks.totalAttempt },
      {
        key: 'marksToBeCorrected',
        shortLabel: 'Marks',
        check: rnd.crossChecks.marksToBeCorrected,
      },
    ];

    for (const { shortLabel, check } of checkEntries) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'badge num';
      chip.style.cursor = 'pointer';
      chip.style.border = '1px solid var(--border-subtle)';
      chip.style.whiteSpace = 'nowrap';

      if (check.status === 'OK') {
        chip.classList.add('badge-success');
        chip.textContent = `${shortLabel}: OK (${formatNum(check.computedValue)})`;
      } else if (check.status === 'MISMATCH') {
        chip.classList.add('badge-warning');
        const diffStr = check.diff > 0 ? `+${formatNum(check.diff)}` : formatNum(check.diff);
        chip.textContent = `${shortLabel}: MISMATCH (${diffStr})`;
        checkDetailBox.style.display = 'block';
        checkDetailBox.textContent = `${check.label}: Sheet = ${formatNum(check.sheetValue)}, Calculated = ${formatNum(check.computedValue)} (Diff: ${diffStr})`;
      } else if (check.status === 'INCOMPLETE') {
        chip.style.backgroundColor = 'var(--color-danger-subtle)';
        chip.style.color = 'var(--color-danger-text)';
        chip.textContent = `${shortLabel}: INCOMPLETE`;
      } else {
        chip.classList.add('badge-inactive');
        chip.textContent = `${shortLabel}: NOT PRESENT`;
      }

      chip.addEventListener('click', () => {
        const diffStr =
          check.diff !== null && check.diff !== undefined
            ? check.diff > 0
              ? `+${formatNum(check.diff)}`
              : formatNum(check.diff)
            : 'N/A';
        const sheetStr =
          check.sheetValue !== null && check.sheetValue !== undefined
            ? formatNum(check.sheetValue)
            : '—';
        const text = `${check.label} (${check.status}) — Sheet: ${sheetStr} · Calculated from cells: ${formatNum(check.computedValue)} · Diff: ${diffStr}`;
        if (checkDetailBox.style.display === 'block' && checkDetailBox.textContent === text) {
          checkDetailBox.style.display = 'none';
        } else {
          checkDetailBox.style.display = 'block';
          checkDetailBox.textContent = text;
        }
      });

      checksWrap.appendChild(chip);
    }

    tdChecks.append(checksWrap, checkDetailBox);

    // 8. Date Flags
    const tdFlags = document.createElement('td');
    if (rnd.dateFlags.length === 0) {
      const okFlag = document.createElement('span');
      okFlag.className = 'badge badge-success';
      okFlag.textContent = 'OK';
      tdFlags.appendChild(okFlag);
    } else {
      const flagWrap = document.createElement('div');
      flagWrap.style.display = 'flex';
      flagWrap.style.flexDirection = 'column';
      flagWrap.style.gap = '4px';
      for (const f of rnd.dateFlags) {
        const fb = document.createElement('span');
        fb.className = 'badge';
        fb.style.whiteSpace = 'nowrap';
        if (f.severity === 'error') {
          fb.style.backgroundColor = 'var(--color-danger-subtle)';
          fb.style.color = 'var(--color-danger-text)';
        } else if (f.severity === 'warning') {
          fb.classList.add('badge-warning');
        } else {
          fb.classList.add('badge-inactive');
        }
        fb.textContent = f.code.replace(/_/g, ' ');
        fb.title = f.message;
        flagWrap.appendChild(fb);
      }
      tdFlags.appendChild(flagWrap);
    }

    // 9. Actions & Expandable Cell Drawer Toggle
    //    - "Edit" button for every round
    //    - Quick action "Fix" button when round has a date or time problem
    //    - "Reset to sheet value" button when round is edited
    //    - "Cells (N) ▾" button
    const tdExpand = document.createElement('td');
    tdExpand.style.whiteSpace = 'nowrap';

    const actionBtnsWrap = document.createElement('div');
    actionBtnsWrap.style.display = 'flex';
    actionBtnsWrap.style.flexWrap = 'wrap';
    actionBtnsWrap.style.gap = '6px';
    actionBtnsWrap.style.alignItems = 'center';

    const hasDateProblem =
      rnd.dateStatus !== 'ok' ||
      rnd.dateFlags.some((f) => f.severity === 'error' || f.severity === 'warning') ||
      Boolean(rComp && rComp.dateDiffers);
    const hasTimeProblem =
      Boolean(rnd.summary.timeTakenExceedsLimit) || Boolean(rnd.summary.timeTakenUnreadable);

    if ((hasDateProblem || hasTimeProblem) && !rnd.roundSkippedByAdmin) {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'btn btn-primary btn-sm';
      fixBtn.textContent = 'Fix';
      fixBtn.title = hasDateProblem
        ? 'Fix round date problem in preview'
        : 'Fix round total time problem in preview';
      fixBtn.addEventListener('click', () => {
        openRoundEditorAndScroll(
          blk.blockNumber,
          rnd.roundNumber,
          hasDateProblem ? 'date' : 'time'
        );
      });
      actionBtnsWrap.appendChild(fixBtn);
    }

    const editRoundBtn = document.createElement('button');
    editRoundBtn.type = 'button';
    editRoundBtn.className = 'btn btn-outline btn-sm';
    editRoundBtn.textContent = isEditorOpen ? 'Close Edit' : 'Edit';
    editRoundBtn.addEventListener('click', () => {
      if (isEditorOpen) {
        activeRoundEditor = null;
        renderCurrentPreviewState();
      } else {
        openRoundEditorAndScroll(blk.blockNumber, rnd.roundNumber, null);
      }
    });
    actionBtnsWrap.appendChild(editRoundBtn);

    if (rnd.isEdited || rnd.roundSkippedByAdmin) {
      const resetRoundBtn = document.createElement('button');
      resetRoundBtn.type = 'button';
      resetRoundBtn.className = 'btn btn-outline btn-sm';
      resetRoundBtn.textContent = 'Reset to sheet value';
      resetRoundBtn.addEventListener('click', () => {
        resetRoundEditToSheetValue(blk.blockNumber, rnd.roundNumber);
      });
      actionBtnsWrap.appendChild(resetRoundBtn);
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn btn-outline btn-sm num';
    expandBtn.setAttribute('aria-expanded', isRoundExpanded ? 'true' : 'false');
    expandBtn.textContent = isRoundExpanded
      ? `Hide (${formatNum(rnd.cells.length)}) ▴`
      : `Cells (${formatNum(rnd.cells.length)}) ▾`;

    // Detail Row (persists expanded state across live recalculations via expandedRoundKeys)
    const detailTr = document.createElement('tr');
    detailTr.style.display = isRoundExpanded ? 'table-row' : 'none';
    detailTr.style.backgroundColor = 'var(--bg-surface-subtle)';

    const detailTd = document.createElement('td');
    detailTd.colSpan = colHeaders.length;
    detailTd.style.padding = 'var(--space-4)';
    detailTd.appendChild(buildRoundCellsDetailTable(rnd, blk, rComp));
    detailTr.appendChild(detailTd);

    expandBtn.addEventListener('click', () => {
      const isHidden = detailTr.style.display === 'none';
      if (isHidden) {
        expandedRoundKeys.add(roundKey);
      } else {
        expandedRoundKeys.delete(roundKey);
      }
      detailTr.style.display = isHidden ? 'table-row' : 'none';
      expandBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      expandBtn.textContent = isHidden
        ? `Hide (${formatNum(rnd.cells.length)}) ▴`
        : `Cells (${formatNum(rnd.cells.length)}) ▾`;
    });

    actionBtnsWrap.appendChild(expandBtn);
    tdExpand.appendChild(actionBtnsWrap);

    tr.append(tdRound, tdDate, tdType, tdTime, tdDbComp, tdCells, tdChecks, tdFlags, tdExpand);
    tbody.appendChild(tr);

    if (isEditorOpen) {
      tbody.appendChild(buildInlineRoundEditorTr(blk, rnd, colHeaders.length));
    }

    tbody.appendChild(detailTr);
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  wrap.appendChild(tableWrapper);

  return wrap;
}

/**
 * Builds the inline Cell Editor row (`<tr>`) for Phase 4c-2d:
 * - Correct (`0 <= correct <= total`)
 * - Total (`total >= 1`)
 * - Time (`m:ss` or `h:mm:ss`, `0` to `4:00:00` / `14400`s)
 * - Note (up to `500` characters)
 * - "Skip this cell" checkbox
 * - Validates with the exact database rules (`validateCellEdit`)
 */
function buildInlineCellEditorTr(blk, rnd, cell, colSpan) {
  const tr = document.createElement('tr');
  tr.id = `cell-editor-${blk.blockNumber}-${rnd.roundNumber}-${cell.rowIndex}`;

  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.style.padding = 'var(--space-3)';
  td.style.backgroundColor = 'var(--bg-surface)';

  const box = document.createElement('div');
  box.className = 'import-inline-editor';

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-2)';
  headerRow.style.marginBottom = 'var(--space-3)';

  const title = document.createElement('strong');
  title.style.fontSize = 'var(--text-xs)';
  title.textContent = `Edit Cell ${cell.scoreRef} / ${cell.timeRef} — ${cell.categoryName} (Block ${blk.blockNumber} · Round ${rnd.roundNumber})`;

  const origCell = cell.originalValues || {};
  const origInfo = document.createElement('span');
  origInfo.className = 'num';
  origInfo.style.fontSize = '11px';
  origInfo.style.color = 'var(--text-muted)';
  origInfo.textContent = `Sheet raw: Score="${origCell.rawScore || ''}", Time="${origCell.rawTime || ''}"`;

  headerRow.append(title, origInfo);
  box.appendChild(headerRow);

  const grid = document.createElement('div');
  grid.className = 'import-inline-editor-grid';

  // 1. Correct
  const corrGroup = document.createElement('div');
  corrGroup.className = 'form-group';
  corrGroup.style.marginBottom = '0';
  const corrLbl = document.createElement('label');
  corrLbl.className = 'form-label';
  corrLbl.style.fontSize = '11px';
  corrLbl.textContent = 'Correct (0 <= correct <= total)';
  const corrInput = document.createElement('input');
  corrInput.type = 'number';
  corrInput.min = '0';
  corrInput.step = '1';
  corrInput.className = 'form-input num';
  corrInput.style.fontSize = 'var(--text-xs)';
  corrInput.placeholder = 'e.g. 75';
  corrInput.value = cell.correct !== null && cell.correct !== undefined ? String(cell.correct) : '';
  corrGroup.append(corrLbl, corrInput);

  // 2. Total
  const totGroup = document.createElement('div');
  totGroup.className = 'form-group';
  totGroup.style.marginBottom = '0';
  const totLbl = document.createElement('label');
  totLbl.className = 'form-label';
  totLbl.style.fontSize = '11px';
  totLbl.textContent = 'Total (total >= 1)';
  const totInput = document.createElement('input');
  totInput.type = 'number';
  totInput.min = '1';
  totInput.step = '1';
  totInput.className = 'form-input num';
  totInput.style.fontSize = 'var(--text-xs)';
  totInput.placeholder = 'e.g. 75';
  totInput.value = cell.total !== null && cell.total !== undefined ? String(cell.total) : '';
  totGroup.append(totLbl, totInput);

  // 3. Time (m:ss or h:mm:ss, 0 to 4 hours)
  const timeGroup = document.createElement('div');
  timeGroup.className = 'form-group';
  timeGroup.style.marginBottom = '0';
  const timeLbl = document.createElement('label');
  timeLbl.className = 'form-label';
  timeLbl.style.fontSize = '11px';
  timeLbl.textContent = 'Cell Time (m:ss or h:mm:ss, max 4:00:00)';
  const timeInput = document.createElement('input');
  timeInput.type = 'text';
  timeInput.className = 'form-input num';
  timeInput.style.fontSize = 'var(--text-xs)';
  timeInput.placeholder = 'e.g. 1:15 (empty = no time)';
  timeInput.value =
    cell.timeSeconds !== null && cell.timeSeconds !== undefined
      ? formatSecondsDisplay(cell.timeSeconds, false)
      : '';
  timeGroup.append(timeLbl, timeInput);

  // 4. Note (max 500 chars)
  const noteGroup = document.createElement('div');
  noteGroup.className = 'form-group';
  noteGroup.style.marginBottom = '0';
  const noteLbl = document.createElement('label');
  noteLbl.className = 'form-label';
  noteLbl.style.fontSize = '11px';
  noteLbl.textContent = 'Note (max 500 chars; leave score blank for note-only)';
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.maxLength = 500;
  noteInput.className = 'form-input';
  noteInput.style.fontSize = 'var(--text-xs)';
  noteInput.placeholder = 'Optional note...';
  noteInput.value = cell.note || '';
  noteGroup.append(noteLbl, noteInput);

  // 5. Skip this cell switch
  const skipGroup = document.createElement('div');
  skipGroup.className = 'form-group';
  skipGroup.style.marginBottom = '0';
  const skipLblTitle = document.createElement('span');
  skipLblTitle.className = 'form-label';
  skipLblTitle.style.fontSize = '11px';
  skipLblTitle.style.display = 'block';
  skipLblTitle.textContent = 'Skip Cell';

  const skipCheckLbl = document.createElement('label');
  skipCheckLbl.style.display = 'inline-flex';
  skipCheckLbl.style.alignItems = 'center';
  skipCheckLbl.style.gap = '6px';
  skipCheckLbl.style.fontSize = 'var(--text-xs)';
  skipCheckLbl.style.fontWeight = '600';
  skipCheckLbl.style.cursor = 'pointer';
  skipCheckLbl.style.marginTop = '8px';

  const skipCb = document.createElement('input');
  skipCb.type = 'checkbox';
  skipCb.checked = Boolean(cell.cellSkippedByAdmin);

  const skipTxt = document.createElement('span');
  skipTxt.textContent = 'Skip this cell';
  skipCheckLbl.append(skipCb, skipTxt);
  skipGroup.append(skipLblTitle, skipCheckLbl);

  grid.append(corrGroup, totGroup, timeGroup, noteGroup, skipGroup);
  box.appendChild(grid);

  const errBanner = document.createElement('div');
  errBanner.className = 'banner banner-error';
  errBanner.style.display = 'none';
  errBanner.style.marginTop = 'var(--space-2)';
  errBanner.style.fontSize = 'var(--text-xs)';
  box.appendChild(errBanner);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'import-inline-editor-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    activeCellEditor = null;
    renderCurrentPreviewState();
  });

  if (cell.isEdited || cell.cellSkippedByAdmin) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-outline btn-sm';
    resetBtn.textContent = 'Reset to sheet value';
    resetBtn.addEventListener('click', () => {
      resetCellEditToSheetValue(blk.blockNumber, rnd.roundNumber, cell.rowIndex);
    });
    actionsRow.appendChild(resetBtn);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = 'Save Cell Edit';
  saveBtn.addEventListener('click', () => {
    errBanner.style.display = 'none';
    const validation = validateCellEdit({
      skip: skipCb.checked,
      correct: corrInput.value.trim(),
      total: totInput.value.trim(),
      timeRaw: timeInput.value.trim(),
      note: noteInput.value,
    });

    if (!validation.ok) {
      errBanner.textContent = validation.error;
      errBanner.style.display = 'block';
      return;
    }

    const cKey = `${blk.blockNumber}-${rnd.roundNumber}-${cell.rowIndex}`;
    if (!previewEditState.cells) previewEditState.cells = {};
    previewEditState.cells[cKey] = {
      skip: validation.value.skip,
      correct: validation.value.correct,
      total: validation.value.total,
      timeSeconds: validation.value.timeSeconds,
      note: validation.value.note,
    };

    activeCellEditor = null;
    renderCurrentPreviewState();
    showToast(
      'success',
      `Updated ${cell.categoryName} in Block ${blk.blockNumber} · Round ${rnd.roundNumber}.`
    );
  });

  actionsRow.append(cancelBtn, saveBtn);
  box.appendChild(actionsRow);
  td.appendChild(box);
  tr.appendChild(td);

  return tr;
}

/**
 * Builds the inner per-cell inspection, database comparison & Phase 4c-2d cell editing table
 * for an expanded round
 */
function buildRoundCellsDetailTable(rnd, blk, rComp) {
  const container = document.createElement('div');
  container.className = 'table-wrapper';

  if (rComp && rComp.metadataDiffs && rComp.metadataDiffs.length > 0) {
    const metaDiffBanner = document.createElement('div');
    metaDiffBanner.className = 'banner banner-warning';
    metaDiffBanner.style.marginBottom = 'var(--space-3)';
    metaDiffBanner.style.fontSize = 'var(--text-xs)';
    metaDiffBanner.textContent =
      'Round Metadata Differences vs Database: ' +
      rComp.metadataDiffs
        .map((m) => `${m.label}: Sheet = "${m.sheetValue}" vs DB = "${m.dbValue}"`)
        .join(' · ');
    container.appendChild(metaDiffBanner);
  }

  const subTable = document.createElement('table');
  subTable.className = 'table data-table';
  subTable.style.backgroundColor = 'var(--bg-surface)';
  subTable.style.border = '1px solid var(--border-hairline)';

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  const headers = [
    'Score Ref',
    'Time Ref',
    'Category (Sheet → DB)',
    'In CSV / Preview',
    'Existing in Database',
    'Parse Status',
    'DB Comparison',
    'Cell Actions',
  ];
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  subTable.appendChild(thead);

  const tbody = document.createElement('tbody');
  const compByRowIndex = new Map((rComp?.cells || []).map((cc) => [cc.rowIndex, cc]));

  for (const cell of rnd.cells) {
    const cc = compByRowIndex.get(cell.rowIndex) || null;
    const isCellEditorOpen =
      activeCellEditor &&
      activeCellEditor.blockNumber === blk.blockNumber &&
      activeCellEditor.roundNumber === rnd.roundNumber &&
      activeCellEditor.rowIndex === cell.rowIndex;

    const tr = document.createElement('tr');
    if (cell.cellSkippedByAdmin) {
      tr.classList.add('import-row-skipped');
    }

    const tdSRef = document.createElement('td');
    const cS = document.createElement('code');
    cS.className = 'import-cell-ref num';
    cS.textContent = cell.scoreRef;
    tdSRef.appendChild(cS);

    const tdTRef = document.createElement('td');
    const cT = document.createElement('code');
    cT.className = 'import-cell-ref num';
    cT.textContent = cell.timeRef;
    tdTRef.appendChild(cT);

    const tdCat = document.createElement('td');
    tdCat.style.fontWeight = '600';
    if (cc && cc.resolvedCategoryName && cc.resolvedCategoryName !== cell.categoryName) {
      tdCat.textContent = `${cell.categoryName} → ${cc.resolvedCategoryName}`;
    } else {
      tdCat.textContent = cell.categoryName;
    }

    const tdSheetVal = document.createElement('td');
    tdSheetVal.className = 'num';
    const valDiv = document.createElement('div');
    if (cell.cellSkippedByAdmin) {
      valDiv.textContent = 'Skipped by admin';
    } else if (cell.status === 'note') {
      valDiv.textContent = `Note: "${cell.note}"${cell.noteTruncated ? ' (cut to 500 chars)' : ''}`;
    } else if (cell.correct !== null && cell.total !== null) {
      const timeStr =
        cell.timeSeconds !== null
          ? `, ${formatSecondsDisplay(cell.timeSeconds)} (${cell.timeSeconds}s)`
          : '';
      const noteSuffix = cell.note ? ` · Note: "${cell.note}"` : '';
      valDiv.textContent = `${cell.correct} / ${cell.total}${timeStr}${noteSuffix}`;
    } else if (cell.status === 'unreadable') {
      valDiv.textContent = `${cell.rawScore.trim() || '—'} / ${cell.rawTime.trim() || '—'}`;
    } else {
      valDiv.textContent = '— (Empty)';
    }
    tdSheetVal.appendChild(valDiv);

    if (cell.isEdited || cell.cellSkippedByAdmin) {
      const chipWrap = document.createElement('div');
      chipWrap.style.marginTop = '3px';
      const edChip = document.createElement('span');
      edChip.className = 'import-edited-chip';
      edChip.textContent = cell.cellSkippedByAdmin ? '✏️ Skipped' : '✏️ Edited';
      chipWrap.appendChild(edChip);
      tdSheetVal.appendChild(chipWrap);
    }

    const tdDbVal = document.createElement('td');
    tdDbVal.className = 'num';
    if (cc && cc.dbResult) {
      const valSpan = document.createElement('span');
      valSpan.textContent = cc.dbDisplay;
      tdDbVal.appendChild(valSpan);

      if (cc.isVerified) {
        const vTag = document.createElement('span');
        vTag.className = 'badge badge-inactive';
        vTag.style.marginLeft = '6px';
        vTag.textContent = '🔒 Verified';
        tdDbVal.appendChild(vTag);
      }
      if (cc.isCorrected) {
        const cTag = document.createElement('span');
        cTag.className = 'badge badge-inactive';
        cTag.style.marginLeft = '6px';
        cTag.textContent = '✏️ Corrected';
        tdDbVal.appendChild(cTag);
      }
    } else {
      tdDbVal.textContent = '— (Not in DB)';
    }

    const tdParseStatus = document.createElement('td');
    const stBadge = document.createElement('span');
    if (cell.cellSkippedByAdmin) {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = 'Skipped by Admin';
    } else if (cell.status === 'ok') {
      stBadge.className = 'badge badge-success';
      stBadge.textContent = 'OK';
    } else if (cell.status === 'empty') {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = 'Empty';
    } else if (cell.status === 'note') {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = 'Surprise Note';
    } else {
      stBadge.className = 'badge badge-warning';
      stBadge.textContent = cell.reason || 'Unreadable (Skipped)';
    }
    tdParseStatus.appendChild(stBadge);

    const tdCompStatus = document.createElement('td');
    const cmpBadge = document.createElement('span');
    const cmpStatus = cell.cellSkippedByAdmin ? 'skipped' : cc ? cc.comparisonStatus : 'empty';
    if (cmpStatus === 'new') {
      cmpBadge.className = 'badge badge-success';
      cmpBadge.textContent = 'New Score (Will Insert)';
    } else if (cmpStatus === 'identical') {
      cmpBadge.className = 'badge badge-inactive';
      cmpBadge.textContent = 'Identical in DB (Keep)';
    } else if (cmpStatus === 'protected_conflict') {
      cmpBadge.className = 'badge badge-warning';
      cmpBadge.textContent = cc.isVerified
        ? 'Protected (🔒 Verified — Keep DB)'
        : 'Protected (✏️ Corrected — Keep DB)';
    } else if (cmpStatus === 'conflict') {
      cmpBadge.className = 'badge badge-warning';
      cmpBadge.textContent = `Conflict (${cc.diffFields.join(', ')} — Keep DB)`;
    } else if (cmpStatus === 'db_only') {
      cmpBadge.className = 'badge badge-inactive';
      cmpBadge.textContent = 'In DB Only (Kept)';
    } else if (cmpStatus === 'skipped') {
      cmpBadge.className = 'badge badge-inactive';
      cmpBadge.textContent = cell.cellSkippedByAdmin ? 'Cell Skipped' : 'Category Skipped';
    } else if (cmpStatus === 'unresolved_category') {
      cmpBadge.className = 'badge badge-warning';
      cmpBadge.textContent = 'Unresolved Category';
    } else if (cmpStatus === 'unreadable') {
      cmpBadge.className = 'badge badge-warning';
      cmpBadge.textContent = 'Skipped (Unreadable)';
    } else {
      cmpBadge.className = 'badge badge-inactive';
      cmpBadge.textContent = '—';
    }
    tdCompStatus.appendChild(cmpBadge);

    // 8. Cell Actions ("Edit", "Skip this cell", and "Reset to sheet value")
    const tdCellActions = document.createElement('td');
    tdCellActions.style.whiteSpace = 'nowrap';
    const cellBtnWrap = document.createElement('div');
    cellBtnWrap.style.display = 'flex';
    cellBtnWrap.style.flexWrap = 'wrap';
    cellBtnWrap.style.gap = '6px';
    cellBtnWrap.style.alignItems = 'center';

    const editCellBtn = document.createElement('button');
    editCellBtn.type = 'button';
    editCellBtn.className =
      cell.status === 'unreadable' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
    editCellBtn.style.padding = '2px 8px';
    editCellBtn.style.minHeight = '26px';
    editCellBtn.style.fontSize = '11px';
    editCellBtn.textContent = isCellEditorOpen
      ? 'Close'
      : cell.status === 'unreadable'
        ? 'Edit / Fix'
        : 'Edit';
    editCellBtn.addEventListener('click', () => {
      if (isCellEditorOpen) {
        activeCellEditor = null;
        renderCurrentPreviewState();
      } else {
        openCellEditorAndScroll(blk.blockNumber, rnd.roundNumber, cell.rowIndex);
      }
    });
    cellBtnWrap.appendChild(editCellBtn);

    const skipCellBtn = document.createElement('button');
    skipCellBtn.type = 'button';
    skipCellBtn.className = 'btn btn-outline btn-sm';
    skipCellBtn.style.padding = '2px 8px';
    skipCellBtn.style.minHeight = '26px';
    skipCellBtn.style.fontSize = '11px';
    skipCellBtn.textContent = cell.cellSkippedByAdmin ? 'Unskip cell' : 'Skip this cell';
    skipCellBtn.addEventListener('click', () => {
      const cKey = `${blk.blockNumber}-${rnd.roundNumber}-${cell.rowIndex}`;
      if (!previewEditState.cells) previewEditState.cells = {};
      if (cell.cellSkippedByAdmin) {
        delete previewEditState.cells[cKey];
      } else {
        previewEditState.cells[cKey] = {
          skip: true,
        };
      }
      renderCurrentPreviewState();
    });
    cellBtnWrap.appendChild(skipCellBtn);

    if (cell.isEdited || cell.cellSkippedByAdmin) {
      const resetCellBtn = document.createElement('button');
      resetCellBtn.type = 'button';
      resetCellBtn.className = 'btn btn-outline btn-sm';
      resetCellBtn.style.padding = '2px 8px';
      resetCellBtn.style.minHeight = '26px';
      resetCellBtn.style.fontSize = '11px';
      resetCellBtn.textContent = 'Reset to sheet value';
      resetCellBtn.addEventListener('click', () => {
        resetCellEditToSheetValue(blk.blockNumber, rnd.roundNumber, cell.rowIndex);
      });
      cellBtnWrap.appendChild(resetCellBtn);
    }

    tdCellActions.appendChild(cellBtnWrap);

    tr.append(
      tdSRef,
      tdTRef,
      tdCat,
      tdSheetVal,
      tdDbVal,
      tdParseStatus,
      tdCompStatus,
      tdCellActions
    );
    tbody.appendChild(tr);

    if (isCellEditorOpen) {
      tbody.appendChild(buildInlineCellEditorTr(blk, rnd, cell, headers.length));
    }
  }

  // Append any DB-only extra results (categories in DB for this round that are not in the CSV block)
  if (rComp && Array.isArray(rComp.dbOnlyExtraResults)) {
    for (const extra of rComp.dbOnlyExtraResults) {
      const tr = document.createElement('tr');
      const tdSRef = document.createElement('td');
      tdSRef.textContent = '—';
      const tdTRef = document.createElement('td');
      tdTRef.textContent = '—';
      const tdCat = document.createElement('td');
      tdCat.style.fontWeight = '600';
      tdCat.textContent = `${extra.categoryName} (Not in CSV block)`;
      const tdSheet = document.createElement('td');
      tdSheet.textContent = '— (Absent from block)';
      const tdDb = document.createElement('td');
      tdDb.className = 'num';
      tdDb.textContent = extra.dbDisplay;
      const tdParse = document.createElement('td');
      tdParse.textContent = '—';
      const tdComp = document.createElement('td');
      const b = document.createElement('span');
      b.className = 'badge badge-inactive';
      b.textContent = 'In DB Only (Kept)';
      tdComp.appendChild(b);
      const tdAct = document.createElement('td');
      tdAct.textContent = '—';

      tr.append(tdSRef, tdTRef, tdCat, tdSheet, tdDb, tdParse, tdComp, tdAct);
      tbody.appendChild(tr);
    }
  }

  // Also show any stray values belonging to this round at the bottom of the drawer
  const roundStrays = blk.strayValues.filter((s) => s.roundNumber === rnd.roundNumber);
  for (const st of roundStrays) {
    const tr = document.createElement('tr');
    const tdRef = document.createElement('td');
    const cRef = document.createElement('code');
    cRef.className = 'import-cell-ref num';
    cRef.textContent = st.ref;
    tdRef.appendChild(cRef);

    const tdDash = document.createElement('td');
    tdDash.textContent = '—';

    const tdCat = document.createElement('td');
    tdCat.style.fontStyle = 'italic';
    tdCat.style.color = 'var(--color-warning-text)';
    tdCat.textContent = '(No category in row)';

    const tdRawS = document.createElement('td');
    tdRawS.className = 'num';
    tdRawS.textContent = st.rawValue;

    const tdDb = document.createElement('td');
    tdDb.textContent = '—';

    const tdParsed = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge badge-warning';
    badge.textContent = 'Stray Value';
    tdParsed.appendChild(badge);

    const tdStatus = document.createElement('td');
    tdStatus.textContent = 'Ignored (excluded from round sum)';

    const tdAct = document.createElement('td');
    tdAct.textContent = '—';

    tr.append(tdRef, tdDash, tdCat, tdRawS, tdDb, tdParsed, tdStatus, tdAct);
    tbody.appendChild(tr);
  }

  subTable.appendChild(tbody);
  container.appendChild(subTable);
  return container;
}

/**
 * Renders the Phase 4c-2d Record of Edits ("N changes made in this preview" with an expandable list
 * and individual / bulk reset controls) before the Import button in Step 3.
 */
function renderPreviewEditsRecordBox(previewState) {
  const editsBox = document.getElementById('import-edits-record-box');
  if (!editsBox) return;
  editsBox.replaceChildren();

  const editsList = previewState?.editsList || [];
  if (editsList.length === 0) {
    editsBox.style.display = 'none';
    return;
  }

  editsBox.style.display = 'block';

  const details = document.createElement('details');
  details.className = 'import-edits-details';
  details.open = true;

  const summary = document.createElement('summary');
  summary.style.display = 'flex';
  summary.style.justifyContent = 'space-between';
  summary.style.alignItems = 'center';
  summary.style.flexWrap = 'wrap';
  summary.style.gap = 'var(--space-2)';

  const sumTitle = document.createElement('span');
  sumTitle.className = 'num';
  sumTitle.textContent = `✏️ ${formatNum(editsList.length)} change${editsList.length === 1 ? '' : 's'} made in this preview`;

  const resetAllBtn = document.createElement('button');
  resetAllBtn.type = 'button';
  resetAllBtn.className = 'btn btn-outline btn-sm';
  resetAllBtn.style.padding = '2px 8px';
  resetAllBtn.style.minHeight = '24px';
  resetAllBtn.style.fontSize = '11px';
  resetAllBtn.textContent = 'Reset all to sheet values';
  resetAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetAllPreviewEditsToSheetValues();
  });

  summary.append(sumTitle, resetAllBtn);
  details.appendChild(summary);

  const ul = document.createElement('ul');
  ul.className = 'import-edits-list num';

  for (const edit of editsList) {
    const li = document.createElement('li');

    const textSpan = document.createElement('span');
    const origStr =
      edit.original_value === null || edit.original_value === undefined || edit.original_value === ''
        ? '(empty)'
        : String(edit.original_value);
    const newStr =
      edit.new_value === null || edit.new_value === undefined || edit.new_value === ''
        ? '(empty)'
        : String(edit.new_value);
    const skipTag = edit.skipped ? ' [Skipped]' : '';
    textSpan.textContent = `Block ${edit.block_number} · Round ${edit.round_number} (${edit.series}) — ${edit.field}: ${origStr} → ${newStr}${skipTag}`;

    const itemResetBtn = document.createElement('button');
    itemResetBtn.type = 'button';
    itemResetBtn.className = 'btn btn-outline btn-sm';
    itemResetBtn.style.padding = '1px 6px';
    itemResetBtn.style.minHeight = '22px';
    itemResetBtn.style.fontSize = '11px';
    itemResetBtn.textContent = 'Reset to sheet value';
    itemResetBtn.addEventListener('click', () => {
      if (edit.scope === 'cell' && edit.row_index !== null && edit.row_index !== undefined) {
        resetCellEditToSheetValue(edit.block_number, edit.round_number, edit.row_index);
      } else {
        resetRoundEditToSheetValue(edit.block_number, edit.round_number);
      }
    });

    li.append(textSpan, itemResetBtn);
    ul.appendChild(li);
  }

  details.appendChild(ul);
  editsBox.appendChild(details);
}

/**
 * Updates the bottom Step 3 readiness indicator, Record of Edits box, Acknowledgments & Excluded Rounds summary box,
 * Pre-flight `validatePayload` problems box, and Import button state
 */
function renderReadinessAndActionState(previewState, executionPlan, selectedStudent) {
  const statusEl = document.getElementById('import-readiness-status');
  const hintEl = document.getElementById('import-action-hint');
  const importBtn = document.getElementById('btn-import-execute');
  const ackBox = document.getElementById('import-acknowledgments-box');
  const payloadBox = document.getElementById('import-payload-validation-box');
  if (!statusEl || !importBtn) return;

  renderPreviewEditsRecordBox(previewState);

  if (ackBox) {
    ackBox.replaceChildren();
    const acks = executionPlan?.acknowledgments || [];
    const excluded = executionPlan?.excludedRounds || [];
    if (acks.length > 0 || excluded.length > 0) {
      ackBox.style.display = 'block';
      const ackTitle = document.createElement('div');
      ackTitle.style.fontWeight = '700';
      ackTitle.style.fontSize = 'var(--text-xs)';
      ackTitle.style.marginBottom = '6px';
      ackTitle.textContent = `Acknowledgment List (${formatNum(acks.length)} group${acks.length === 1 ? '' : 's'}${excluded.length > 0 ? `, ${formatNum(excluded.length)} excluded round${excluded.length === 1 ? '' : 's'}` : ''}):`;
      ackBox.appendChild(ackTitle);

      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      ul.style.fontSize = 'var(--text-xs)';
      ul.style.display = 'flex';
      ul.style.flexDirection = 'column';
      ul.style.gap = '4px';

      for (const ack of acks) {
        const li = document.createElement('li');
        li.textContent = `${ack.label} (${formatNum(ack.count)})`;
        if (Array.isArray(ack.items) && ack.items.length > 0) {
          const detailSpan = document.createElement('div');
          detailSpan.style.color = 'var(--text-muted)';
          detailSpan.style.fontSize = '11px';
          detailSpan.textContent = ack.items.slice(0, 3).join(' · ');
          li.appendChild(detailSpan);
        }
        ul.appendChild(li);
      }

      if (excluded.length > 0) {
        const liEx = document.createElement('li');
        liEx.textContent =
          `Excluded rounds not sent to database (${formatNum(excluded.length)}): ` +
          excluded
            .map((er) => `Block ${er.blockNumber} Round ${er.roundNumber} (${er.reason})`)
            .join('; ');
        ul.appendChild(liEx);
      }

      ackBox.appendChild(ul);
    } else {
      ackBox.style.display = 'none';
    }
  }

  if (payloadBox) {
    payloadBox.replaceChildren();
    const problems = executionPlan?.payloadProblems || [];
    if (problems.length > 0) {
      payloadBox.style.display = 'block';
      const pTitle = document.createElement('div');
      pTitle.style.fontWeight = '700';
      pTitle.style.fontSize = 'var(--text-xs)';
      pTitle.style.marginBottom = '4px';
      pTitle.textContent = `Pre-flight Payload Validation Blocked Import (${formatNum(problems.length)} problem${problems.length === 1 ? '' : 's'}):`;
      payloadBox.appendChild(pTitle);

      const pList = document.createElement('ul');
      pList.style.margin = '0';
      pList.style.paddingLeft = '18px';
      pList.style.fontSize = 'var(--text-xs)';
      for (const prob of problems) {
        const li = document.createElement('li');
        li.className = 'num';
        li.textContent = prob.message;
        pList.appendChild(li);
      }
      payloadBox.appendChild(pList);
    } else {
      payloadBox.style.display = 'none';
    }
  }

  const isReady = Boolean(executionPlan && executionPlan.readyToImport && !isImporting);

  if (!isReady) {
    const count = executionPlan ? executionPlan.blockingReasons.length : 1;
    statusEl.className = 'badge num';
    statusEl.style.backgroundColor = 'var(--color-danger-subtle)';
    statusEl.style.color = 'var(--color-danger-text)';
    statusEl.textContent = `${formatNum(count)} Blocking Issue${count === 1 ? '' : 's'} Remaining`;

    if (hintEl) {
      hintEl.textContent =
        executionPlan && executionPlan.blockingReasons.length > 0
          ? executionPlan.blockingReasons[0]
          : 'Resolve blocking issues above to enable import.';
    }

    importBtn.disabled = true;
    importBtn.setAttribute('aria-disabled', 'true');
    importBtn.textContent = 'Import Score Sheet';
  } else {
    statusEl.className = 'badge badge-success num';
    statusEl.style.backgroundColor = '';
    statusEl.style.color = '';
    statusEl.textContent = `✓ Ready to Import (${formatNum(executionPlan.totalRounds)} round${
      executionPlan.totalRounds === 1 ? '' : 's'
    } · ${formatNum(executionPlan.rowsFound)} score cell${executionPlan.rowsFound === 1 ? '' : 's'})`;

    if (hintEl && selectedStudent) {
      hintEl.textContent = `Ready to save import for ${selectedStudent.full_name} (${selectedStudent.student_code}).`;
    }

    importBtn.disabled = false;
    importBtn.removeAttribute('aria-disabled');
    importBtn.textContent = `Import Score Sheet (${formatNum(executionPlan.totalRounds)} Rounds)`;
  }
}

/**
 * Populates and opens the Confirm Import Modal (`#confirm-import-modal`)
 */
function openConfirmImportModal(executionPlan) {
  const bodyEl = document.getElementById('confirm-import-modal-body');
  if (!bodyEl) return;
  bodyEl.replaceChildren();

  const summaryBox = document.createElement('div');
  summaryBox.style.backgroundColor = 'var(--bg-surface-subtle)';
  summaryBox.style.padding = 'var(--space-3)';
  summaryBox.style.borderRadius = 'var(--radius-sm)';
  summaryBox.style.border = '1px solid var(--border-hairline)';
  summaryBox.style.fontSize = 'var(--text-xs)';
  summaryBox.style.display = 'flex';
  summaryBox.style.flexDirection = 'column';
  summaryBox.style.gap = '6px';
  summaryBox.style.marginBottom = 'var(--space-3)';

  const addSummaryLine = (label, valueText) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'flex-start';
    row.style.flexWrap = 'wrap';
    row.style.gap = 'var(--space-2)';
    const lSpan = document.createElement('span');
    lSpan.style.color = 'var(--text-muted)';
    lSpan.textContent = label;
    const vStrong = document.createElement('strong');
    vStrong.style.color = 'var(--text-main)';
    vStrong.className = 'num';
    vStrong.textContent = valueText;
    row.append(lSpan, vStrong);
    summaryBox.appendChild(row);
  };

  addSummaryLine(
    'Target Student:',
    `${executionPlan.studentName} (${executionPlan.studentCode})`
  );
  addSummaryLine('CSV File:', executionPlan.fileName);
  addSummaryLine('Name in CSV Sheet:', executionPlan.nameInFile || '(None)');
  addSummaryLine(
    'Blocks & Series:',
    executionPlan.blockPlans
      .map(
        (bp) =>
          `Block ${bp.blockNumber} → ${bp.seriesName} (${formatNum(bp.rounds.length)} rounds)`
      )
      .join(' · ')
  );
  addSummaryLine(
    'Total Rounds & Cells:',
    `${formatNum(executionPlan.totalRounds)} rounds · ${formatNum(executionPlan.rowsFound)} score cells`
  );

  const editsCount = Array.isArray(executionPlan.edits) ? executionPlan.edits.length : 0;
  if (editsCount > 0) {
    addSummaryLine(
      'Preview Edits Applied:',
      `${formatNum(editsCount)} change${editsCount === 1 ? '' : 's'} (recorded in batch summary)`
    );
  }

  addSummaryLine(
    'Mark Verified (p_mark_verified):',
    executionPlan.markVerified ? 'Yes (🔒 Verified)' : 'No (Unverified)'
  );
  addSummaryLine(
    'Date Conflict Policy:',
    executionPlan.onDateConflict === 'skip'
      ? 'skip (Skip rounds with date conflict)'
      : 'use_existing (Merge into existing round)'
  );

  const totalEnsuredCats = executionPlan.blockPlans.reduce(
    (s, bp) => s + bp.categoriesToEnsure.length,
    0
  );
  const totalAliases = executionPlan.blockPlans.reduce(
    (s, bp) => s + bp.aliasesToSave.length,
    0
  );
  if (totalEnsuredCats > 0) {
    const catList = executionPlan.blockPlans
      .flatMap((bp) =>
        bp.categoriesToEnsure.map((c) =>
          c.mode === 'create_historical'
            ? `"${c.sheetName}" (new inactive in ${bp.seriesName})`
            : `"${c.sheetName}" (link to ${bp.seriesName})`
        )
      )
      .join(', ');
    addSummaryLine('Categories to Link / Create:', catList);
  }
  if (totalAliases > 0) {
    const aliasList = executionPlan.blockPlans
      .flatMap((bp) => bp.aliasesToSave.map((a) => `"${a.alias}" → ${a.targetCategoryName}`))
      .join(', ');
    addSummaryLine('Aliases to Save:', aliasList);
  }

  bodyEl.appendChild(summaryBox);

  const acks = executionPlan.acknowledgments || [];
  const excluded = executionPlan.excludedRounds || [];
  if (acks.length > 0 || excluded.length > 0) {
    const ackModalBox = document.createElement('div');
    ackModalBox.className = 'banner banner-warning';
    ackModalBox.style.marginBottom = 'var(--space-3)';
    ackModalBox.style.fontSize = 'var(--text-xs)';

    const ackHeader = document.createElement('strong');
    ackHeader.style.display = 'block';
    ackHeader.style.marginBottom = '4px';
    ackHeader.textContent = `Acknowledgments & Adjustments (${formatNum(acks.length)} group${acks.length === 1 ? '' : 's'}):`;
    ackModalBox.appendChild(ackHeader);

    const ackUl = document.createElement('ul');
    ackUl.style.margin = '0';
    ackUl.style.paddingLeft = '18px';
    for (const ack of acks) {
      const li = document.createElement('li');
      li.textContent = `${ack.label} (${formatNum(ack.count)})`;
      ackUl.appendChild(li);
    }
    for (const ex of excluded) {
      const li = document.createElement('li');
      li.textContent = `Excluded: Block ${ex.blockNumber} Round ${ex.roundNumber} (${ex.reason})`;
      ackUl.appendChild(li);
    }
    ackModalBox.appendChild(ackUl);
    bodyEl.appendChild(ackModalBox);
  }

  if (executionPlan.studentNameMismatch) {
    const warnBox = document.createElement('div');
    warnBox.className = 'banner banner-warning';
    warnBox.style.marginBottom = 'var(--space-3)';
    warnBox.style.display = 'flex';
    warnBox.style.flexDirection = 'column';
    warnBox.style.gap = 'var(--space-2)';

    const warnTitle = document.createElement('strong');
    warnTitle.style.fontSize = 'var(--text-xs)';
    warnTitle.textContent = `⚠️ Student Name Mismatch: Sheet says "${executionPlan.nameInFile}", but selected student is "${executionPlan.studentName} (${executionPlan.studentCode})".`;

    const checkLabel = document.createElement('label');
    checkLabel.style.display = 'flex';
    checkLabel.style.alignItems = 'flex-start';
    checkLabel.style.gap = '8px';
    checkLabel.style.fontSize = 'var(--text-xs)';
    checkLabel.style.cursor = 'pointer';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'confirm-name-mismatch-checkbox';
    cb.style.marginTop = '2px';

    const cbSpan = document.createElement('span');
    cbSpan.textContent = `I confirm that this CSV file belongs to ${executionPlan.studentName} (${executionPlan.studentCode}).`;

    checkLabel.append(cb, cbSpan);
    warnBox.append(warnTitle, checkLabel);
    bodyEl.appendChild(warnBox);
  }

  const safetyNote = document.createElement('p');
  safetyNote.style.fontSize = 'var(--text-xs)';
  safetyNote.style.color = 'var(--text-muted)';
  safetyNote.style.margin = '0';
  safetyNote.textContent =
    'Existing cells in the database are never overwritten. You can undo this import batch at any time from the Import History table below.';
  bodyEl.appendChild(safetyNote);

  openModal('confirm-import-modal');
}

/**
 * Renders structured failure message with:
 * 1. Exact database message
 * 2. Plain-words explanation (nothing from the failing call was saved, an "Open" batch with 0 rows
 *    may appear in the history and can be undone with a reason, and running the same import again is safe)
 * 3. Expandable "Technical details" section with: which step failed, the series, the round numbers
 *    in that call, and for the first 3 rounds of that call their round_number, round_date,
 *    round_type, time_taken_seconds and number of cells (no secret or key).
 */
function renderImportFailureBanner(progressBanner, dbErrorMessage, techContext) {
  if (!progressBanner) return;
  progressBanner.style.display = 'block';
  progressBanner.className = 'banner banner-error';
  progressBanner.replaceChildren();

  const exactLine = document.createElement('div');
  exactLine.style.fontWeight = '700';
  exactLine.style.fontSize = 'var(--text-sm)';
  exactLine.textContent = `Import failed: ${dbErrorMessage}`;
  progressBanner.appendChild(exactLine);

  const plainWords = document.createElement('p');
  plainWords.style.fontSize = 'var(--text-xs)';
  plainWords.style.marginTop = '6px';
  plainWords.style.marginBottom = '0';
  plainWords.style.lineHeight = '1.45';
  plainWords.textContent =
    'What happened: Nothing from the failing call was saved. An "Open" batch with 0 rows may appear in the Import History below and can be undone with a reason. Running the same import again is safe.';
  progressBanner.appendChild(plainWords);

  if (techContext) {
    const detailsEl = document.createElement('details');
    detailsEl.className = 'import-tech-details';

    const summaryEl = document.createElement('summary');
    summaryEl.textContent = 'Technical details';
    detailsEl.appendChild(summaryEl);

    const bodyDiv = document.createElement('div');
    bodyDiv.style.marginTop = 'var(--space-2)';
    bodyDiv.style.display = 'flex';
    bodyDiv.style.flexDirection = 'column';
    bodyDiv.style.gap = '4px';
    bodyDiv.className = 'num';

    const addTechLine = (label, val) => {
      const line = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      const span = document.createElement('span');
      span.textContent = val;
      line.append(strong, span);
      bodyDiv.appendChild(line);
    };

    addTechLine('Failed step', techContext.step || 'Unknown step');
    addTechLine('Simulator series', techContext.series || 'N/A');

    const roundNums = Array.isArray(techContext.roundNumbers) ? techContext.roundNumbers : [];
    addTechLine(
      'Round numbers in call',
      roundNums.length > 0 ? roundNums.join(', ') : 'None'
    );

    if (Array.isArray(techContext.firstThreeRounds) && techContext.firstThreeRounds.length > 0) {
      const sampleHeader = document.createElement('div');
      sampleHeader.style.fontWeight = '700';
      sampleHeader.style.marginTop = '4px';
      sampleHeader.textContent = `First ${techContext.firstThreeRounds.length} round(s) in call:`;
      bodyDiv.appendChild(sampleHeader);

      for (const r of techContext.firstThreeRounds) {
        const rLine = document.createElement('div');
        rLine.style.paddingLeft = '8px';
        rLine.textContent = `• round_number: ${r.round_number}, round_date: ${r.round_date}, round_type: ${r.round_type ?? 'null'}, time_taken_seconds: ${r.time_taken_seconds ?? 'null'}, cells: ${r.cellsCount}`;
        bodyDiv.appendChild(rLine);
      }
    }

    detailsEl.appendChild(bodyDiv);
    progressBanner.appendChild(detailsEl);
  }
}

/**
 * Executes the planned import strictly using the Phase 4c-2b/2c/2d database RPCs:
 * 0. Runs `validatePayload(payload)` on every planned chunk BEFORE calling the database.
 *    If any problem is returned, does not call the database and shows the problem list.
 * 1. `admin_start_import(p_student, p_file_name, p_name_in_file, p_mark_verified, p_rows_found, p_summary)`
 *    (with `p_summary.edits` containing up to 500 preview edits + count)
 * 2. `admin_import_ensure_category(p_batch, p_series, p_category, p_new_name)` + `category_aliases` upsert
 * 3. `admin_import_rounds(p_batch, p_series, p_rounds, p_on_date_conflict)` in chunks (<=100 rounds, <=3000 cells)
 * 4. `admin_finish_import(p_batch)`
 */
async function executePlannedImport(executionPlan) {
  if (!executionPlan || !executionPlan.readyToImport || isImporting) return;

  const progressBanner = document.getElementById('import-progress-banner');
  const payloadBox = document.getElementById('import-payload-validation-box');

  // STEP 0: Pre-flight `validatePayload(payload)` check BEFORE any database RPC call
  const preFlightProblems = [];
  for (const bp of executionPlan.blockPlans || []) {
    const previewChunks = Array.isArray(bp.roundChunks) ? bp.roundChunks : [];
    for (const chunk of previewChunks) {
      const probs = validatePayload(chunk, { todayIST: todayIST || getISTDateString(new Date()) });
      for (const p of probs) {
        preFlightProblems.push({
          ...p,
          blockNumber: bp.blockNumber,
        });
      }
    }
  }

  if (preFlightProblems.length > 0) {
    if (payloadBox) {
      payloadBox.replaceChildren();
      payloadBox.style.display = 'block';
      const title = document.createElement('div');
      title.style.fontWeight = '700';
      title.style.fontSize = 'var(--text-xs)';
      title.style.marginBottom = '4px';
      title.textContent = `Pre-flight validatePayload found ${formatNum(preFlightProblems.length)} problem${preFlightProblems.length === 1 ? '' : 's'} — database was NOT called:`;
      payloadBox.appendChild(title);

      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      ul.style.fontSize = 'var(--text-xs)';
      for (const prob of preFlightProblems) {
        const li = document.createElement('li');
        li.className = 'num';
        li.textContent = `Block ${prob.blockNumber} · Round ${prob.roundNumber ?? 'N/A'} · ${prob.field}: ${JSON.stringify(prob.value)} (${prob.message})`;
        ul.appendChild(li);
      }
      payloadBox.appendChild(ul);
    }
    showToast('error', 'Import blocked by pre-flight payload validation.');
    return;
  }

  isImporting = true;
  const importBtn = document.getElementById('btn-import-execute');

  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
  }

  const updateProgress = (msg) => {
    if (!progressBanner) return;
    progressBanner.style.display = 'block';
    progressBanner.className = 'banner banner-info';
    progressBanner.textContent = msg;
  };

  let batchId = null;
  const cumulativeTotals = {
    rounds_created: 0,
    rounds_merged: 0,
    rounds_skipped: 0,
    cells_inserted: 0,
    cells_skipped: 0,
  };

  const editsAppliedCount = Array.isArray(executionPlan.edits)
    ? executionPlan.edits.length
    : 0;

  let currentTechContext = {
    step: 'Step 1/4: admin_start_import',
    series: executionPlan.blockPlans.map((bp) => bp.seriesName).join(', '),
    roundNumbers: [],
    firstThreeRounds: [],
  };

  try {
    const useLiveSupabase = isSupabaseConfigured();
    const supabase = useLiveSupabase ? await getSupabase() : null;

    // STEP 1: Start import batch via `admin_start_import`
    updateProgress(`Step 1/4: Starting import batch for ${executionPlan.studentName}...`);
    const startParams = {
      p_student: executionPlan.studentId,
      p_file_name: executionPlan.fileName,
      p_name_in_file: executionPlan.nameInFile,
      p_mark_verified: Boolean(executionPlan.markVerified),
      p_rows_found: Number(executionPlan.rowsFound) || 0,
      p_summary: executionPlan.summaryPayload || {},
    };

    if (useLiveSupabase) {
      const { data: startData, error: startErr } = await supabase.rpc(
        'admin_start_import',
        startParams
      );
      if (startErr) throw new Error(startErr.message);
      batchId = extractScalarId(startData, ['id', 'batch_id', 'admin_start_import']);
      if (!batchId) {
        throw new Error('admin_start_import did not return a valid batch ID.');
      }
    } else {
      batchId = DemoDB.adminStartImport(startParams, currentAdmin?.id);
    }

    // STEP 2 & 3: Per block — ensure categories, save aliases, and import rounds in chunks
    for (let bIdx = 0; bIdx < executionPlan.blockPlans.length; bIdx++) {
      const bp = executionPlan.blockPlans[bIdx];
      const ensuredCategoryByRowIndex = new Map();

      // 2a. Ensure categories for this block (`admin_import_ensure_category`)
      if (bp.categoriesToEnsure.length > 0) {
        currentTechContext = {
          step: `Step 2/4: admin_import_ensure_category (Block ${bp.blockNumber})`,
          series: `${bp.seriesName} (${bp.seriesId})`,
          roundNumbers: bp.rounds.map((r) => r.round_number),
          firstThreeRounds: bp.rounds.slice(0, 3).map((r) => ({
            round_number: r.round_number,
            round_date: r.round_date,
            round_type: r.round_type,
            time_taken_seconds: r.time_taken_seconds,
            cellsCount: Array.isArray(r.cells) ? r.cells.length : 0,
          })),
        };

        updateProgress(
          `Step 2/4: Ensuring ${formatNum(bp.categoriesToEnsure.length)} categor${
            bp.categoriesToEnsure.length === 1 ? 'y' : 'ies'
          } for Block ${bp.blockNumber} (${bp.seriesName})...`
        );

        for (const catEnsure of bp.categoriesToEnsure) {
          const ensureParams = {
            p_batch: batchId,
            p_series: bp.seriesId,
            p_category: catEnsure.p_category || null,
            p_new_name: catEnsure.p_new_name || null,
          };

          let ensuredCatId = null;
          if (useLiveSupabase) {
            const { data: ensData, error: ensErr } = await supabase.rpc(
              'admin_import_ensure_category',
              ensureParams
            );
            if (ensErr) throw new Error(ensErr.message);
            ensuredCatId = extractScalarId(ensData, [
              'category_id',
              'id',
              'admin_import_ensure_category',
            ]);
          } else {
            ensuredCatId = DemoDB.adminImportEnsureCategory(ensureParams);
          }

          if (!ensuredCatId) {
            throw new Error(
              `admin_import_ensure_category did not return a category ID for "${catEnsure.sheetName}".`
            );
          }
          ensuredCategoryByRowIndex.set(catEnsure.rowIndex, ensuredCatId);
        }
      }

      // 2b. Save any new category aliases in `category_aliases`
      for (const aliasItem of bp.aliasesToSave) {
        const targetCatId =
          ensuredCategoryByRowIndex.get(aliasItem.rowIndex) || aliasItem.category_id;
        if (aliasItem.alias && targetCatId) {
          if (useLiveSupabase) {
            const { error: aliasErr } = await supabase
              .from('category_aliases')
              .upsert(
                { alias: aliasItem.alias, category_id: targetCatId },
                { onConflict: 'alias' }
              );
            if (aliasErr) {
              console.warn('Could not save category alias:', aliasErr.message);
            }
          } else {
            DemoDB.upsertCategoryAlias(aliasItem.alias, targetCatId);
          }
        }
      }

      // 3. Materialize round chunks (1..100 rounds and <= 3000 cells per call), validatePayload, and call `admin_import_rounds`
      const roundChunks = materializeBlockRoundChunks(bp, ensuredCategoryByRowIndex);

      for (let cIdx = 0; cIdx < roundChunks.length; cIdx++) {
        const chunk = roundChunks[cIdx];
        currentTechContext = {
          step: `Step 3/4: admin_import_rounds (Block ${bp.blockNumber}, call ${cIdx + 1} of ${roundChunks.length})`,
          series: `${bp.seriesName} (${bp.seriesId})`,
          roundNumbers: chunk.map((r) => r.round_number),
          firstThreeRounds: chunk.slice(0, 3).map((r) => ({
            round_number: r.round_number,
            round_date: r.round_date,
            round_type: r.round_type,
            time_taken_seconds: r.time_taken_seconds,
            cellsCount: Array.isArray(r.cells) ? r.cells.length : 0,
          })),
        };

        // Run validatePayload on the materialized chunk right before sending to DB
        const chunkProblems = validatePayload(chunk, {
          todayIST: todayIST || getISTDateString(new Date()),
        });
        if (chunkProblems.length > 0) {
          throw new Error(
            `Payload validation failed before calling admin_import_rounds: ${chunkProblems
              .map((p) => p.message)
              .join('; ')}`
          );
        }

        updateProgress(
          `Step 3/4: Importing Block ${bp.blockNumber} (${bp.seriesName}) — call ${cIdx + 1} of ${
            roundChunks.length
          } (${formatNum(chunk.length)} round${chunk.length === 1 ? '' : 's'})...`
        );

        const roundsParams = {
          p_batch: batchId,
          p_series: bp.seriesId,
          p_rounds: chunk,
          p_on_date_conflict: executionPlan.onDateConflict,
        };

        let chunkResult = null;
        if (useLiveSupabase) {
          const { data: rData, error: rErr } = await supabase.rpc(
            'admin_import_rounds',
            roundsParams
          );
          if (rErr) throw new Error(rErr.message);
          chunkResult = extractRpcObject(rData);
        } else {
          chunkResult = DemoDB.adminImportRounds(roundsParams);
        }

        cumulativeTotals.rounds_created += Number(chunkResult.rounds_created) || 0;
        cumulativeTotals.rounds_merged += Number(chunkResult.rounds_merged) || 0;
        cumulativeTotals.rounds_skipped += Number(chunkResult.rounds_skipped) || 0;
        cumulativeTotals.cells_inserted += Number(chunkResult.cells_inserted) || 0;
        cumulativeTotals.cells_skipped += Number(chunkResult.cells_skipped) || 0;
      }
    }

    // STEP 4: Finish import batch (`admin_finish_import`)
    currentTechContext = {
      step: 'Step 4/4: admin_finish_import',
      series: executionPlan.blockPlans.map((bp) => bp.seriesName).join(', '),
      roundNumbers: [],
      firstThreeRounds: [],
    };
    updateProgress('Step 4/4: Finalizing import batch...');
    if (useLiveSupabase) {
      const { error: finErr } = await supabase.rpc('admin_finish_import', {
        p_batch: batchId,
      });
      if (finErr) throw new Error(finErr.message);
    } else {
      DemoDB.adminFinishImport({ p_batch: batchId });
    }

    if (progressBanner) {
      progressBanner.style.display = 'none';
    }

    // Clear unsaved preview edits once saved to the database
    previewEditState = createEmptyEditState();
    activeRoundEditor = null;
    activeCellEditor = null;
    hideUnsavedEditsWarning();

    const editsToastPart =
      editsAppliedCount > 0
        ? ` (${formatNum(editsAppliedCount)} preview edit${editsAppliedCount === 1 ? '' : 's'} applied)`
        : '';

    showToast(
      'success',
      `Import complete: ${formatNum(cumulativeTotals.rounds_created)} rounds created, ${formatNum(cumulativeTotals.rounds_merged)} merged, ${formatNum(cumulativeTotals.cells_inserted)} scores inserted${editsToastPart}.`
    );

    renderImportResultBanner({
      type: 'import_success',
      batchId,
      studentId: executionPlan.studentId,
      studentName: executionPlan.studentName,
      studentCode: executionPlan.studentCode,
      fileName: executionPlan.fileName,
      totals: cumulativeTotals,
      editsAppliedCount,
    });

    // Reload reference data (new categories/series links/aliases), student rounds/results, preview, and history
    await loadReferenceData(true);
    await ensureStudentExistingDataLoaded(executionPlan.studentId, true);
    await loadImportBatches();
    renderCurrentPreviewState();
  } catch (err) {
    console.error('Import failed:', err);
    const readableMsg = err.message || 'An unexpected error occurred during import.';
    renderImportFailureBanner(progressBanner, readableMsg, currentTechContext);
    showToast('error', `Import failed: ${readableMsg}`);
    await loadImportBatches();
  } finally {
    isImporting = false;
    if (currentPreviewState && currentExecutionPlan) {
      renderReadinessAndActionState(
        currentPreviewState,
        currentExecutionPlan,
        getSelectedStudent()
      );
    }
  }
}

/**
 * Renders the top operation result banner (`#import-operation-result-banner`) after an import or undo,
 * including how many preview edits were applied (Phase 4c-2d).
 */
function renderImportResultBanner(result) {
  const banner = document.getElementById('import-operation-result-banner');
  if (!banner) return;
  banner.replaceChildren();
  banner.style.display = 'block';

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'flex-start';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-3)';

  const left = document.createElement('div');
  const title = document.createElement('h2');
  title.style.fontSize = 'var(--text-base)';
  title.style.marginBottom = '4px';

  const countsRow = document.createElement('div');
  countsRow.style.display = 'flex';
  countsRow.style.flexWrap = 'wrap';
  countsRow.style.gap = 'var(--space-2)';
  countsRow.style.marginTop = 'var(--space-2)';

  const makeCountChip = (label, count, badgeClass = 'badge-inactive') => {
    const span = document.createElement('span');
    span.className = `badge ${badgeClass} num`;
    span.textContent = `${label}: ${formatNum(count)}`;
    return span;
  };

  if (result.type === 'import_success') {
    const editsCount = Number(result.editsAppliedCount || 0);
    const editsSuffix =
      editsCount > 0
        ? ` · ${formatNum(editsCount)} preview edit${editsCount === 1 ? '' : 's'} applied`
        : '';
    title.textContent = `✓ Import Saved for ${result.studentName} (${result.studentCode}) — ${result.fileName}${editsSuffix}`;
    const t = result.totals;
    countsRow.append(
      makeCountChip('Rounds Created', t.rounds_created, 'badge-success'),
      makeCountChip('Rounds Merged', t.rounds_merged, 'badge-success'),
      makeCountChip('Rounds Skipped', t.rounds_skipped, 'badge-inactive'),
      makeCountChip('Scores Inserted', t.cells_inserted, 'badge-success'),
      makeCountChip('Scores Skipped (Existing Kept)', t.cells_skipped, 'badge-inactive'),
      makeCountChip(
        'Edits Applied in Preview',
        editsCount,
        editsCount > 0 ? 'badge-warning' : 'badge-inactive'
      )
    );
  } else {
    title.textContent = `↩ Import Batch Undone (Reason: "${result.reason}")`;
    const u = result.undoTotals;
    countsRow.append(
      makeCountChip('Scores Deleted', u.results_deleted, 'badge-warning'),
      makeCountChip('Protected Scores Kept', u.results_kept, 'badge-success'),
      makeCountChip('Empty Rounds Deleted', u.rounds_deleted, 'badge-warning')
    );
  }

  left.append(title, countsRow);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = 'var(--space-2)';
  actions.style.alignItems = 'center';
  actions.style.flexWrap = 'wrap';

  if (result.studentId) {
    const stuLink = document.createElement('a');
    stuLink.className = 'btn btn-primary btn-sm';
    stuLink.href = `/pages/student-detail.html?id=${encodeURIComponent(result.studentId)}`;
    stuLink.textContent = 'View Student Detail →';
    actions.appendChild(stuLink);
  }

  if (result.type === 'import_success' && result.batchId) {
    const undoNowBtn = document.createElement('button');
    undoNowBtn.type = 'button';
    undoNowBtn.className = 'btn btn-outline btn-sm';
    undoNowBtn.textContent = 'Undo This Import';
    undoNowBtn.addEventListener('click', () => {
      const batchObj = importBatches.find((b) => b.id === result.batchId) || {
        id: result.batchId,
        fileName: result.fileName,
        studentName: result.studentName,
        studentCode: result.studentCode,
      };
      openUndoImportModal(batchObj);
    });
    actions.appendChild(undoNowBtn);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn btn-outline btn-sm';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    banner.style.display = 'none';
  });
  actions.appendChild(dismissBtn);

  headerRow.append(left, actions);
  banner.appendChild(headerRow);
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Renders the Import History & Undo table (`import_batches`), including Phase 4c-2d
 * "N values adjusted in preview" and an expandable list of recorded edits from `batch.summary.edits`.
 */
function renderImportHistoryTable() {
  const container = document.getElementById('import-history-container');
  if (!container) return;
  container.replaceChildren();

  const filterSelect = document.getElementById('import-history-filter');
  const filterMode = filterSelect ? filterSelect.value : 'all';
  const selectedStudent = getSelectedStudent();

  let list = [...importBatches];
  if (filterMode === 'selected' && selectedStudent) {
    list = list.filter((b) => b.student_id === selectedStudent.id);
  }

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = 'var(--space-6)';
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontSize = 'var(--text-xs)';
    empty.textContent =
      filterMode === 'selected' && selectedStudent
        ? `No import batches recorded yet for ${selectedStudent.full_name} (${selectedStudent.student_code}).`
        : 'No CSV import batches recorded yet.';
    container.appendChild(empty);
    return;
  }

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-wrapper';
  tableWrapper.style.border = '1px solid var(--border-hairline)';
  tableWrapper.style.borderRadius = 'var(--radius-md)';

  const table = document.createElement('table');
  table.className = 'table data-table';

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  [
    'Imported (IST)',
    'Student',
    'CSV File & Sheet Name',
    'Verified',
    'Rows (Imported / Found)',
    'Status & Undo Info',
    'Action',
  ].forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const batch of list) {
    const tr = document.createElement('tr');

    // 1. Imported At
    const tdDate = document.createElement('td');
    tdDate.className = 'num';
    tdDate.style.fontSize = 'var(--text-xs)';
    tdDate.style.whiteSpace = 'nowrap';
    if (batch.importedAt) {
      const dateStr = String(batch.importedAt).slice(0, 10);
      tdDate.textContent = normalizeShortMonths(formatDisplayDateIST(dateStr));
    } else {
      tdDate.textContent = '—';
    }

    // 2. Student
    const tdStu = document.createElement('td');
    const stuStrong = document.createElement('div');
    stuStrong.style.fontWeight = '600';
    stuStrong.textContent = batch.studentName || 'Student';
    const stuSub = document.createElement('div');
    stuSub.style.fontSize = '11px';
    stuSub.style.color = 'var(--text-dim)';
    stuSub.className = 'num';
    stuSub.textContent = batch.studentCode || batch.student_id || '—';
    tdStu.append(stuStrong, stuSub);

    // 3. File & Name in File + Phase 4c-2d "N values adjusted in preview" expandable list
    const tdFile = document.createElement('td');
    const fMain = document.createElement('div');
    fMain.style.fontWeight = '600';
    fMain.textContent = batch.fileName || 'scoresheet.csv';
    const fSub = document.createElement('div');
    fSub.style.fontSize = '11px';
    fSub.style.color = 'var(--text-muted)';
    fSub.textContent = batch.nameInFile
      ? `Sheet name: "${batch.nameInFile}"`
      : 'No student name in sheet';
    tdFile.append(fMain, fSub);

    const summaryObj =
      batch.summary && typeof batch.summary === 'object' ? batch.summary : {};
    const recordedEdits = Array.isArray(summaryObj.edits) ? summaryObj.edits : [];
    const totalEditsCount =
      typeof summaryObj.edits_total_count === 'number'
        ? summaryObj.edits_total_count
        : typeof summaryObj.edits_count === 'number'
          ? summaryObj.edits_count
          : recordedEdits.length;

    if (totalEditsCount > 0) {
      const editsDetails = document.createElement('details');
      editsDetails.className = 'import-edits-details';
      editsDetails.style.marginTop = '6px';

      const editsSummary = document.createElement('summary');
      editsSummary.className = 'num';
      editsSummary.style.fontSize = '11px';
      editsSummary.style.color = 'var(--color-primary-text)';
      editsSummary.textContent = `✏️ ${formatNum(totalEditsCount)} value${totalEditsCount === 1 ? '' : 's'} adjusted in preview`;
      editsDetails.appendChild(editsSummary);

      const editsUl = document.createElement('ul');
      editsUl.className = 'import-edits-list num';
      editsUl.style.fontSize = '11px';

      for (const ed of recordedEdits) {
        const li = document.createElement('li');
        const origStr =
          ed.original_value === null || ed.original_value === undefined || ed.original_value === ''
            ? '(empty)'
            : String(ed.original_value);
        const newStr =
          ed.new_value === null || ed.new_value === undefined || ed.new_value === ''
            ? '(empty)'
            : String(ed.new_value);
        const skipSuffix = ed.skipped ? ' [Skipped]' : '';
        li.textContent = `Round ${ed.round_number} (${ed.series || 'Series'}) · ${ed.field}: ${origStr} → ${newStr}${skipSuffix}`;
        editsUl.appendChild(li);
      }

      if (totalEditsCount > recordedEdits.length) {
        const moreLi = document.createElement('li');
        moreLi.style.color = 'var(--text-muted)';
        moreLi.textContent = `...and ${formatNum(totalEditsCount - recordedEdits.length)} more adjustment(s).`;
        editsUl.appendChild(moreLi);
      }

      editsDetails.appendChild(editsUl);
      tdFile.appendChild(editsDetails);
    }

    // 4. Mark Verified
    const tdVer = document.createElement('td');
    const verBadge = document.createElement('span');
    verBadge.className = `badge ${batch.markVerified ? 'badge-success' : 'badge-inactive'}`;
    verBadge.textContent = batch.markVerified ? '🔒 Verified' : 'Unverified';
    tdVer.appendChild(verBadge);

    // 5. Rows (Imported / Found)
    const tdRows = document.createElement('td');
    tdRows.className = 'num';
    tdRows.style.whiteSpace = 'nowrap';
    const impText =
      batch.rowsImported !== null && batch.rowsImported !== undefined
        ? formatNum(batch.rowsImported)
        : '0 (Open)';
    tdRows.textContent = `${impText} / ${formatNum(batch.rowsFound)}`;

    // 6. Status & Undo Info
    const tdStatus = document.createElement('td');
    if (batch.undoneAt) {
      const uBadge = document.createElement('span');
      uBadge.className = 'badge badge-warning';
      uBadge.textContent = 'Undone';
      tdStatus.appendChild(uBadge);
      if (batch.undoReason) {
        const rDiv = document.createElement('div');
        rDiv.style.fontSize = '11px';
        rDiv.style.color = 'var(--text-muted)';
        rDiv.style.marginTop = '2px';
        rDiv.textContent = `Reason: "${batch.undoReason}"`;
        tdStatus.appendChild(rDiv);
      }
    } else if (batch.rowsImported === null || batch.rowsImported === undefined) {
      const openBadge = document.createElement('span');
      openBadge.className = 'badge badge-warning';
      openBadge.textContent = 'Open (Unfinished — 0 rows saved)';
      tdStatus.appendChild(openBadge);
    } else {
      const aBadge = document.createElement('span');
      aBadge.className = 'badge badge-success';
      aBadge.textContent = 'Completed';
      tdStatus.appendChild(aBadge);
    }

    // 7. Action (Undo)
    const tdAction = document.createElement('td');
    if (!batch.undoneAt) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'btn btn-outline btn-sm';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', () => {
        openUndoImportModal(batch);
      });
      tdAction.appendChild(undoBtn);
    } else {
      const doneSpan = document.createElement('span');
      doneSpan.style.fontSize = 'var(--text-xs)';
      doneSpan.style.color = 'var(--text-dim)';
      doneSpan.textContent = 'Undone';
      tdAction.appendChild(doneSpan);
    }

    tr.append(tdDate, tdStu, tdFile, tdVer, tdRows, tdStatus, tdAction);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  container.appendChild(tableWrapper);
}

/**
 * Opens the Undo Import Confirmation Modal (`#undo-import-modal`)
 */
function openUndoImportModal(batch) {
  const idInput = document.getElementById('undo-import-batch-id');
  const metaBox = document.getElementById('undo-import-batch-meta');
  const reasonInput = document.getElementById('undo-import-reason');

  if (idInput) idInput.value = batch.id;
  if (reasonInput) reasonInput.value = '';

  if (metaBox) {
    metaBox.replaceChildren();
    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.color = 'var(--text-main)';
    title.textContent = `${batch.studentName || 'Student'} (${batch.studentCode || '—'}) — ${batch.fileName || 'scoresheet.csv'}`;
    const sub = document.createElement('div');
    sub.style.color = 'var(--text-muted)';
    sub.style.marginTop = '2px';
    sub.className = 'num';
    sub.textContent = `Batch ID: ${batch.id}`;
    metaBox.append(title, sub);
  }

  openModal('undo-import-modal');
}

/**
 * Executes `admin_undo_import(p_batch, p_reason)` and refreshes history & preview
 */
async function executeUndoImportBatch(batchId, reason) {
  try {
    let undoResult = null;
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('admin_undo_import', {
        p_batch: batchId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      undoResult = extractRpcObject(data);
    } else {
      undoResult = DemoDB.adminUndoImport({ p_batch: batchId, p_reason: reason }, currentAdmin?.id);
    }

    const undoTotals = {
      results_deleted: Number(undoResult.results_deleted) || 0,
      results_kept: Number(undoResult.results_kept) || 0,
      rounds_deleted: Number(undoResult.rounds_deleted) || 0,
    };

    showToast(
      'success',
      `Import undone: ${undoTotals.results_deleted} scores deleted, ${undoTotals.results_kept} kept, ${undoTotals.rounds_deleted} rounds deleted.`
    );

    const matchingBatch = importBatches.find((b) => b.id === batchId);
    renderImportResultBanner({
      type: 'undo_success',
      batchId,
      studentId: matchingBatch?.student_id || getSelectedStudent()?.id || null,
      reason,
      undoTotals,
    });

    const selectedStudent = getSelectedStudent();
    if (selectedStudent) {
      await ensureStudentExistingDataLoaded(selectedStudent.id, true);
    }
    await loadImportBatches();
    if (currentParsedResult && currentParsedResult.ok) {
      renderCurrentPreviewState();
    }
  } catch (err) {
    console.error('Undo import failed:', err);
    showToast('error', `Failed to undo import: ${err.message || 'Database error'}`);
  }
}

/**
 * Renders the target round category <select> options for adding a new category alias
 */
function renderAliasCategoryOptions() {
  const select = document.getElementById('new-alias-category-select');
  if (!select) return;
  select.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Choose target round category --';
  select.appendChild(placeholder);

  for (const cat of roundCategories) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = `${cat.name}${cat.active === false ? ' [Inactive]' : ''}`;
    select.appendChild(opt);
  }
}

/**
 * Renders the Saved Category Aliases list (`category_aliases`) with delete buttons
 */
function renderCategoryAliasesList() {
  const container = document.getElementById('import-aliases-container');
  if (!container) return;
  container.replaceChildren();

  const catById = new Map(roundCategories.map((c) => [c.id, c]));

  if (!categoryAliases || categoryAliases.length === 0) {
    const empty = document.createElement('div');
    empty.style.fontSize = 'var(--text-xs)';
    empty.style.color = 'var(--text-muted)';
    empty.textContent =
      'No custom database aliases saved yet. Built-in aliases ("calender", "timeelapse") are always active.';
    container.appendChild(empty);
    return;
  }

  const chipList = document.createElement('div');
  chipList.style.display = 'flex';
  chipList.style.flexWrap = 'wrap';
  chipList.style.gap = 'var(--space-2)';

  for (const al of categoryAliases) {
    const targetCat = catById.get(al.category_id);
    const chip = document.createElement('div');
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '6px';
    chip.style.padding = '4px 10px';
    chip.style.backgroundColor = 'var(--bg-surface-subtle)';
    chip.style.border = '1px solid var(--border-hairline)';
    chip.style.borderRadius = 'var(--radius-sm)';
    chip.style.fontSize = 'var(--text-xs)';

    const code = document.createElement('code');
    code.className = 'import-cell-ref num';
    code.textContent = al.alias;

    const arrow = document.createElement('span');
    arrow.style.color = 'var(--text-muted)';
    arrow.textContent = `→ ${targetCat ? targetCat.name : al.category_id}`;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-outline btn-sm';
    delBtn.style.padding = '0 5px';
    delBtn.style.minHeight = '20px';
    delBtn.style.fontSize = '11px';
    delBtn.title = `Remove alias "${al.alias}"`;
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      await deleteCategoryAliasFromDatabase(al.alias);
    });

    chip.append(code, arrow, delBtn);
    chipList.appendChild(chip);
  }

  container.appendChild(chipList);
}

/**
 * Saves a category alias to `category_aliases` and refreshes preview state
 */
async function saveCategoryAliasToDatabase(aliasKey, categoryId) {
  try {
    const cleanKey = toMatchingKey(aliasKey);
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { error } = await supabase
        .from('category_aliases')
        .upsert({ alias: cleanKey, category_id: categoryId }, { onConflict: 'alias' });
      if (error) throw new Error(error.message);
    } else {
      DemoDB.upsertCategoryAlias(cleanKey, categoryId);
    }

    await loadReferenceData(true);
    if (currentParsedResult && currentParsedResult.ok) {
      renderCurrentPreviewState();
    }
    showToast('success', `Saved category alias "${cleanKey}".`);
  } catch (err) {
    console.error('Failed to save category alias:', err);
    showToast('error', `Could not save alias: ${err.message || 'Database error'}`);
  }
}

/**
 * Deletes a category alias from `category_aliases` and refreshes preview state
 */
async function deleteCategoryAliasFromDatabase(aliasKey) {
  try {
    const cleanKey = toMatchingKey(aliasKey);
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { error } = await supabase.from('category_aliases').delete().eq('alias', cleanKey);
      if (error) throw new Error(error.message);
    } else {
      DemoDB.deleteCategoryAlias(cleanKey);
    }

    await loadReferenceData(true);
    if (currentParsedResult && currentParsedResult.ok) {
      renderCurrentPreviewState();
    }
    showToast('info', `Removed category alias "${cleanKey}".`);
  } catch (err) {
    console.error('Failed to delete category alias:', err);
    showToast('error', `Could not delete alias: ${err.message || 'Database error'}`);
  }
}

/**
 * Resets Step 1 & hides Step 2 preview ("Start over")
 */
function resetImportWorkflow() {
  currentCsvText = '';
  currentFileName = '';
  currentParsedResult = null;
  currentPreviewState = null;
  currentExecutionPlan = null;
  blockUiState = {};
  previewEditState = createEmptyEditState();
  expandedRoundKeys = new Set();
  activeRoundEditor = null;
  activeCellEditor = null;
  hideUnsavedEditsWarning();

  const fileInput = document.getElementById('import-csv-file');
  if (fileInput) fileInput.value = '';

  const metaEl = document.getElementById('import-file-meta');
  if (metaEl) metaEl.textContent = '';

  const dateFormatSelect = document.getElementById('import-date-format');
  if (dateFormatSelect) dateFormatSelect.value = 'auto';

  const progressBanner = document.getElementById('import-progress-banner');
  if (progressBanner) progressBanner.style.display = 'none';

  clearStep1Error();
  hidePreview();
}

function hidePreview() {
  const previewContainer = document.getElementById('import-preview-container');
  if (previewContainer) previewContainer.style.display = 'none';
}

function showStep1Error(msg) {
  const errEl = document.getElementById('import-step1-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

function clearStep1Error() {
  const errEl = document.getElementById('import-step1-error');
  if (!errEl) return;
  errEl.textContent = '';
  errEl.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', initImportPage);
