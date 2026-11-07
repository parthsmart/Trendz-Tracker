/**
 * Trendz Tracker - Admin Attendance Controller (js/attendance.js)
 * 
 * Manage attendance sessions and student attendance records:
 * - Admin-only route guard
 * - Sessions list (newest first) with counts of Present, Absent, Excused, and Not Marked
 * - Create & Edit Session Modal (date, title, type, notes; no delete in this phase)
 * - Active students attendance grid with Present / Absent / Excused toggles
 * - "Mark all present" bulk button
 * - In-browser roster search & filtering (name, ID, level)
 * - Warning before saving if any active students remain unmarked
 * - Upsert on (session_id, student_id) setting marked_by to authenticated admin
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getISTDateString, formatDisplayDateIST } from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let currentProfile = null;
let allSessions = [];
let selectedSessionId = null;
let activeStudentsList = [];
let activeStudentsPromise = null;
let rosterLoadError = null;
let testSupabaseClient = null;
let sessionAttendanceMap = new Map(); // studentId -> { status: 'present'|'absent'|'excused'|null, note: string }
let rosterSearchQuery = '';
let saveAndAddAnotherSessionMode = false;

async function initAttendancePage() {
  currentProfile = await requireAuth(['teacher', 'admin']);
  if (!currentProfile) return;

  if (currentProfile.role === 'teacher') {
    if (currentProfile.permissions?.can_mark_attendance === false) {
      window.location.href = '/pages/teacher.html';
      return;
    }
    const heading = document.querySelector('h1');
    if (heading) {
      heading.innerHTML = 'Attendance <span class="badge badge-info" style="font-size: var(--text-xs); vertical-align: middle; margin-left: 8px;">Assigned students only</span>';
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

  setupSessionModalHandlers();
  setupRosterHandlers();

  // Load active students first, then load sessions to prevent misleading zero unmarked counts
  try {
    await loadActiveStudents();
  } catch (err) {
    // rosterLoadError is stored; will be displayed in roster table and sessions list
  }
  await loadSessions();
}

/**
 * Loads all active students for attendance marking
 */
