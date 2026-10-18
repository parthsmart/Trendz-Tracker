/**
 * Trendz Tracker — Admin CSV Score Sheet Import Controller (js/import.js)
 *
 * STRICT PHASE 4c-1, 4c-2a & 4c-2b RULES:
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
} from './importPlan.js';

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB

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

// Existing data for the currently selected student
let selectedStudentIdLoaded = null;
let existingStudentRounds = [];
let existingStudentResults = [];
let isLoadingStudentData = false;
let isImporting = false;

// Current CSV & per-block interactive UI state
let currentCsvText = '';
let currentFileName = '';
let currentParsedResult = null;
let currentPreviewState = null;
let currentExecutionPlan = null;
let blockUiState = {}; // { [blockNumber]: { seriesId: string, confirmed: boolean, adminMappings: { [rawKey]: { action, targetCategoryId, saveAlias } } } }

/**
 * Initialize the Admin Import Page
 */
async function initImportPage() {
  currentAdmin = await requireAuth(['admin']);
  if (!currentAdmin) return;

  renderHeaderUser(currentAdmin);
  setupAdminNav();
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
    const sampleWrapper = document.getElementById('demo-sample-action-wrapper');
    if (sampleWrapper) sampleWrapper.style.display = 'flex';
  }

  bindStep1Listeners();
  bindImportOptionsAndModals();
  bindHistoryAndAliasesListeners();

  await loadReferenceData();
  await loadImportBatches();
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
          .select('*')
          .eq('student_id', studentId)
          .order('round_number', { ascending: true }),
        supabase
          .from('results')
          .select('*')
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
      existingStudentResults = DemoDB.getResults
        ? DemoDB.getResults().filter(
            (r) =>
              r.student_id === studentId &&
              r.student_round_id !== null &&
              r.student_round_id !== undefined
          )
        : [];
      selectedStudentIdLoaded = studentId;
    }
  } catch (err) {
    console.error('Error loading student existing rounds/results for comparison:', err);
    showStep1Error(
      `Failed to load existing rounds/results for selected student: ${err.message || 'Network error'}`
    );
    existingStudentRounds = [];
    existingStudentResults = [];
    selectedStudentIdLoaded = null;
  } finally {
    isLoadingStudentData = false;
  }
}

/**
 * Loads `import_batches` from the database (or DemoDB) and renders the Import History table.
 */
async function loadImportBatches() {
  const container = document.getElementById('import-history-container');
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.from('import_batches').select('*');
      if (error) throw new Error(error.message);
      importBatches = (data || []).sort((a, b) => {
        const tA = String(a.created_at || a.started_at || a.imported_at || '');
        const tB = String(b.created_at || b.started_at || b.imported_at || '');
        return tB.localeCompare(tA);
      });
    } else {
      importBatches = DemoDB.getImportBatches ? DemoDB.getImportBatches() : [];
    }
    renderImportHistoryTable();
  } catch (err) {
    console.error('Error loading import_batches:', err);
    if (container) {
      const errBox = document.createElement('div');
      errBox.className = 'banner banner-error';
      errBox.textContent = `Could not load import history: ${err.message || 'Database error'}`;
      container.replaceChildren(errBox);
    }
  }
}

/**
 * Renders the filtered student <select> options using textContent
 */