async function loadActiveStudents() {
  rosterLoadError = null;
  activeStudentsPromise = (async () => {
    if (testSupabaseClient || isSupabaseConfigured()) {
      const supabase = testSupabaseClient || (await getSupabase());
      if (currentProfile?.role === 'teacher') {
        const { data: assignments, error: assignErr } = await supabase
          .from('teacher_student_assignments')
          .select('student_id')
          .eq('teacher_id', currentProfile.id);

        if (assignErr) throw assignErr;
        const assignedIds = (assignments || []).map((a) => a.student_id);

        if (assignedIds.length === 0) {
          activeStudentsList = [];
          return activeStudentsList;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, student_code, level, active')
          .in('id', assignedIds)
          .eq('role', 'student')
          .eq('active', true)
          .order('student_code', { ascending: true });

        if (error) throw error;
        activeStudentsList = data || [];
        return activeStudentsList;
      } else {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, student_code, level, active')
          .eq('role', 'student')
          .eq('active', true)
          .order('student_code', { ascending: true });

        if (error) throw error;
        activeStudentsList = data || [];
        return activeStudentsList;
      }
    } else {
      activeStudentsList = DemoDB.getStudents().filter(s => s.role === 'student' && s.active !== false);
      return activeStudentsList;
    }
  })();

  try {
    return await activeStudentsPromise;
  } catch (err) {
    rosterLoadError = err;
    activeStudentsList = [];
    console.warn('Failed to load active students:', err);
    throw err;
  }
}

/**
 * Loads all sessions and their attendance counts
 */
async function loadSessions(selectIdAfterLoad = null) {
  // Guarantee active students loading has settled before computing session unmarked counts
  if (activeStudentsPromise) {
    try {
      await activeStudentsPromise;
    } catch (_) {
      // rosterLoadError is handled below to avoid misleading zero counts
    }
  }

  const container = document.getElementById('sessions-list-container');
  const countLabel = document.getElementById('session-count-label');

  if (container && allSessions.length === 0) {
    container.innerHTML = '<div class="loading-state" style="padding: var(--space-6); text-align: center;">Loading sessions...</div>';
  }

  try {
    if (testSupabaseClient || isSupabaseConfigured()) {
      const supabase = testSupabaseClient || (await getSupabase());

      // 1. Fetch sessions
      const { data: sessions, error: sesErr } = await supabase
        .from('attendance_sessions')
        .select('*')
        .order('session_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (sesErr) throw new Error(sesErr.message);

      // 2. Fetch all attendance records to calculate counts
      const { data: attRecords, error: attErr } = await supabase
        .from('attendance')
        .select('session_id, student_id, status');

      if (attErr) throw new Error(attErr.message);

      const rosterFailed = Boolean(rosterLoadError);
      const activeCount = rosterFailed ? null : activeStudentsList.length;

      // Group attendance by session
      const attMap = new Map();
      (attRecords || []).forEach(r => {
        if (!attMap.has(r.session_id)) attMap.set(r.session_id, []);
        attMap.get(r.session_id).push(r);
      });

      allSessions = (sessions || []).map(ses => {
        const records = attMap.get(ses.id) || [];
        let present = 0;
        let absent = 0;
        let excused = 0;
        const markedIds = new Set();

        records.forEach(r => {
          markedIds.add(r.student_id);
          if (r.status === 'present') present++;
          else if (r.status === 'absent') absent++;
          else if (r.status === 'excused') excused++;
        });

        const unmarked = rosterFailed ? null : Math.max(0, activeCount - markedIds.size);

        return {
          ...ses,
          present_count: present,
          absent_count: absent,
          excused_count: excused,
          unmarked_count: unmarked,
          roster_error: rosterFailed
        };
      });

    } else {
      // Demo Mode
      allSessions = DemoDB.getAttendanceSessions();
    }

    if (countLabel) {
      countLabel.textContent = `${allSessions.length} ${allSessions.length === 1 ? 'session' : 'sessions'}`;
    }

    renderSessionsList();

    // Select target session or first session if none selected
    if (selectIdAfterLoad) {
      selectSession(selectIdAfterLoad);
    } else if (!selectedSessionId && allSessions.length > 0) {
      selectSession(allSessions[0].id);
    } else if (selectedSessionId) {
      // Keep selected session active and refresh view
      selectSession(selectedSessionId);
    }

  } catch (err) {
    console.error('Failed to load attendance sessions:', err);
    if (container) {
      container.innerHTML = `
        <div style="color: var(--color-danger-text); font-size: var(--text-sm); padding: var(--space-4); text-align: center;">
          Failed to load sessions: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Renders the session list items in the left panel
 */
function renderSessionsList() {
  const container = document.getElementById('sessions-list-container');
  if (!container) return;

  if (allSessions.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-8); text-align: center;">
        <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-1);">No Sessions Created</h4>
        <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
          Click "+ New Session" to schedule a training class or workshop.
        </p>
      </div>
    `;
    return;
  }

  let html = '';
  allSessions.forEach(ses => {
    const isSelected = ses.id === selectedSessionId;
    const dateDisplay = ses.session_date ? formatDisplayDateIST(ses.session_date) : '—';

    html += `
      <div
        class="session-list-item ${isSelected ? 'active' : ''}"
        data-session-id="${ses.id}"
        style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-hairline); cursor: pointer; transition: background 0.15s ease; ${isSelected ? 'background: var(--bg-surface-subtle); border-left: 4px solid var(--color-primary);' : ''}"
      >
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-1);">
          <strong style="font-size: var(--text-sm); color: var(--text-main); font-weight: 600;">
            ${escapeHtml(ses.title)}
          </strong>
          <span class="status-chip chip-neutral">
            ${escapeHtml(ses.session_type)}
          </span>
        </div>

        <div style="font-size: var(--text-sm); color: var(--text-muted); margin-bottom: var(--space-2);">
          ${dateDisplay}
        </div>

        <div style="display: flex; gap: var(--space-2); font-size: var(--text-sm); flex-wrap: wrap;">
          <span class="status-chip chip-neutral">
            ${ses.present_count} Present
          </span>
          <span class="status-chip ${ses.absent_count > 0 ? 'chip-danger' : 'chip-neutral'}">
            ${ses.absent_count} Absent
          </span>
          <span class="status-chip chip-neutral">
            ${ses.excused_count} Excused
          </span>
          ${ses.roster_error ? `
            <span class="status-chip chip-danger" title="Student roster failed to load">
              Roster unavailable
            </span>
          ` : (ses.unmarked_count > 0 ? `
            <span class="status-chip chip-warning">
              ${ses.unmarked_count} Unmarked
            </span>
          ` : '')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Click listeners on session list items
  container.querySelectorAll('.session-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const sesId = el.getAttribute('data-session-id');
      selectSession(sesId);
    });
  });
}

/**
 * Selects an active session and loads its student roster
 */
async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderSessionsList();

  const emptyState = document.getElementById('session-empty-state');
  const activeState = document.getElementById('session-active-state');

  const session = allSessions.find(s => s.id === sessionId);
  if (!session) {
    if (emptyState) emptyState.style.display = 'block';
    if (activeState) activeState.style.display = 'none';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  if (activeState) activeState.style.display = 'block';

  // Render header details
  const typeChip = document.getElementById('active-session-type-chip');
  const dateDisplay = document.getElementById('active-session-date-display');
  const titleEl = document.getElementById('active-session-title');
  const notesEl = document.getElementById('active-session-notes');

  if (typeChip) typeChip.textContent = session.session_type;
  if (dateDisplay) dateDisplay.textContent = session.session_date ? formatDisplayDateIST(session.session_date) : '';
  if (titleEl) titleEl.textContent = session.title;
  if (notesEl) notesEl.textContent = session.notes || 'No session notes provided.';

  // Load existing attendance marks for this session
  await loadSessionAttendanceRecords(sessionId);
}

/**
 * Fetches attendance rows for the selected session
 */
async function loadSessionAttendanceRecords(sessionId) {
  sessionAttendanceMap.clear();

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('attendance')
        .select('*')
        .eq('session_id', sessionId);

      if (error) throw new Error(error.message);

      (data || []).forEach(r => {
        sessionAttendanceMap.set(r.student_id, {
          status: r.status,
          note: r.note || ''
        });
      });
    } else {
      const records = DemoDB.getSessionAttendance(sessionId);
      records.forEach(r => {
        sessionAttendanceMap.set(r.student.id, {
          status: r.status,
          note: r.note || ''
        });
      });
    }

    updateRosterCountsUI();
    renderStudentRosterGrid();

  } catch (err) {
    console.error('Failed to load session attendance:', err);
    showToast('error', 'Failed to load attendance records: ' + err.message);
  }
}

/**
 * Updates quick counts at top of active session
 */
function updateRosterCountsUI() {
  const pEl = document.getElementById('active-count-present');
  const aEl = document.getElementById('active-count-absent');
  const eEl = document.getElementById('active-count-excused');
  const uEl = document.getElementById('active-count-unmarked');

  if (rosterLoadError) {
    if (pEl) pEl.textContent = '—';
    if (aEl) aEl.textContent = '—';
    if (eEl) eEl.textContent = '—';
    if (uEl) uEl.textContent = 'Error';
    return;
  }

  let present = 0;
  let absent = 0;
  let excused = 0;
  let unmarked = 0;

  activeStudentsList.forEach(student => {
    const mark = sessionAttendanceMap.get(student.id);
    if (!mark || !mark.status) {
      unmarked++;
    } else if (mark.status === 'present') {
      present++;
    } else if (mark.status === 'absent') {
      absent++;
    } else if (mark.status === 'excused') {
      excused++;
    }
  });

  if (pEl) pEl.textContent = present;
  if (aEl) aEl.textContent = absent;
  if (eEl) eEl.textContent = excused;
  if (uEl) uEl.textContent = unmarked;
}

/**
 * Renders the active students attendance table
 */
function renderStudentRosterGrid() {
  const tbody = document.getElementById('attendance-roster-tbody');
  if (!tbody) return;

  if (rosterLoadError) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state" style="padding: var(--space-8); text-align: center;">
          <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-1); color: var(--color-danger-text);">Failed to Load Student Roster</h4>
          <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
            ${escapeHtml(rosterLoadError.message || 'Unable to fetch active students.')}
          </p>
        </td>
      </tr>
    `;
    return;
  }

  let displayStudents = activeStudentsList;
  if (rosterSearchQuery) {
    const q = rosterSearchQuery.toLowerCase();
    displayStudents = activeStudentsList.filter(s => {
      const name = (s.full_name || '').toLowerCase();
      const code = (s.student_code || '').toLowerCase();
      const level = (s.level || '').toLowerCase();
      return name.includes(q) || code.includes(q) || level.includes(q);
    });
  }

  if (displayStudents.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state" style="padding: var(--space-8); text-align: center;">
          <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-1);">${rosterSearchQuery ? 'No Students Found' : 'No Active Students'}</h4>
          <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
            ${rosterSearchQuery ? `No active students match "${escapeHtml(rosterSearchQuery)}".` : 'No active students found.'}
          </p>
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  displayStudents.forEach(student => {
    const mark = sessionAttendanceMap.get(student.id) || { status: null, note: '' };
    const status = mark.status; // 'present' | 'absent' | 'excused' | null

    html += `
      <tr data-student-id="${student.id}">
        <!-- Student -->
        <td>
          <a href="/pages/student-detail.html?id=${encodeURIComponent(student.id)}" class="student-name-link" style="font-size: var(--text-sm);">
            ${escapeHtml(student.full_name)}
          </a>
          <div style="font-size: var(--text-sm); color: var(--text-dim);">${escapeHtml(student.student_code)}</div>
        </td>

        <!-- Level -->
        <td>
          <span style="font-size: var(--text-sm); color: var(--text-muted);">${escapeHtml(student.level || '—')}</span>
        </td>

        <!-- Status Toggle Buttons -->
        <td style="text-align: center;">
          <div class="attendance-toggle-group">
            <button
              type="button"
              class="btn-status-toggle ${status === 'present' ? 'active-present' : ''}"
              data-status="present"
              data-student-id="${student.id}"
            >
              Present
            </button>
            <button
              type="button"
              class="btn-status-toggle ${status === 'absent' ? 'active-absent' : ''}"
              data-status="absent"
              data-student-id="${student.id}"
            >
              Absent
            </button>
            <button
              type="button"
              class="btn-status-toggle ${status === 'excused' ? 'active-excused' : ''}"
              data-status="excused"
              data-student-id="${student.id}"
            >
              Excused
            </button>
          </div>
          ${!status ? `
            <div style="margin-top: var(--space-1);">
              <span class="status-unmarked-pill">Not marked</span>
            </div>
          ` : ''}
        </td>

        <!-- Note Input -->
        <td>
          <input
            type="text"
            class="form-input attendance-note-input"
            data-student-id="${student.id}"
            placeholder="Reason or note..."
            value="${escapeHtml(mark.note || '')}"
          />
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  attachRosterActionListeners();
}

/**
 * Event listeners for attendance toggle buttons and note inputs
 */
function attachRosterActionListeners() {
  // Toggle buttons
  document.querySelectorAll('.btn-status-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.getAttribute('data-student-id');
      const newStatus = btn.getAttribute('data-status');

      const current = sessionAttendanceMap.get(studentId) || { status: null, note: '' };
      // Clicking same status un-marks it
      const nextStatus = current.status === newStatus ? null : newStatus;

      sessionAttendanceMap.set(studentId, {
        ...current,
        status: nextStatus
      });

      updateRosterCountsUI();
      renderStudentRosterGrid();
    });
  });

  // Note inputs
  document.querySelectorAll('.attendance-note-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const studentId = input.getAttribute('data-student-id');
      const noteVal = e.target.value;
      const current = sessionAttendanceMap.get(studentId) || { status: null, note: '' };
      sessionAttendanceMap.set(studentId, {
        ...current,
        note: noteVal
      });
    });
  });
}

/**
 * Sets up search, "Mark All Present", and Save buttons
 */
function setupRosterHandlers() {
  const searchInput = document.getElementById('roster-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      rosterSearchQuery = e.target.value.trim();
      renderStudentRosterGrid();
    });
  }

  const btnMarkAll = document.getElementById('btn-mark-all-present');
  if (btnMarkAll) {
    btnMarkAll.addEventListener('click', () => {
      if (rosterLoadError) {
        showToast('error', 'Cannot mark attendance: student roster failed to load.');
        return;
      }
      activeStudentsList.forEach(student => {
        const current = sessionAttendanceMap.get(student.id) || { status: null, note: '' };
        sessionAttendanceMap.set(student.id, {
          ...current,
          status: 'present'
        });
      });
      updateRosterCountsUI();
      renderStudentRosterGrid();
      showToast('success', `Marked all ${activeStudentsList.length} active students present.`);
    });
  }

  const btnSaveTop = document.getElementById('btn-save-attendance');
  const btnSaveBottom = document.getElementById('btn-save-attendance-bottom');

  if (btnSaveTop) btnSaveTop.onclick = handleSaveAttendanceClick;
  if (btnSaveBottom) btnSaveBottom.onclick = handleSaveAttendanceClick;
}

/**
 * Validates unmarked students and saves attendance records
 */
async function handleSaveAttendanceClick() {
  if (!selectedSessionId) return;

  if (rosterLoadError) {
    showToast('error', 'Cannot save attendance: student roster failed to load.');
    return;
  }

  // Count unmarked active students
  let unmarkedCount = 0;
  activeStudentsList.forEach(s => {
    const mark = sessionAttendanceMap.get(s.id);
    if (!mark || !mark.status) unmarkedCount++;
  });

  if (unmarkedCount > 0) {
    openUnmarkedWarningModal(unmarkedCount, async () => {
      await executeSaveAttendance();
    });
  } else {
    await executeSaveAttendance();
  }
}

/**
 * Saves attendance records to Supabase (upsert) or DemoDB
 */
async function executeSaveAttendance() {
  if (!selectedSessionId) return;

  const btnSaveTop = document.getElementById('btn-save-attendance');
  const btnSaveBottom = document.getElementById('btn-save-attendance-bottom');

  if (btnSaveTop) btnSaveTop.disabled = true;
  if (btnSaveBottom) btnSaveBottom.disabled = true;

  try {
    const recordsToSave = [];
    activeStudentsList.forEach(student => {
      const mark = sessionAttendanceMap.get(student.id);
      if (mark && mark.status) {
        recordsToSave.push({
          session_id: selectedSessionId,
          student_id: student.id,
          status: mark.status,
          note: mark.note ? mark.note.trim() : null
        });
      }
    });

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      if (currentProfile?.role === 'teacher') {
        const rpcRecords = recordsToSave.map((r) => ({
          student_id: r.student_id,
          status: r.status,
          note: r.note,
        }));

        const { data: rpcRes, error: rpcErr } = await supabase.rpc('teacher_save_attendance', {
          p_session_id: selectedSessionId,
          p_records: rpcRecords,
        });

        if (rpcErr) throw new Error(rpcErr.message);
      } else {
        const nowIso = new Date().toISOString();
        const payload = recordsToSave.map(r => ({
          ...r,
          marked_by: currentProfile.id,
          marked_at: nowIso
        }));

        // Upsert on unique constraint (session_id, student_id)
        const { error } = await supabase
          .from('attendance')
          .upsert(payload, { onConflict: 'session_id,student_id' });

        if (error) throw new Error(error.message);
      }
    } else {
      DemoDB.saveAttendanceRecords(selectedSessionId, recordsToSave, currentProfile.id);
    }

    showToast('success', `Attendance saved successfully for ${recordsToSave.length} students.`);
    await loadSessions();

  } catch (err) {
    console.error('Failed to save attendance:', err);
    showToast('error', 'Failed to save attendance: ' + err.message);
  } finally {
    if (btnSaveTop) btnSaveTop.disabled = false;
    if (btnSaveBottom) btnSaveBottom.disabled = false;
  }
}

function clearSessionModalErrors() {
  const banner = document.getElementById('session-error-banner');
  const errTitle = document.getElementById('error-session-title');
  const errDate = document.getElementById('error-session-date');
  if (banner) {
    banner.textContent = '';
    banner.style.display = 'none';
  }
  if (errTitle) {
    errTitle.textContent = '';
    errTitle.style.display = 'none';
  }
  if (errDate) {
    errDate.textContent = '';
    errDate.style.display = 'none';
  }
}

function updateSessionLiveSummary() {
  const summaryEl = document.getElementById('session-live-summary');
  if (!summaryEl) return;

  const titleVal = document.getElementById('session-title-input')?.value || '';
  const dateVal = document.getElementById('session-date-input')?.value || '';
  const typeVal = document.getElementById('session-type-input')?.value || 'class';

  summaryEl.textContent = buildModalLiveSummary('attendance', {
    title: titleVal,
    session_date: dateVal,
    session_type: typeVal
  });
}

function applyTeacherDateLimits(dateInput) {
  if (!dateInput || currentProfile?.role !== 'teacher') return;
  const todayIst = getISTDateString(new Date());
  dateInput.max = todayIst;
  if (currentProfile.permissions?.can_correct_attendance !== false) {
    const minD = new Date(Date.now() - 7 * 86400000);
    dateInput.min = getISTDateString(minD);
  } else {
    dateInput.min = todayIst;
  }
}

function prepareCreateSessionModal() {
  const modalTitle = document.getElementById('session-modal-title');
  const btnSaveAnother = document.getElementById('btn-save-add-another-session');
  const moreOptions = document.getElementById('session-more-options');
  const dateInput = document.getElementById('session-date-input');

  if (modalTitle) modalTitle.textContent = 'Create Attendance Session';
  if (btnSaveAnother) btnSaveAnother.style.display = 'inline-flex';
  clearSessionModalErrors();

  document.getElementById('session-id-input').value = '';
  if (dateInput) {
    dateInput.value = getISTDateString(new Date());
    applyTeacherDateLimits(dateInput);
  }
  document.getElementById('session-title-input').value = '';
  document.getElementById('session-type-input').value = 'class';
  document.getElementById('session-notes-input').value = '';

  setMoreOptionsOpen(moreOptions, false);
  updateSessionLiveSummary();
}

/**
 * Modal: Create / Edit Session
 */
function setupSessionModalHandlers() {
  const form = document.getElementById('session-form');
  const btnOpenCreate = document.getElementById('btn-create-session');
  const btnOpenEdit = document.getElementById('btn-edit-session');
  const btnSaveAnother = document.getElementById('btn-save-add-another-session');
  const modalTitle = document.getElementById('session-modal-title');
  const moreOptions = document.getElementById('session-more-options');

  ['session-title-input', 'session-date-input', 'session-type-input', 'session-notes-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateSessionLiveSummary);
      el.addEventListener('change', updateSessionLiveSummary);
    }
  });

  // Open Create
  if (btnOpenCreate) {
    btnOpenCreate.onclick = () => {
      prepareCreateSessionModal();
      openModal('session-modal');
    };
  }

  // Open Edit
  if (btnOpenEdit) {
    btnOpenEdit.onclick = () => {
      const session = allSessions.find(s => s.id === selectedSessionId);
      if (!session) return;

      const dateInput = document.getElementById('session-date-input');
      applyTeacherDateLimits(dateInput);

      if (currentProfile?.role === 'teacher' && dateInput?.min && session.session_date < dateInput.min) {
        showToast('error', 'Past attendance sessions beyond 7 days can only be modified by an administrator.');
        return;
      }

      if (modalTitle) modalTitle.textContent = 'Edit Attendance Session';
      if (btnSaveAnother) btnSaveAnother.style.display = 'none';
      clearSessionModalErrors();

      document.getElementById('session-id-input').value = session.id;
      if (dateInput) dateInput.value = session.session_date;
      document.getElementById('session-title-input').value = session.title;
      document.getElementById('session-type-input').value = session.session_type || 'class';
      document.getElementById('session-notes-input').value = session.notes || '';

      setMoreOptionsOpen(moreOptions, shouldOpenMoreOptions([session.notes], true));
      updateSessionLiveSummary();
      openModal('session-modal');
    };
  }

  if (btnSaveAnother && form) {
    btnSaveAnother.addEventListener('click', () => {
      saveAndAddAnotherSessionMode = true;
      form.requestSubmit();
    });
  }

  // Submit form
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const keepOpen = saveAndAddAnotherSessionMode;
      saveAndAddAnotherSessionMode = false;

      clearSessionModalErrors();

      const sessionId = document.getElementById('session-id-input').value;
      const dateVal = document.getElementById('session-date-input').value;
      const titleVal = document.getElementById('session-title-input').value.trim();
      const typeVal = document.getElementById('session-type-input').value;
      const notesVal = document.getElementById('session-notes-input').value.trim();

      const banner = document.getElementById('session-error-banner');
      const errTitle = document.getElementById('error-session-title');
      const errDate = document.getElementById('error-session-date');

      let hasError = false;
      if (!titleVal) {
        if (errTitle) {
          errTitle.textContent = 'Session title is required.';
          errTitle.style.display = 'block';
        }
        hasError = true;
      }
      if (!dateVal) {
        if (errDate) {
          errDate.textContent = 'Session date is required.';
          errDate.style.display = 'block';
        }
        hasError = true;
      }
      if (hasError) {
        if (banner) {
          banner.textContent = 'Please fix the highlighted errors before saving.';
          banner.style.display = 'block';
        }
        return;
      }

      const btnSubmit = document.getElementById('btn-submit-session');
      if (btnSubmit) btnSubmit.disabled = true;
      if (btnSaveAnother) btnSaveAnother.disabled = true;

      try {
        if (sessionId) {
          // UPDATE
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { error } = await supabase
              .from('attendance_sessions')
              .update({
                session_date: dateVal,
                title: titleVal,
                session_type: typeVal,
                notes: notesVal || null
              })
              .eq('id', sessionId);

            if (error) throw new Error(error.message);
          } else {
            DemoDB.updateAttendanceSession(sessionId, {
              session_date: dateVal,
              title: titleVal,
              session_type: typeVal,
              notes: notesVal
            });
          }
          showToast('success', 'Session updated.');
          closeModal('session-modal');
          await loadSessions(sessionId);
        } else {
          // CREATE
          let newId = null;
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { data, error } = await supabase
              .from('attendance_sessions')
              .insert({
                session_date: dateVal,
                title: titleVal,
                session_type: typeVal,
                notes: notesVal || null,
                created_by: currentProfile.id
              })
              .select('id')
              .single();

            if (error) throw new Error(error.message);
            newId = data.id;
          } else {
            const created = DemoDB.createAttendanceSession({
              session_date: dateVal,
              title: titleVal,
              session_type: typeVal,
              notes: notesVal
            }, currentProfile.id);
            newId = created.id;
          }
          showToast('success', 'New attendance session created.');
          await loadSessions(newId);

          if (keepOpen) {
            prepareCreateSessionModal();
            document.getElementById('session-title-input')?.focus();
          } else {
            closeModal('session-modal');
          }
        }
      } catch (err) {
        console.error('Failed to save session:', err);
        if (banner) {
          banner.textContent = err.message || 'Failed to save session.';
          banner.style.display = 'block';
        }
        showToast('error', 'Failed to save session: ' + err.message);
      } finally {
        if (btnSubmit) btnSubmit.disabled = false;
        if (btnSaveAnother) btnSaveAnother.disabled = false;
      }
    };
  }
}

/**
 * Warning modal when unmarked students exist before saving
 */
let warningProceedCallback = null;

function openUnmarkedWarningModal(unmarkedCount, onProceed) {
  const bodyEl = document.getElementById('unmarked-warning-body');
  const btnProceed = document.getElementById('btn-warning-proceed');

  if (bodyEl) {
    bodyEl.textContent = `There ${unmarkedCount === 1 ? 'is 1 active student' : `are ${unmarkedCount} active students`} without an attendance mark.`;
  }

  warningProceedCallback = onProceed;

  if (btnProceed) {
    btnProceed.onclick = async () => {
      const cb = warningProceedCallback;
      closeModal('unmarked-warning-modal');
      warningProceedCallback = null;
      if (cb) await cb();
    };
  }

  openModal('unmarked-warning-modal');
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
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <div class="banner-body">
        <strong>Demo Mode (Local Preview):</strong> Tracking sample attendance sessions. Connect Supabase to persist live attendance records.
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

document.addEventListener('DOMContentLoaded', initAttendancePage);

// Exports for unit/contract tests
function getActiveStudentsList() {
  return activeStudentsList;
}

function getRosterLoadError() {
  return rosterLoadError;
}

function getAllSessions() {
  return allSessions;
}

function setCurrentProfileForTesting(profile) {
  currentProfile = profile;
}

function setSupabaseClientForTesting(client) {
  testSupabaseClient = client;
}

function resetAttendanceStateForTesting() {
  currentProfile = null;
  allSessions = [];
  selectedSessionId = null;
  activeStudentsList = [];
  activeStudentsPromise = null;
  rosterLoadError = null;
  testSupabaseClient = null;
  sessionAttendanceMap.clear();
  rosterSearchQuery = '';
}

export {
  initAttendancePage,
  loadActiveStudents,
  loadSessions,
  selectSession,
  renderSessionsList,
  renderStudentRosterGrid,
  updateRosterCountsUI,
  getActiveStudentsList,
  getRosterLoadError,
  getAllSessions,
  setCurrentProfileForTesting,
  setSupabaseClientForTesting,
  resetAttendanceStateForTesting
};