function renderStudentOptions(preserveSelectedId = null) {
  const select = document.getElementById('import-student-select');
  if (!select) return;

  const previousValue = preserveSelectedId !== null ? preserveSelectedId : select.value;
  select.replaceChildren();

  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent =
    filteredStudents.length === 0
      ? 'No matching students found'
      : `-- Select a student (${filteredStudents.length} shown) --`;
  select.appendChild(placeholderOpt);

  for (const stu of filteredStudents) {
    const opt = document.createElement('option');
    opt.value = stu.id;
    const statusSuffix = stu.active === false ? ' [Inactive]' : '';
    const levelInfo = stu.level ? ` · ${stu.level}` : '';
    opt.textContent = `${stu.full_name} (${stu.student_code}${levelInfo})${statusSuffix}`;
    select.appendChild(opt);
  }

  if (previousValue && filteredStudents.some((s) => s.id === previousValue)) {
    select.value = previousValue;
  } else if (filteredStudents.length === 1) {
    select.value = filteredStudents[0].id;
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
  const searchInput = document.getElementById('import-student-search');
  const studentSelect = document.getElementById('import-student-select');
  const fileInput = document.getElementById('import-csv-file');
  const dateFormatSelect = document.getElementById('import-date-format');
  const startOverBtn = document.getElementById('btn-import-start-over');
  const sampleBtn = document.getElementById('btn-load-sample-csv');
  const cleanSampleBtn = document.getElementById('btn-load-clean-sample-csv');

  if (searchInput) {
    searchInput.addEventListener('input', async () => {
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
      renderImportHistoryTable();
      if (currentCsvText) {
        await runParseAndRenderPreview(false);
      }
    });
  }

  if (studentSelect) {
    studentSelect.addEventListener('change', async () => {
      const stu = getSelectedStudent();
      await ensureStudentExistingDataLoaded(stu ? stu.id : null);
      renderImportHistoryTable();
      if (currentCsvText) {
        await runParseAndRenderPreview(false);
      }
    });
  }

  if (dateFormatSelect) {
    dateFormatSelect.addEventListener('change', async () => {
      if (currentCsvText) {
        await runParseAndRenderPreview(false);
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      handleFileSelected(fileInput.files ? fileInput.files[0] : null);
    });
  }

  if (startOverBtn) {
    startOverBtn.addEventListener('click', () => {
      resetImportWorkflow();
    });
  }

  if (cleanSampleBtn) {
    cleanSampleBtn.addEventListener('click', async () => {
      clearStep1Error();
      if (studentSelect && !studentSelect.value && allStudents.length > 0) {
        studentSelect.value = allStudents[0].id;
      }
      currentFileName = 'ready-two-block-sheet.csv';
      currentCsvText = CLEAN_READY_TWO_BLOCK_CSV;
      const metaEl = document.getElementById('import-file-meta');
      if (metaEl) {
        metaEl.textContent = `${currentFileName} (${currentCsvText.length} bytes)`;
      }
      await runParseAndRenderPreview(true);
      showToast(
        'info',
        'Loaded ready-to-import 2-block CSV fixture. Confirm Block 1 & Block 2 series to import.'
      );
    });
  }

  if (sampleBtn) {
    sampleBtn.addEventListener('click', async () => {
      clearStep1Error();
      if (studentSelect && !studentSelect.value && allStudents.length > 0) {
        studentSelect.value = allStudents[0].id;
      }
      currentFileName = 'sample-two-block-sheet.csv';
      currentCsvText = SAMPLE_TWO_BLOCK_CSV;
      const metaEl = document.getElementById('import-file-meta');
      if (metaEl) {
        metaEl.textContent = `${currentFileName} (${currentCsvText.length} bytes)`;
      }
      await runParseAndRenderPreview(true);
      showToast('info', 'Loaded 2-block CSV fixture with validation edge cases.');
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
 * Initializes default per-block UI state when a new CSV file is loaded:
 * - Pre-selects the SUGGESTED simulator series (`Old simulator` or `New simulator` or `""`)
 * - Leaves `confirmed = false` so the admin must explicitly confirm each block
 * - Initializes empty `adminMappings`
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
}

/**
 * Runs parseScoreSheetCsv + buildImportPreviewState and renders the full preview
 *
 * @param {boolean} [resetBlockState=false] - Whether to reset per-block series/category selections
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
 * Re-computes Phase 4c-2a/2b resolution, comparison & execution plan state and updates the DOM
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
  });

  const executionPlan = buildImportExecutionPlan(currentParsedResult, previewState, {
    selectedStudent,
    fileName: currentFileName,
    markVerified,
    onDateConflict,
  });

  currentPreviewState = previewState;
  currentExecutionPlan = executionPlan;

  const previewContainer = document.getElementById('import-preview-container');
  if (previewContainer) {
    previewContainer.style.display = 'block';
  }

  renderNeedsAttentionSection(currentParsedResult, previewState, selectedStudent);
  renderSummaryCards(currentParsedResult, selectedStudent);
  renderComparisonSummarySection(previewState, selectedStudent);
  renderBlocksSection(currentParsedResult, previewState, selectedStudent);
  renderReadinessAndActionState(previewState, executionPlan, selectedStudent);
}

/**
 * Renders the "Needs Attention" triage panel at the top of Step 2
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

  const errorCount = items.filter((i) => i.severity === 'error').length;
  const warningCount = items.filter((i) => i.severity === 'warning').length;
  const infoCount = items.filter((i) => i.severity === 'info').length;

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = 'var(--space-2)';
  headerRow.style.marginBottom = 'var(--space-3)';

  const titleEl = document.createElement('h2');
  titleEl.id = 'attention-heading';
  titleEl.style.fontSize = 'var(--text-lg)';
  titleEl.textContent =
    errorCount + warningCount > 0
      ? `Needs Attention (${errorCount + warningCount} issue${errorCount + warningCount === 1 ? '' : 's'})`
      : 'Validation, Series & Comparison Summary';

  const badgesWrap = document.createElement('div');
  badgesWrap.style.display = 'flex';
  badgesWrap.style.gap = 'var(--space-2)';
  badgesWrap.style.flexWrap = 'wrap';

  const errBadge = document.createElement('span');
  errBadge.className = 'badge num';
  errBadge.style.backgroundColor = 'var(--color-danger-subtle)';
  errBadge.style.color = 'var(--color-danger-text)';
  errBadge.textContent = `${errorCount} Blocking Error${errorCount === 1 ? '' : 's'}`;

  const warnBadge = document.createElement('span');
  warnBadge.className = 'badge badge-warning num';
  warnBadge.textContent = `${warningCount} Warning${warningCount === 1 ? '' : 's'}`;

  const infoBadge = document.createElement('span');
  infoBadge.className = 'badge badge-inactive num';
  infoBadge.textContent = `${infoCount} Info`;

  badgesWrap.append(errBadge, warnBadge, infoBadge);
  headerRow.append(titleEl, badgesWrap);
  section.appendChild(headerRow);

  if (items.length === 0) {
    const okBanner = document.createElement('div');
    okBanner.className = 'banner banner-success';
    okBanner.textContent =
      'All simulator series confirmations, category resolutions, dates, score ratios, time formats, and database comparisons passed with zero warnings.';
    section.appendChild(okBanner);
    return;
  }

  const list = document.createElement('div');
  list.className = 'import-attention-list';

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `import-attention-item import-attention-${item.severity}`;

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = 'var(--space-2)';
    left.style.flexWrap = 'wrap';

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
    left.appendChild(sevTag);

    if (item.blockNumber !== null && item.blockNumber !== undefined) {
      const scopeBadge = document.createElement('span');
      scopeBadge.className = 'badge badge-inactive num';
      scopeBadge.textContent =
        item.roundNumber !== null && item.roundNumber !== undefined
          ? `Block ${item.blockNumber} · Round ${item.roundNumber}`
          : `Block ${item.blockNumber}`;
      left.appendChild(scopeBadge);
    }

    if (item.ref) {
      const refCode = document.createElement('code');
      refCode.className = 'import-cell-ref num';
      refCode.textContent = item.ref;
      left.appendChild(refCode);
    }

    const msgSpan = document.createElement('span');
    msgSpan.style.fontSize = 'var(--text-sm)';
    msgSpan.style.color = 'var(--text-main)';
    msgSpan.textContent = item.message;

    row.append(left, msgSpan);
    list.appendChild(row);
  }

  section.appendChild(list);
}

/**
 * Renders the 4 Overview Summary Cards
 */
function renderSummaryCards(parsed, selectedStudent) {
  const container = document.getElementById('import-summary-cards');
  if (!container) return;
  container.replaceChildren();

  // Card 1: Blocks & Rounds per block
  const card1 = document.createElement('div');
  card1.className = 'stat-card';
  const c1Label = document.createElement('span');
  c1Label.className = 'stat-label';
  c1Label.textContent = 'Blocks & Rounds Detected';
  const c1Val = document.createElement('span');
  c1Val.className = 'stat-value num';
  c1Val.textContent = `${parsed.summary.blockCount} Block${parsed.summary.blockCount === 1 ? '' : 's'} · ${parsed.summary.totalRounds} Round${parsed.summary.totalRounds === 1 ? '' : 's'}`;
  const c1Sub = document.createElement('div');
  c1Sub.style.fontSize = 'var(--text-xs)';
  c1Sub.style.color = 'var(--text-muted)';
  c1Sub.style.marginTop = 'var(--space-1)';
  c1Sub.className = 'num';
  c1Sub.textContent = parsed.summary.blockSummaries
    .map((b) => `Block ${b.blockNumber}: ${b.roundCount} round${b.roundCount === 1 ? '' : 's'}`)
    .join(' · ');
  card1.append(c1Label, c1Val, c1Sub);

  // Card 2: Date Range per block
  const card2 = document.createElement('div');
  card2.className = 'stat-card';
  const c2Label = document.createElement('span');
  c2Label.className = 'stat-label';
  c2Label.textContent = `Date Range (${parsed.resolvedDateFormat})`;
  const c2List = document.createElement('div');
  c2List.style.display = 'flex';
  c2List.style.flexDirection = 'column';
  c2List.style.gap = '4px';
  c2List.style.marginTop = 'var(--space-1)';
  for (const b of parsed.summary.blockSummaries) {
    const line = document.createElement('div');
    line.style.fontSize = 'var(--text-xs)';
    line.className = 'num';
    const rangeText =
      b.minDate && b.maxDate
        ? `${formatDisplayDateIST(b.minDate)} – ${formatDisplayDateIST(b.maxDate)}`
        : 'No valid dates';
    line.textContent = `Block ${b.blockNumber}: ${rangeText}`;
    c2List.appendChild(line);
  }
  const c2Sub = document.createElement('div');
  c2Sub.style.fontSize = '11px';
  c2Sub.style.color = 'var(--text-dim)';
  c2Sub.style.marginTop = '4px';
  c2Sub.className = 'num';
  c2Sub.textContent = `Checked against IST today: ${parsed.todayIST}`;
  card2.append(c2Label, c2List, c2Sub);

  // Card 3: Total Cells by Status
  const tc = parsed.summary.totalCells;
  const card3 = document.createElement('div');
  card3.className = 'stat-card';
  const c3Label = document.createElement('span');
  c3Label.className = 'stat-label';
  c3Label.textContent = 'Total Cells by Parse Status';
  const c3Val = document.createElement('span');
  c3Val.className = 'stat-value num';
  c3Val.style.fontSize = 'var(--text-xl)';
  c3Val.textContent = `${tc.ok} OK · ${tc.empty} Empty`;
  const c3Sub = document.createElement('div');
  c3Sub.style.fontSize = 'var(--text-xs)';
  c3Sub.style.color =
    tc.unreadable > 0 || tc.stray > 0 ? 'var(--color-warning-text)' : 'var(--text-muted)';
  c3Sub.style.marginTop = 'var(--space-1)';
  c3Sub.className = 'num';
  c3Sub.textContent = `${tc.unreadable} Unreadable · ${tc.stray} Stray · ${tc.note} Note${tc.note === 1 ? '' : 's'}`;
  card3.append(c3Label, c3Val, c3Sub);

  // Card 4: Student Name & Level Labels
  const card4 = document.createElement('div');
  card4.className = 'stat-card';
  const c4Label = document.createElement('span');
  c4Label.className = 'stat-label';
  c4Label.textContent = 'Student Name & Level Labels';
  const c4Val = document.createElement('div');
  c4Val.style.fontSize = 'var(--text-sm)';
  c4Val.style.fontWeight = '700';
  c4Val.style.color = 'var(--text-main)';
  c4Val.style.marginTop = '2px';
  const sheetNameStr = parsed.primaryStudentName || '(None in sheet)';
  c4Val.textContent = `In Sheet: ${sheetNameStr}`;

  const c4Selected = document.createElement('div');
  c4Selected.style.fontSize = 'var(--text-xs)';
  c4Selected.style.marginTop = '2px';
  if (selectedStudent) {
    const namesDiffer =
      parsed.primaryStudentName &&
      parsed.primaryStudentName.trim().toLowerCase() !==
        selectedStudent.full_name.trim().toLowerCase();
    c4Selected.style.color = namesDiffer ? 'var(--color-warning-text)' : 'var(--text-muted)';
    c4Selected.textContent = namesDiffer
      ? `⚠️ Selected: ${selectedStudent.full_name} (${selectedStudent.student_code}) — differs from sheet`
      : `✓ Selected: ${selectedStudent.full_name} (${selectedStudent.student_code})`;
  } else {
    c4Selected.style.color = 'var(--color-warning-text)';
    c4Selected.textContent = '⚠️ No student selected in Step 1';
  }

  const c4Levels = document.createElement('div');
  c4Levels.style.fontSize = '11px';
  c4Levels.style.color = 'var(--text-dim)';
  c4Levels.style.marginTop = '4px';
  c4Levels.textContent =
    parsed.levelLabels.length > 0
      ? `Levels seen: ${parsed.levelLabels.join(', ')}`
      : 'Levels seen: none';

  card4.append(c4Label, c4Val, c4Selected, c4Levels);

  container.append(card1, card2, card3, card4);
}

/**
 * Renders the Phase 4c-2a Existing Data Comparison Summary Panel
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
  h2.textContent = 'Comparison with Existing Database Records';

  const stuBadge = document.createElement('span');
  stuBadge.className = selectedStudent ? 'badge badge-success num' : 'badge badge-warning num';
  stuBadge.textContent = selectedStudent
    ? `Comparing against ${selectedStudent.full_name} (${selectedStudent.student_code}) · ${existingStudentRounds.length} DB round${existingStudentRounds.length === 1 ? '' : 's'}`
    : 'Select a student in Step 1 to compare with database';

  headerRow.append(h2, stuBadge);
  section.appendChild(headerRow);

  if (!selectedStudent) {
    const notice = document.createElement('div');
    notice.className = 'banner banner-warning';
    notice.textContent =
      'Choose a student in Step 1 above to compare this CSV score sheet against their existing rounds and scores in the database.';
    section.appendChild(notice);
    return;
  }

  const oc = previewState.overallComparison;
  const grid = document.createElement('div');
  grid.className = 'stats-grid';

  // Box 1: Rounds Comparison
  const rCard = document.createElement('div');
  rCard.className = 'stat-card';
  const rTitle = document.createElement('span');
  rTitle.className = 'stat-label';
  rTitle.textContent = 'Rounds vs Database (by Student + Series + Round #)';
  const rMain = document.createElement('div');
  rMain.className = 'num';
  rMain.style.fontSize = 'var(--text-base)';
  rMain.style.fontWeight = '700';
  rMain.style.marginTop = '4px';
  rMain.textContent = `${oc.rounds.newRounds} New · ${oc.rounds.existingIdentical} Identical · ${oc.rounds.existingAddsCells} Add Missing Scores · ${oc.rounds.existingWithConflicts} Have Differences`;
  const rSub = document.createElement('div');
  rSub.className = 'num';
  rSub.style.fontSize = 'var(--text-xs)';
  rSub.style.color = 'var(--text-muted)';
  rSub.style.marginTop = '4px';
  rSub.textContent = `${oc.rounds.dbOnlyRounds} existing round${oc.rounds.dbOnlyRounds === 1 ? '' : 's'} in DB not in this sheet (kept untouched)`;
  rCard.append(rTitle, rMain, rSub);

  // Box 2: Cells Comparison
  const cCard = document.createElement('div');
  cCard.className = 'stat-card';
  const cTitle = document.createElement('span');
  cTitle.className = 'stat-label';
  cTitle.textContent = 'Category Scores vs Database';
  const cMain = document.createElement('div');
  cMain.className = 'num';
  cMain.style.fontSize = 'var(--text-base)';
  cMain.style.fontWeight = '700';
  cMain.style.marginTop = '4px';
  cMain.textContent = `${oc.cells.newCells} New · ${oc.cells.identicalCells} Identical · ${oc.cells.conflictCells} Unverified Conflict${oc.cells.conflictCells === 1 ? '' : 's'}`;
  const cSub = document.createElement('div');
  cSub.className = 'num';
  cSub.style.fontSize = 'var(--text-xs)';
  cSub.style.color =
    oc.cells.protectedConflictCells > 0 ? 'var(--color-warning-text)' : 'var(--text-muted)';
  cSub.style.marginTop = '4px';
  cSub.textContent = `${oc.cells.protectedConflictCells} Protected (🔒 Verified / ✏️ Corrected — kept) · ${oc.cells.dbOnlyCells} In DB Only (kept)`;
  cCard.append(cTitle, cMain, cSub);

  grid.append(rCard, cCard);
  section.appendChild(grid);
}

/**
 * Renders a detailed section for each side-by-side Block
 */
function renderBlocksSection(parsed, previewState, selectedStudent) {
  const container = document.getElementById('import-blocks-container');
  if (!container) return;
  container.replaceChildren();

  for (const blk of parsed.blocks) {
    const blockReport = previewState.blockReports.find(
      (r) => r.blockNumber === blk.blockNumber
    );
    if (!blockReport) continue;

    const blockCard = document.createElement('section');
    blockCard.className = 'card';
    blockCard.style.marginBottom = 'var(--space-6)';

    // 1. Block Header & Simulator Series Selector + Confirmation + Metadata Hints
    blockCard.appendChild(buildBlockSimulatorHeader(blk, blockReport));

    // 2. Category Resolution Section for this Block
    blockCard.appendChild(buildBlockCategoriesSection(blk, blockReport));

    // 3. Round-by-Round Table + Existing Data Comparison for this Block
    blockCard.appendChild(buildBlockRoundsSection(blk, blockReport, selectedStudent));

    container.appendChild(blockCard);
  }
}

/**
 * Builds the Simulator Series Selector, Confirmation Control, and Block Metadata Header
 */
function buildBlockSimulatorHeader(blk, blockReport) {
  const wrapper = document.createElement('div');
  wrapper.style.paddingBottom = 'var(--space-4)';
  wrapper.style.borderBottom = '1px solid var(--border-hairline)';
  wrapper.style.marginBottom = 'var(--space-4)';

  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'space-between';
  topRow.style.alignItems = 'flex-start';
  topRow.style.flexWrap = 'wrap';
  topRow.style.gap = 'var(--space-4)';

  // Left Column: Block Title + Metadata pills (File Label Hint, Round Range, Date Range)
  const leftCol = document.createElement('div');
  leftCol.style.flex = '1';
  leftCol.style.minWidth = '260px';

  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.gap = 'var(--space-2)';
  titleRow.style.flexWrap = 'wrap';

  const h2 = document.createElement('h2');
  h2.style.fontSize = 'var(--text-xl)';
  h2.textContent = `Block ${blk.blockNumber}`;
  titleRow.appendChild(h2);

  // Confirmation status badge
  const confirmBadge = document.createElement('span');
  if (blockReport.duplicateSeriesError) {
    confirmBadge.className = 'badge num';
    confirmBadge.style.backgroundColor = 'var(--color-danger-subtle)';
    confirmBadge.style.color = 'var(--color-danger-text)';
    confirmBadge.textContent = '🚫 Duplicate Series Error';
  } else if (blockReport.confirmed && blockReport.seriesId) {
    confirmBadge.className = 'badge badge-success num';
    confirmBadge.textContent = `✓ Confirmed: ${blockReport.seriesName}`;
  } else if (blockReport.seriesId) {
    confirmBadge.className = 'badge badge-warning num';
    confirmBadge.textContent = `Suggestion (Unconfirmed): ${blockReport.seriesName}`;
  } else {
    confirmBadge.className = 'badge num';
    confirmBadge.style.backgroundColor = 'var(--color-danger-subtle)';
    confirmBadge.style.color = 'var(--color-danger-text)';
    confirmBadge.textContent = 'No Series Selected';
  }
  titleRow.appendChild(confirmBadge);
  leftCol.appendChild(titleRow);

  // Metadata list: File Label Hint, Round Range, Date Range
  const metaGrid = document.createElement('div');
  metaGrid.style.display = 'flex';
  metaGrid.style.flexWrap = 'wrap';
  metaGrid.style.gap = 'var(--space-2)';
  metaGrid.style.marginTop = 'var(--space-2)';

  const hm = blockReport.headerMeta;

  // 1. Block Label Hint from File
  const hintPill = document.createElement('span');
  hintPill.className = 'badge badge-inactive num';
  if (hm.blockHints && hm.blockHints.length > 0) {
    const hintsStr = hm.blockHints.map((h) => `"${h.text}" (${h.ref})`).join(', ');
    hintPill.textContent = `File Label Hint: ${hintsStr}`;
  } else {
    hintPill.textContent = 'File Label Hint: none';
  }

  // 2. Round Range
  const roundPill = document.createElement('span');
  roundPill.className = 'badge badge-inactive num';
  roundPill.textContent = `Round Range: ${hm.roundRange.text}`;

  // 3. Date Range
  const datePill = document.createElement('span');
  datePill.className = 'badge badge-inactive num';
  const formattedDateRange =
    hm.dateRange.minDate && hm.dateRange.maxDate
      ? `${formatDisplayDateIST(hm.dateRange.minDate)} – ${formatDisplayDateIST(hm.dateRange.maxDate)} (${hm.dateRange.text})`
      : 'No valid dates';
  datePill.textContent = `Date Range: ${formattedDateRange}`;

  metaGrid.append(hintPill, roundPill, datePill);
  leftCol.appendChild(metaGrid);

  if (blockReport.suggestion.suggestionReason) {
    const sugNote = document.createElement('div');
    sugNote.style.fontSize = 'var(--text-xs)';
    sugNote.style.color = 'var(--text-muted)';
    sugNote.style.marginTop = 'var(--space-2)';
    sugNote.textContent = `💡 ${blockReport.suggestion.suggestionReason}`;
    leftCol.appendChild(sugNote);
  }

  // Right Column: Simulator Series Dropdown + Confirm Button
  const rightCol = document.createElement('div');
  rightCol.style.minWidth = '300px';
  rightCol.style.flex = '1';
  rightCol.style.maxWidth = '480px';

  const seriesLabel = document.createElement('label');
  seriesLabel.className = 'form-label';
  seriesLabel.htmlFor = `block-series-select-${blk.blockNumber}`;
  seriesLabel.textContent = `Simulator Series for Block ${blk.blockNumber} (Required)`;

  const controlsRow = document.createElement('div');
  controlsRow.style.display = 'flex';
  controlsRow.style.gap = 'var(--space-2)';
  controlsRow.style.alignItems = 'center';
  controlsRow.style.flexWrap = 'wrap';

  const seriesSelect = document.createElement('select');
  seriesSelect.id = `block-series-select-${blk.blockNumber}`;
  seriesSelect.className = 'form-select';
  seriesSelect.style.flex = '1';
  seriesSelect.style.minWidth = '200px';

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select simulator series --';
  seriesSelect.appendChild(emptyOpt);

  for (const ser of roundSeries) {
    const opt = document.createElement('option');
    opt.value = ser.id;
    const isSug = blockReport.suggestion.suggestedSeriesId === ser.id;
    const curSuffix = ser.is_current ? ' [Current]' : '';
    const sugSuffix = isSug ? ' (Suggested)' : '';
    opt.textContent = `${ser.name}${curSuffix}${sugSuffix}`;
    seriesSelect.appendChild(opt);
  }

  seriesSelect.value = blockReport.seriesId || '';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.id = `btn-confirm-series-${blk.blockNumber}`;
  if (blockReport.confirmed && blockReport.seriesId) {
    confirmBtn.className = 'btn btn-outline btn-sm';
    confirmBtn.textContent = '✓ Series Confirmed';
  } else {
    confirmBtn.className = 'btn btn-primary btn-sm';
    confirmBtn.disabled = !blockReport.seriesId;
    confirmBtn.textContent = 'Confirm Series';
  }

  seriesSelect.addEventListener('change', () => {
    const ui = blockUiState[blk.blockNumber] || {
      seriesId: '',
      confirmed: false,
      adminMappings: {},
    };
    ui.seriesId = seriesSelect.value;
    ui.confirmed = false;
    blockUiState[blk.blockNumber] = ui;
    renderCurrentPreviewState();
  });

  confirmBtn.addEventListener('click', () => {
    const ui = blockUiState[blk.blockNumber] || {
      seriesId: seriesSelect.value,
      confirmed: false,
      adminMappings: {},
    };
    if (!ui.seriesId) {
      showToast('warning', `Please select a simulator series for Block ${blk.blockNumber} first.`);
      return;
    }
    ui.confirmed = !ui.confirmed;
    blockUiState[blk.blockNumber] = ui;
    renderCurrentPreviewState();
  });

  controlsRow.append(seriesSelect, confirmBtn);
  rightCol.append(seriesLabel, controlsRow);

  const helpNote = document.createElement('div');
  helpNote.style.fontSize = 'var(--text-xs)';
  helpNote.style.color = blockReport.confirmed
    ? 'var(--color-success-text)'
    : 'var(--color-warning-text)';
  helpNote.style.marginTop = '4px';
  helpNote.textContent = blockReport.confirmed
    ? `Block ${blk.blockNumber} simulator series is confirmed.`
    : `Please confirm the simulator series for Block ${blk.blockNumber}. Two blocks must never use the same series.`;
  rightCol.appendChild(helpNote);

  topRow.append(leftCol, rightCol);
  wrapper.appendChild(topRow);

  if (blockReport.duplicateSeriesError) {
    const dupBanner = document.createElement('div');
    dupBanner.className = 'banner banner-error';
    dupBanner.style.marginTop = 'var(--space-3)';
    dupBanner.textContent = `Blocking error: Block ${blk.blockNumber} uses "${blockReport.seriesName}", which is also selected in another block. Two blocks must never use the same simulator series.`;
    wrapper.appendChild(dupBanner);
  }

  return wrapper;
}

/**
 * Builds the Category Resolution table + Absent Series Categories info for a block
 */
function buildBlockCategoriesSection(blk, blockReport) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = 'var(--space-6)';

  const catRes = blockReport.categoryResolution;
  const counts = catRes.counts;

  const headingRow = document.createElement('div');
  headingRow.style.display = 'flex';
  headingRow.style.justifyContent = 'space-between';
  headingRow.style.alignItems = 'center';
  headingRow.style.flexWrap = 'wrap';
  headingRow.style.gap = 'var(--space-2)';
  headingRow.style.marginBottom = 'var(--space-3)';

  const h3 = document.createElement('h3');
  h3.style.fontSize = 'var(--text-base)';
  h3.textContent = `Block ${blk.blockNumber} Category Resolution (${counts.total} in sheet)`;

  const statusBadge = document.createElement('span');
  statusBadge.className =
    counts.unmatched > 0 || catRes.errors.length > 0
      ? 'badge badge-warning num'
      : 'badge badge-success num';
  statusBadge.textContent = `${counts.exact} Exact · ${counts.dbAlias} DB Alias · ${counts.builtinAlias} Built-in Alias · ${counts.unmatched} Unmatched`;

  headingRow.append(h3, statusBadge);
  wrap.appendChild(headingRow);

  if (catRes.errors.length > 0) {
    for (const err of catRes.errors) {
      const errBanner = document.createElement('div');
      errBanner.className = 'banner banner-error';
      errBanner.style.marginBottom = 'var(--space-3)';
      errBanner.textContent = err.message;
      wrap.appendChild(errBanner);
    }
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
    '#',
    'Cell',
    'Sheet Category Name',
    'Matching Key',
    'Resolution Priority',
    'Target Database Category / Action',
    'Series Check',
  ].forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const cat of catRes.categories) {
    const tr = document.createElement('tr');

    // 1. Index
    const tdIdx = document.createElement('td');
    tdIdx.className = 'num';
    tdIdx.textContent = cat.indexLabel || '—';

    // 2. Cell ref
    const tdRef = document.createElement('td');
    const refCode = document.createElement('code');
    refCode.className = 'import-cell-ref num';
    refCode.textContent = cat.ref;
    tdRef.appendChild(refCode);

    // 3. Sheet Category Name
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '600';
    tdName.textContent = cat.sheetName;

    // 4. Matching Key (lowercase with all whitespace removed)
    const tdKey = document.createElement('td');
    const keyCode = document.createElement('code');
    keyCode.className = 'import-cell-ref num';
    keyCode.textContent = cat.rawKey;
    tdKey.appendChild(keyCode);

    // 5. Resolution Priority / Source badge
    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    if (cat.effectiveStatus === 'db_alias') {
      badge.className = 'badge badge-success';
      badge.textContent = '1. DB Alias';
    } else if (cat.effectiveStatus === 'builtin_alias') {
      badge.className = 'badge badge-success';
      badge.textContent = '2. Built-in Alias';
    } else if (cat.effectiveStatus === 'exact') {
      badge.className = 'badge badge-success';
      badge.textContent = '3. Exact Match';
    } else if (cat.effectiveStatus === 'mapped_existing') {
      badge.className = 'badge badge-success';
      badge.textContent = 'Mapped by Admin';
    } else if (cat.effectiveStatus === 'create_historical') {
      badge.className = 'badge badge-inactive';
      badge.textContent = 'Create Inactive Category';
    } else if (cat.effectiveStatus === 'skipped') {
      badge.className = 'badge badge-inactive';
      badge.textContent = 'Skipped';
    } else {
      badge.className = 'badge badge-warning';
      badge.textContent = 'Unmatched';
    }
    tdStatus.appendChild(badge);

    // 6. Target Database Category / Action
    const tdAction = document.createElement('td');
    if (cat.autoMatchType !== 'unmatched') {
      const matchedText = document.createElement('span');
      matchedText.style.fontSize = 'var(--text-sm)';
      const inactiveNote =
        cat.resolvedCategory && !cat.resolvedCategory.active ? ' (Inactive in DB)' : '';
      matchedText.textContent =
        cat.autoMatchType === 'db_alias' || cat.autoMatchType === 'builtin_alias'
          ? `→ ${cat.resolvedCategory.name}${inactiveNote} (from alias "${cat.rawKey}")`
          : `→ ${cat.resolvedCategory.name}${inactiveNote}`;
      tdAction.appendChild(matchedText);
    } else {
      // Unmatched category: let admin choose resolution + optional Save Alias checkbox
      const actionWrap = document.createElement('div');
      actionWrap.style.display = 'flex';
      actionWrap.style.flexDirection = 'column';
      actionWrap.style.gap = '4px';

      const select = document.createElement('select');
      select.className = 'form-select';
      select.style.fontSize = 'var(--text-xs)';
      select.style.padding = '4px 8px';
      select.style.minHeight = '34px';
      select.setAttribute('aria-label', `Resolve unmatched category ${cat.sheetName}`);

      const optUnresolved = document.createElement('option');
      optUnresolved.value = 'unmatched';
      optUnresolved.textContent = `-- Choose resolution for "${cat.sheetName}" --`;

      const optCreate = document.createElement('option');
      optCreate.value = 'create_historical';
      optCreate.textContent = `Create "${cat.sheetName}" as an inactive round category & link to series`;

      const optSkip = document.createElement('option');
      optSkip.value = 'skip';
      optSkip.textContent = 'Skip this category';

      const optGroup = document.createElement('optgroup');
      optGroup.label = 'Map to existing database round category';

      for (const dbCat of roundCategories) {
        const opt = document.createElement('option');
        opt.value = `map:${dbCat.id}`;
        opt.textContent = `${dbCat.name}${dbCat.active === false ? ' (Inactive)' : ''}`;
        optGroup.appendChild(opt);
      }

      select.append(optUnresolved, optCreate, optSkip, optGroup);

      if (cat.effectiveStatus === 'mapped_existing' && cat.resolvedCategory) {
        select.value = `map:${cat.resolvedCategory.id}`;
      } else if (cat.effectiveStatus === 'create_historical') {
        select.value = 'create_historical';
      } else if (cat.effectiveStatus === 'skipped') {
        select.value = 'skip';
      } else {
        select.value = 'unmatched';
      }

      select.addEventListener('change', () => {
        const ui = blockUiState[blk.blockNumber] || {
          seriesId: blockReport.seriesId,
          confirmed: blockReport.confirmed,
          adminMappings: {},
        };
        const prevChoice = ui.adminMappings[cat.rawKey] || {};
        const val = select.value;
        if (val.startsWith('map:')) {
          ui.adminMappings[cat.rawKey] = {
            action: 'map',
            targetCategoryId: val.slice(4),
            saveAlias: prevChoice.saveAlias !== undefined ? prevChoice.saveAlias : true,
          };
        } else if (val === 'create_historical') {
          ui.adminMappings[cat.rawKey] = {
            action: 'create_historical',
            targetCategoryId: null,
            saveAlias: false,
          };
        } else if (val === 'skip') {
          ui.adminMappings[cat.rawKey] = {
            action: 'skip',
            targetCategoryId: null,
            saveAlias: false,
          };
        } else {
          delete ui.adminMappings[cat.rawKey];
        }
        blockUiState[blk.blockNumber] = ui;
        renderCurrentPreviewState();
      });

      actionWrap.appendChild(select);

      // Show "Save alias in category_aliases" checkbox when mapped to an existing category
      if (cat.effectiveStatus === 'mapped_existing' && cat.resolvedCategory) {
        const aliasLabel = document.createElement('label');
        aliasLabel.style.display = 'inline-flex';
        aliasLabel.style.alignItems = 'center';
        aliasLabel.style.gap = '6px';
        aliasLabel.style.fontSize = '11px';
        aliasLabel.style.color = 'var(--text-muted)';
        aliasLabel.style.cursor = 'pointer';

        const aliasCb = document.createElement('input');
        aliasCb.type = 'checkbox';
        aliasCb.checked = cat.saveAlias !== false;
        aliasCb.addEventListener('change', () => {
          const ui = blockUiState[blk.blockNumber] || {
            seriesId: blockReport.seriesId,
            confirmed: blockReport.confirmed,
            adminMappings: {},
          };
          if (ui.adminMappings[cat.rawKey]) {
            ui.adminMappings[cat.rawKey].saveAlias = aliasCb.checked;
            blockUiState[blk.blockNumber] = ui;
            renderCurrentPreviewState();
          }
        });

        const aliasText = document.createElement('span');
        aliasText.textContent = `Save alias "${cat.rawKey}" → "${cat.resolvedCategory.name}" for future imports`;
        aliasLabel.append(aliasCb, aliasText);
        actionWrap.appendChild(aliasLabel);
      }

      tdAction.appendChild(actionWrap);
    }

    // 7. Series Check (category_series membership + duplicate check)
    const tdSeriesCheck = document.createElement('td');
    if (cat.duplicateTargetError) {
      const dupBadge = document.createElement('span');
      dupBadge.className = 'badge num';
      dupBadge.style.backgroundColor = 'var(--color-danger-subtle)';
      dupBadge.style.color = 'var(--color-danger-text)';
      dupBadge.textContent = '🚫 Duplicate Target';
      tdSeriesCheck.appendChild(dupBadge);
    } else if (cat.effectiveStatus === 'create_historical') {
      const createSer = document.createElement('span');
      createSer.className = 'badge badge-inactive';
      createSer.textContent = blockReport.seriesName
        ? `Will create & link to ${blockReport.seriesName}`
        : 'Will create inactive category';
      tdSeriesCheck.appendChild(createSer);
    } else if (!cat.resolvedCategory) {
      const dash = document.createElement('span');
      dash.style.fontSize = 'var(--text-xs)';
      dash.style.color = 'var(--text-dim)';
      dash.textContent = '—';
      tdSeriesCheck.appendChild(dash);
    } else if (!blockReport.seriesId) {
      const noSer = document.createElement('span');
      noSer.className = 'badge badge-inactive';
      noSer.textContent = 'Select series above';
      tdSeriesCheck.appendChild(noSer);
    } else if (cat.inSelectedSeries) {
      const inSer = document.createElement('span');
      inSer.className = 'badge badge-success num';
      inSer.textContent = `✓ In ${blockReport.seriesName} (#${cat.seriesSortOrder})`;
      tdSeriesCheck.appendChild(inSer);
    } else {
      const notInSer = document.createElement('span');
      notInSer.className = 'badge badge-warning';
      notInSer.textContent = `⚠️ Will link to ${blockReport.seriesName}`;
      tdSeriesCheck.appendChild(notInSer);
    }

    tr.append(tdIdx, tdRef, tdName, tdKey, tdStatus, tdAction, tdSeriesCheck);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  wrap.appendChild(tableWrapper);

  // Informational box: Series round categories absent from this block
  if (catRes.absentCategories.length > 0) {
    const absentBox = document.createElement('div');
    absentBox.style.marginTop = 'var(--space-2)';
    absentBox.style.padding = 'var(--space-2) var(--space-3)';
    absentBox.style.backgroundColor = 'var(--bg-surface-subtle)';
    absentBox.style.borderRadius = 'var(--radius-sm)';
    absentBox.style.fontSize = 'var(--text-xs)';
    absentBox.style.color = 'var(--text-muted)';

    const absentLabel = document.createElement('strong');
    const scopeName = blockReport.seriesName || 'Database';
    absentLabel.textContent = `${scopeName} categories absent from Block ${blk.blockNumber} (${catRes.absentCategories.length}, info only): `;
    const absentNames = document.createElement('span');
    absentNames.textContent = catRes.absentCategories
      .map((c) => (c.active ? c.name : `${c.name} [inactive]`))
      .join(', ');

    absentBox.append(absentLabel, absentNames);
    wrap.appendChild(absentBox);
  }

  return wrap;
}

/**
 * Builds the Round-by-Round Table with Database Comparison, Cross-Check Chips, and Expandable Cell Drawer
 */
function buildBlockRoundsSection(blk, blockReport, selectedStudent) {
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
  h3.textContent = `Block ${blk.blockNumber} Rounds & Database Comparison (${blk.rounds.length})`;

  const rc = dataComp.summaryCounts.rounds;
  const compSummaryBadge = document.createElement('span');
  compSummaryBadge.className = 'badge badge-inactive num';
  compSummaryBadge.textContent =
    selectedStudent && blockReport.seriesId
      ? `${rc.newRounds} New · ${rc.existingIdentical} Identical · ${rc.existingAddsCells} Add Scores · ${rc.existingWithConflicts} Diff/Conflict`
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
      .map((r) => `Round ${r.roundNumber} (${r.roundDate}, ${r.scoresCount} scores)`)
      .join(' · ');
    dbOnlyBar.textContent = `ℹ️ Existing rounds in "${blockReport.seriesName}" not in this sheet (${dataComp.dbOnlyRounds.length}, kept untouched): ${listStr}`;
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
  [
    'Round #',
    'Date (IST)',
    'Round Type',
    'Time Taken',
    'DB Comparison',
    'Cells Status',
    'Cross-Checks (Tap chip)',
    'Date Flags',
    'Inspect Cells',
  ].forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const rnd of blk.rounds) {
    const rComp = roundCompByNum.get(Number(rnd.roundNumber)) || null;
    const tr = document.createElement('tr');

    // 1. Round #
    const tdRound = document.createElement('td');
    tdRound.className = 'num';
    const rStrong = document.createElement('strong');
    rStrong.textContent = `Round ${rnd.roundNumber}`;
    const rRef = document.createElement('code');
    rRef.className = 'import-cell-ref num';
    rRef.style.marginLeft = '6px';
    rRef.textContent = rnd.headerRef;
    tdRound.append(rStrong, rRef);

    // 2. Date
    const tdDate = document.createElement('td');
    tdDate.className = 'num';
    if (rnd.dateStatus === 'ok' && rnd.dateISO) {
      const dateMain = document.createElement('div');
      dateMain.style.fontWeight = '600';
      dateMain.textContent = rnd.dateISO;
      const dateSub = document.createElement('div');
      dateSub.style.fontSize = '11px';
      dateSub.style.color = 'var(--text-dim)';
      dateSub.textContent = `${formatDisplayDateIST(rnd.dateISO)} (${rnd.dateRef})`;
      tdDate.append(dateMain, dateSub);

      if (rComp && rComp.dateDiffers && rComp.existingRound) {
        const dbDateDiff = document.createElement('div');
        dbDateDiff.style.fontSize = '11px';
        dbDateDiff.style.color = 'var(--color-warning-text)';
        dbDateDiff.textContent = `DB Date: ${rComp.existingRound.round_date}`;
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
    if (rnd.summary.timeTakenUnreadable) {
      const badTime = document.createElement('span');
      badTime.className = 'badge badge-warning num';
      badTime.textContent = `Unreadable: "${rnd.summary.timeTakenRaw}" (${rnd.summary.timeTakenRef})`;
      tdTime.appendChild(badTime);
    } else {
      const timeMain = document.createElement('div');
      timeMain.textContent = rnd.summary.timeTakenDisplay || '—';
      tdTime.appendChild(timeMain);
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
    if (!selectedStudent || !blockReport.seriesId || !rComp) {
      const pendingBadge = document.createElement('span');
      pendingBadge.className = 'badge badge-inactive';
      pendingBadge.textContent = 'Select student & series';
      tdDbComp.appendChild(pendingBadge);
    } else {
      const compBadge = document.createElement('span');
      const cCounts = rComp.counts;
      if (rComp.roundComparisonStatus === 'new') {
        compBadge.className = 'badge badge-success num';
        compBadge.textContent = `NEW ROUND (+${cCounts.newCells})`;
      } else if (rComp.roundComparisonStatus === 'identical') {
        compBadge.className = 'badge badge-inactive num';
        compBadge.textContent = `IDENTICAL IN DB (${cCounts.identicalCells})`;
      } else if (rComp.roundComparisonStatus === 'adds_cells') {
        compBadge.className = 'badge badge-success num';
        compBadge.textContent = `EXISTING · +${cCounts.newCells} NEW`;
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
      if (cCounts.newCells > 0) detailParts.push(`${cCounts.newCells} new`);
      if (cCounts.identicalCells > 0) detailParts.push(`${cCounts.identicalCells} identical`);
      if (cCounts.conflictCells > 0) detailParts.push(`${cCounts.conflictCells} conflict`);
      if (cCounts.protectedConflictCells > 0)
        detailParts.push(`${cCounts.protectedConflictCells} protected`);
      if (cCounts.dbOnlyCells > 0) detailParts.push(`${cCounts.dbOnlyCells} DB-only`);
      subComp.textContent = detailParts.join(' · ') || 'No score diffs';
      tdDbComp.appendChild(subComp);
    }

    // 6. Cells OK count
    const tdCells = document.createElement('td');
    tdCells.className = 'num';
    const okSpan = document.createElement('div');
    okSpan.style.fontWeight = '600';
    okSpan.textContent = `${rnd.computed.okCount} OK`;
    const subParts = [];
    if (rnd.computed.emptyCount > 0) subParts.push(`${rnd.computed.emptyCount} empty`);
    if (rnd.computed.noteCount > 0) subParts.push(`${rnd.computed.noteCount} note`);
    if (rnd.computed.unreadableCount > 0)
      subParts.push(`${rnd.computed.unreadableCount} unreadable`);
    const subSpan = document.createElement('div');
    subSpan.style.fontSize = '11px';
    subSpan.style.color =
      rnd.computed.unreadableCount > 0 ? 'var(--color-danger-text)' : 'var(--text-dim)';
    subSpan.textContent = subParts.join(' · ') || '0 empty';
    tdCells.append(okSpan, subSpan);

    // 7. Cross-Checks (Final Score, Total Attempt, Marks TO BE CORRECTED)
    const tdChecks = document.createElement('td');
    const checksWrap = document.createElement('div');
    checksWrap.style.display = 'flex';
    checksWrap.style.flexWrap = 'wrap';
    checksWrap.style.gap = '4px';

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

      if (check.status === 'OK') {
        chip.classList.add('badge-success');
        chip.textContent = `${shortLabel}: OK (${check.computedValue})`;
      } else if (check.status === 'MISMATCH') {
        chip.classList.add('badge-warning');
        const diffStr = check.diff > 0 ? `+${check.diff}` : String(check.diff);
        chip.textContent = `${shortLabel}: MISMATCH (${diffStr})`;
        checkDetailBox.style.display = 'block';
        checkDetailBox.textContent = `${check.label}: Sheet = ${check.sheetValue}, Computed = ${check.computedValue} (Diff: ${diffStr})`;
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
              ? `+${check.diff}`
              : String(check.diff)
            : 'N/A';
        const sheetStr =
          check.sheetValue !== null && check.sheetValue !== undefined
            ? String(check.sheetValue)
            : '—';
        const text = `${check.label} (${check.status}) — Sheet: ${sheetStr} · Computed from cells: ${check.computedValue} · Diff: ${diffStr}`;
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

    // 9. Expandable Cell Drawer Toggle
    const tdExpand = document.createElement('td');
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn btn-outline btn-sm num';
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.textContent = `Cells (${rnd.cells.length}) ▾`;

    // Detail Row (initially hidden)
    const detailTr = document.createElement('tr');
    detailTr.style.display = 'none';
    detailTr.style.backgroundColor = 'var(--bg-surface-subtle)';

    const detailTd = document.createElement('td');
    detailTd.colSpan = 9;
    detailTd.style.padding = 'var(--space-4)';
    detailTd.appendChild(buildRoundCellsDetailTable(rnd, blk, rComp));
    detailTr.appendChild(detailTd);

    expandBtn.addEventListener('click', () => {
      const isHidden = detailTr.style.display === 'none';
      detailTr.style.display = isHidden ? 'table-row' : 'none';
      expandBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      expandBtn.textContent = isHidden
        ? `Hide (${rnd.cells.length}) ▴`
        : `Cells (${rnd.cells.length}) ▾`;
    });

    tdExpand.appendChild(expandBtn);
    tr.append(tdRound, tdDate, tdType, tdTime, tdDbComp, tdCells, tdChecks, tdFlags, tdExpand);
    tbody.append(tr, detailTr);
  }

  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  wrap.appendChild(tableWrapper);

  return wrap;
}

/**
 * Builds the inner per-cell inspection & database comparison table for an expanded round
 */
function buildRoundCellsDetailTable(rnd, blk, rComp) {
  const container = document.createElement('div');

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
  [
    'Score Ref',
    'Time Ref',
    'Category (Sheet → DB)',
    'In CSV Sheet',
    'Existing in Database',
    'Parse Status',
    'DB Comparison',
  ].forEach((h) => {
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
    const tr = document.createElement('tr');

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
    if (cell.status === 'note') {
      tdSheetVal.textContent = `Note: "${cell.note}"`;
    } else if (cell.correct !== null && cell.total !== null) {
      const timeStr =
        cell.timeSeconds !== null
          ? `, ${formatSecondsDisplay(cell.timeSeconds)} (${cell.timeSeconds}s)`
          : '';
      tdSheetVal.textContent = `${cell.correct} / ${cell.total}${timeStr}`;
    } else if (cell.status === 'unreadable') {
      tdSheetVal.textContent = `${cell.rawScore.trim() || '—'} / ${cell.rawTime.trim() || '—'}`;
    } else {
      tdSheetVal.textContent = '— (Empty)';
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
    if (cell.status === 'ok') {
      stBadge.className = 'badge badge-success';
      stBadge.textContent = 'OK';
    } else if (cell.status === 'empty') {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = 'Empty';
    } else if (cell.status === 'note') {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = 'Surprise Note';
    } else {
      stBadge.className = 'badge';
      stBadge.style.backgroundColor = 'var(--color-danger-subtle)';
      stBadge.style.color = 'var(--color-danger-text)';
      stBadge.textContent = cell.reason || 'Unreadable';
    }
    tdParseStatus.appendChild(stBadge);

    const tdCompStatus = document.createElement('td');
    const cmpBadge = document.createElement('span');
    const cmpStatus = cc ? cc.comparisonStatus : 'empty';
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
      cmpBadge.textContent = 'Category Skipped';
    } else if (cmpStatus === 'unresolved_category') {
      cmpBadge.className = 'badge badge-warning';
      cmpBadge.textContent = 'Unresolved Category';
    } else if (cmpStatus === 'unreadable') {
      cmpBadge.className = 'badge';
      cmpBadge.style.backgroundColor = 'var(--color-danger-subtle)';
      cmpBadge.style.color = 'var(--color-danger-text)';
      cmpBadge.textContent = 'Blocked (Unreadable)';
    } else {
      cmpBadge.className = 'badge badge-inactive';
      cmpBadge.textContent = '—';
    }
    tdCompStatus.appendChild(cmpBadge);

    tr.append(tdSRef, tdTRef, tdCat, tdSheetVal, tdDbVal, tdParseStatus, tdCompStatus);
    tbody.appendChild(tr);
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

      tr.append(tdSRef, tdTRef, tdCat, tdSheet, tdDb, tdParse, tdComp);
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

    tr.append(tdRef, tdDash, tdCat, tdRawS, tdDb, tdParsed, tdStatus);
    tbody.appendChild(tr);
  }

  subTable.appendChild(tbody);
  container.appendChild(subTable);
  return container;
}

/**
 * Updates the bottom Step 3 readiness indicator and Import button state
 */
function renderReadinessAndActionState(previewState, executionPlan, selectedStudent) {
  const statusEl = document.getElementById('import-readiness-status');
  const hintEl = document.getElementById('import-action-hint');
  const importBtn = document.getElementById('btn-import-execute');
  if (!statusEl || !importBtn) return;

  const isReady = Boolean(executionPlan && executionPlan.readyToImport && !isImporting);

  if (!isReady) {
    const count = executionPlan ? executionPlan.blockingReasons.length : 1;
    statusEl.className = 'badge num';
    statusEl.style.backgroundColor = 'var(--color-danger-subtle)';
    statusEl.style.color = 'var(--color-danger-text)';
    statusEl.textContent = `${count} Blocking Issue${count === 1 ? '' : 's'} Remaining`;

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
    statusEl.textContent = `✓ Ready to Import (${executionPlan.totalRounds} round${
      executionPlan.totalRounds === 1 ? '' : 's'
    } · ${executionPlan.rowsFound} score cell${executionPlan.rowsFound === 1 ? '' : 's'})`;

    if (hintEl && selectedStudent) {
      hintEl.textContent = `Ready to save import for ${selectedStudent.full_name} (${selectedStudent.student_code}).`;
    }

    importBtn.disabled = false;
    importBtn.removeAttribute('aria-disabled');
    importBtn.textContent = `Import Score Sheet (${executionPlan.totalRounds} Rounds)`;
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
      .map((bp) => `Block ${bp.blockNumber} → ${bp.seriesName} (${bp.rounds.length} rounds)`)
      .join(' · ')
  );
  addSummaryLine(
    'Total Rounds & Cells:',
    `${executionPlan.totalRounds} rounds · ${executionPlan.rowsFound} score cells`
  );
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

  // If student name in file differs from selected student, show warning & required confirmation checkbox
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
 * Executes the planned import strictly using the Phase 4c-2b database RPCs:
 * 1. `admin_start_import(p_student, p_file_name, p_name_in_file, p_mark_verified, p_rows_found, p_summary)`
 * 2. `admin_import_ensure_category(p_batch, p_series, p_category, p_new_name)` + `category_aliases` upsert
 * 3. `admin_import_rounds(p_batch, p_series, p_rounds, p_on_date_conflict)` in chunks (<=100 rounds, <=3000 cells)
 * 4. `admin_finish_import(p_batch)`
 */
async function executePlannedImport(executionPlan) {
  if (!executionPlan || !executionPlan.readyToImport || isImporting) return;

  isImporting = true;
  const importBtn = document.getElementById('btn-import-execute');
  const progressBanner = document.getElementById('import-progress-banner');

  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
  }

  const updateProgress = (msg, isError = false) => {
    if (!progressBanner) return;
    progressBanner.style.display = 'block';
    progressBanner.className = isError ? 'banner banner-error' : 'banner banner-info';
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
        updateProgress(
          `Step 2/4: Ensuring ${bp.categoriesToEnsure.length} categor${
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

      // 3. Materialize round chunks (1..100 rounds and <= 3000 cells per call) and call `admin_import_rounds`
      const roundChunks = materializeBlockRoundChunks(bp, ensuredCategoryByRowIndex);

      for (let cIdx = 0; cIdx < roundChunks.length; cIdx++) {
        const chunk = roundChunks[cIdx];
        updateProgress(
          `Step 3/4: Importing Block ${bp.blockNumber} (${bp.seriesName}) — chunk ${cIdx + 1} of ${
            roundChunks.length
          } (${chunk.length} round${chunk.length === 1 ? '' : 's'})...`
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

    showToast(
      'success',
      `Import complete: ${cumulativeTotals.rounds_created} rounds created, ${cumulativeTotals.rounds_merged} merged, ${cumulativeTotals.cells_inserted} scores inserted.`
    );

    renderImportResultBanner({
      type: 'import_success',
      batchId,
      studentId: executionPlan.studentId,
      studentName: executionPlan.studentName,
      studentCode: executionPlan.studentCode,
      fileName: executionPlan.fileName,
      totals: cumulativeTotals,
    });

    // Reload reference data (new categories/series links/aliases), student rounds/results, preview, and history
    await loadReferenceData(true);
    await ensureStudentExistingDataLoaded(executionPlan.studentId, true);
    await loadImportBatches();
    renderCurrentPreviewState();
  } catch (err) {
    console.error('Import failed:', err);
    const readableMsg = err.message || 'An unexpected error occurred during import.';
    updateProgress(`Import failed: ${readableMsg}`, true);
    showToast('error', `Import failed: ${readableMsg}`);
    await loadImportBatches();
  } finally {
    isImporting = false;
    if (currentParsedResult && currentParsedResult.ok) {
      renderReadinessAndActionState(
        currentPreviewState,
        currentExecutionPlan,
        getSelectedStudent()
      );
    }
  }
}

/**
 * Renders the top result banner after an Import or Undo completes
 */
function renderImportResultBanner(info) {
  const banner = document.getElementById('import-operation-result-banner');
  if (!banner) return;
  banner.replaceChildren();
  banner.style.display = 'block';

  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'space-between';
  topRow.style.alignItems = 'flex-start';
  topRow.style.flexWrap = 'wrap';
  topRow.style.gap = 'var(--space-3)';

  const left = document.createElement('div');
  const title = document.createElement('h3');
  title.style.fontSize = 'var(--text-base)';
  title.style.marginBottom = '4px';

  const details = document.createElement('div');
  details.style.fontSize = 'var(--text-sm)';
  details.style.color = 'var(--text-main)';
  details.className = 'num';

  if (info.type === 'import_success') {
    const t = info.totals;
    title.textContent = `✓ Import Saved for ${info.studentName} (${info.studentCode})`;
    details.textContent = `File "${info.fileName}" — Rounds: ${t.rounds_created} created, ${t.rounds_merged} merged, ${t.rounds_skipped} skipped · Cells: ${t.cells_inserted} inserted, ${t.cells_skipped} skipped (existing kept).`;
  } else {
    const u = info.undoTotals;
    title.textContent = '↩ Import Batch Undone';
    details.textContent = `Batch undone (${info.reason}) — ${u.results_deleted} score${
      u.results_deleted === 1 ? '' : 's'
    } deleted, ${u.results_kept} score${
      u.results_kept === 1 ? '' : 's'
    } kept (corrected/verified), ${u.rounds_deleted} round${
      u.rounds_deleted === 1 ? '' : 's'
    } deleted.`;
  }

  left.append(title, details);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = 'var(--space-2)';
  actions.style.alignItems = 'center';
  actions.style.flexWrap = 'wrap';

  if (info.studentId) {
    const detailLink = document.createElement('a');
    detailLink.href = `/pages/student-detail.html?id=${encodeURIComponent(info.studentId)}`;
    detailLink.className = 'btn btn-outline btn-sm';
    detailLink.textContent = 'View Student Score Sheet';

    const reviewLink = document.createElement('a');
    reviewLink.href = `/pages/review.html?studentId=${encodeURIComponent(info.studentId)}`;
    reviewLink.className = 'btn btn-outline btn-sm';
    reviewLink.textContent = 'Review Student Entries';

    actions.append(detailLink, reviewLink);
  }

  if (info.type === 'import_success' && info.batchId) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'btn btn-outline btn-sm';
    undoBtn.textContent = '↩ Undo This Import';
    undoBtn.addEventListener('click', () => {
      openUndoImportModal({
        id: info.batchId,
        studentName: info.studentName,
        studentCode: info.studentCode,
        fileName: info.fileName,
      });
    });
    actions.appendChild(undoBtn);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn btn-outline btn-sm';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    banner.style.display = 'none';
  });
  actions.appendChild(dismissBtn);

  topRow.append(left, actions);
  banner.appendChild(topRow);
}

/**
 * Normalizes a raw `import_batches` row so all column variants render cleanly
 */
function normalizeImportBatchRow(row, studentsById) {
  const stu = row.student_id ? studentsById.get(row.student_id) || null : null;
  const summaryObj = row.summary && typeof row.summary === 'object' ? row.summary : {};
  const isUndone = Boolean(row.status === 'undone' || row.undone_at);
  const isFinished = Boolean(
    row.status === 'completed' || row.status === 'finished' || row.finished_at
  );

  return {
    id: row.id,
    studentId: row.student_id || null,
    studentName: stu ? stu.full_name : row.student_name || 'Student',
    studentCode: stu ? stu.student_code : row.student_code || '—',
    fileName: row.file_name || 'scoresheet.csv',
    nameInFile: row.name_in_file || summaryObj.name_in_file || null,
    markVerified: Boolean(row.mark_verified ?? summaryObj.mark_verified),
    rowsFound: Number(row.rows_found ?? summaryObj.planned_cells ?? 0),
    roundsCreated: Number(row.rounds_created ?? summaryObj.rounds_created ?? 0),
    roundsMerged: Number(row.rounds_merged ?? summaryObj.rounds_merged ?? 0),
    roundsSkipped: Number(row.rounds_skipped ?? summaryObj.rounds_skipped ?? 0),
    cellsInserted: Number(
      row.cells_inserted ?? row.results_inserted ?? summaryObj.cells_inserted ?? 0
    ),
    cellsSkipped: Number(
      row.cells_skipped ?? row.results_skipped ?? summaryObj.cells_skipped ?? 0
    ),
    createdAt: row.created_at || row.started_at || row.imported_at || null,
    finishedAt: row.finished_at || row.completed_at || null,
    isUndone,
    isFinished,
    undoneAt: row.undone_at || null,
    undoReason: row.undo_reason || null,
    resultsDeleted:
      row.results_deleted !== undefined && row.results_deleted !== null
        ? Number(row.results_deleted)
        : null,
    resultsKept:
      row.results_kept !== undefined && row.results_kept !== null
        ? Number(row.results_kept)
        : null,
    roundsDeleted:
      row.rounds_deleted !== undefined && row.rounds_deleted !== null
        ? Number(row.rounds_deleted)
        : null,
  };
}

/**
 * Formats an ISO timestamp into Indian time (`Asia/Kolkata`) display string
 */
function formatDateTimeIST(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return String(isoString);
    const datePart = getISTDateString(d);
    const timePart = d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    return `${formatDisplayDateIST(datePart)} · ${timePart}`;
  } catch {
    return String(isoString);
  }
}

/**
 * Renders the Import History & Undo table (`import_batches`)
 */
function renderImportHistoryTable() {
  const container = document.getElementById('import-history-container');
  if (!container) return;
  container.replaceChildren();

  const filterMode = document.getElementById('import-history-filter')?.value || 'all';
  const selectedStudent = getSelectedStudent();
  const studentsById = new Map(allStudents.map((s) => [s.id, s]));

  let rows = importBatches.map((b) => normalizeImportBatchRow(b, studentsById));
  if (filterMode === 'selected' && selectedStudent) {
    rows = rows.filter((r) => r.studentId === selectedStudent.id);
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = 'var(--space-6)';
    empty.style.textAlign = 'center';
    const p = document.createElement('p');
    p.style.fontSize = 'var(--text-sm)';
    p.style.color = 'var(--text-muted)';
    p.style.margin = '0';
    p.textContent =
      filterMode === 'selected' && selectedStudent
        ? `No import batches recorded yet for ${selectedStudent.full_name} (${selectedStudent.student_code}).`
        : 'No CSV import batches have been saved yet.';
    empty.appendChild(p);
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
    'Import Summary',
    'Status',
    'Action',
  ].forEach((lbl) => {
    const th = document.createElement('th');
    th.textContent = lbl;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const batch of rows) {
    const tr = document.createElement('tr');

    // 1. Imported At (IST)
    const tdDate = document.createElement('td');
    tdDate.className = 'num';
    tdDate.style.fontSize = 'var(--text-xs)';
    tdDate.textContent = formatDateTimeIST(batch.createdAt);

    // 2. Student
    const tdStu = document.createElement('td');
    if (batch.studentId) {
      const stuLink = document.createElement('a');
      stuLink.href = `/pages/student-detail.html?id=${encodeURIComponent(batch.studentId)}`;
      stuLink.style.fontWeight = '600';
      stuLink.style.color = 'var(--color-primary)';
      stuLink.style.textDecoration = 'none';
      stuLink.textContent = batch.studentName;
      tdStu.appendChild(stuLink);
    } else {
      const stuSpan = document.createElement('strong');
      stuSpan.textContent = batch.studentName;
      tdStu.appendChild(stuSpan);
    }
    const stuSub = document.createElement('div');
    stuSub.style.fontSize = '11px';
    stuSub.style.color = 'var(--text-dim)';
    stuSub.className = 'num';
    stuSub.textContent = batch.studentCode;
    tdStu.appendChild(stuSub);

    // 3. CSV File & Name in File
    const tdFile = document.createElement('td');
    const fMain = document.createElement('div');
    fMain.style.fontWeight = '600';
    fMain.style.fontSize = 'var(--text-xs)';
    fMain.textContent = batch.fileName;
    const fSub = document.createElement('div');
    fSub.style.fontSize = '11px';
    fSub.style.color = 'var(--text-muted)';
    fSub.textContent = batch.nameInFile
      ? `In sheet: "${batch.nameInFile}" (${batch.rowsFound} cells)`
      : `${batch.rowsFound} cells found`;
    tdFile.append(fMain, fSub);

    // 4. Verified Flag
    const tdVer = document.createElement('td');
    const verBadge = document.createElement('span');
    verBadge.className = batch.markVerified ? 'badge badge-success' : 'badge badge-inactive';
    verBadge.textContent = batch.markVerified ? '🔒 Verified' : 'Unverified';
    tdVer.appendChild(verBadge);

    // 5. Import Summary
    const tdSum = document.createElement('td');
    tdSum.className = 'num';
    tdSum.style.fontSize = 'var(--text-xs)';
    const rLine = document.createElement('div');
    rLine.textContent = `Rounds: +${batch.roundsCreated} created · ${batch.roundsMerged} merged · ${batch.roundsSkipped} skipped`;
    const cLine = document.createElement('div');
    cLine.style.color = 'var(--text-muted)';
    cLine.style.fontSize = '11px';
    cLine.textContent = `Cells: +${batch.cellsInserted} inserted · ${batch.cellsSkipped} skipped`;
    tdSum.append(rLine, cLine);

    // 6. Status
    const tdStatus = document.createElement('td');
    const stBadge = document.createElement('span');
    if (batch.isUndone) {
      stBadge.className = 'badge badge-inactive';
      stBadge.textContent = '↩ Undone';
      tdStatus.appendChild(stBadge);

      if (batch.undoReason) {
        const reasonDiv = document.createElement('div');
        reasonDiv.style.fontSize = '11px';
        reasonDiv.style.color = 'var(--text-muted)';
        reasonDiv.style.marginTop = '3px';
        reasonDiv.textContent = `Reason: "${batch.undoReason}"`;
        tdStatus.appendChild(reasonDiv);
      }
      if (batch.resultsDeleted !== null) {
        const countsDiv = document.createElement('div');
        countsDiv.style.fontSize = '11px';
        countsDiv.style.color = 'var(--text-dim)';
        countsDiv.className = 'num';
        countsDiv.textContent = `${batch.resultsDeleted} del · ${batch.resultsKept ?? 0} kept · ${batch.roundsDeleted ?? 0} rounds del`;
        tdStatus.appendChild(countsDiv);
      }
    } else if (batch.isFinished) {
      stBadge.className = 'badge badge-success';
      stBadge.textContent = '✓ Completed';
      tdStatus.appendChild(stBadge);
    } else {
      stBadge.className = 'badge badge-warning';
      stBadge.textContent = 'In Progress / Partial';
      tdStatus.appendChild(stBadge);
    }

    // 7. Action (Undo)
    const tdAction = document.createElement('td');
    if (!batch.isUndone) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'btn btn-outline btn-sm';
      undoBtn.textContent = '↩ Undo';
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

    tr.append(tdDate, tdStu, tdFile, tdVer, tdSum, tdStatus, tdAction);
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
    empty.textContent = 'No custom database aliases saved yet. Built-in aliases ("calender", "timeelapse") are always active.';
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
