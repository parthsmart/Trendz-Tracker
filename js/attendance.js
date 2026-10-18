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

let currentProfile = null;
let allSessions = [];
let selectedSessionId = null;
let activeStudentsList = [];
let sessionAttendanceMap = new Map(); // studentId -> { status: 'present'|'absent'|'excused'|null, note: string }
let rosterSearchQuery = '';

async function initAttendancePage() {
  currentProfile = await requireAuth(['admin']);
  if (!currentProfile) return;

  renderHeaderUser(currentProfile);

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupSessionModalHandlers();
  setupRosterHandlers();

  // Load initial sessions and active students
  await Promise.all([
    loadActiveStudents(),
    loadSessions()
  ]);
}

/**
 * Loads all active students for attendance marking
 */
async function loadActiveStudents() {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, student_code, level, active')
        .eq('role', 'student')
        .eq('active', true)
        .order('student_code', { ascending: true });

      if (!error && data) {
        activeStudentsList = data;
      }
    } catch (err) {
      console.warn('Failed to load active students:', err);
    }
  } else {
    activeStudentsList = DemoDB.getStudents().filter(s => s.role === 'student' && s.active !== false);
  }
}

/**
 * Loads all sessions and their attendance counts
 */
async function loadSessions(selectIdAfterLoad = null) {
  const container = document.getElementById('sessions-list-container');
  const countLabel = document.getElementById('session-count-label');

  if (container && allSessions.length === 0) {
    container.innerHTML = '<div class="loading-state" style="padding: var(--space-6); text-align: center;">Loading sessions...</div>';
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

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

      const activeCount = activeStudentsList.length;

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

        const unmarked = Math.max(0, activeCount - markedIds.size);

        return {
          ...ses,
          present_count: present,
          absent_count: absent,
          excused_count: excused,
          unmarked_count: unmarked
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
        <div style="color: #DC2626; font-size: var(--text-xs); padding: var(--space-4); text-align: center;">
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
        <div style="font-size: 1.5rem; margin-bottom: 4px;">📅</div>
        <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: 2px;">No Sessions Created</h4>
        <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
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
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
          <strong style="font-size: var(--text-xs); color: var(--text-main); font-weight: 600;">
            ${escapeHtml(ses.title)}
          </strong>
          <span class="status-chip chip-unverified" style="font-size: 10px; text-transform: uppercase;">
            ${escapeHtml(ses.session_type)}
          </span>
        </div>

        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: var(--space-2);">
          📅 ${dateDisplay}
        </div>

        <div style="display: flex; gap: var(--space-2); font-size: 11px; flex-wrap: wrap;">
          <span style="color: #065F46; background: rgba(16, 185, 129, 0.1); padding: 1px 6px; border-radius: 3px;">
            ${ses.present_count} Present
          </span>
          <span style="color: #991B1B; background: rgba(239, 68, 68, 0.1); padding: 1px 6px; border-radius: 3px;">
            ${ses.absent_count} Absent
          </span>
          <span style="color: #4B5563; background: rgba(107, 114, 128, 0.1); padding: 1px 6px; border-radius: 3px;">
            ${ses.excused_count} Excused
          </span>
          ${ses.unmarked_count > 0 ? `
            <span style="color: #DC2626; font-weight: 700;">
              ${ses.unmarked_count} Unmarked
            </span>
          ` : ''}
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

  const pEl = document.getElementById('active-count-present');
  const aEl = document.getElementById('active-count-absent');
  const eEl = document.getElementById('active-count-excused');
  const uEl = document.getElementById('active-count-unmarked');

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
          <h4 style="font-size: var(--text-sm); font-weight: 600; margin-bottom: 2px;">No Students Found</h4>
          <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
            No active students match "${escapeHtml(rosterSearchQuery)}".
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
          <a href="/pages/student-detail.html?id=${encodeURIComponent(student.id)}" class="student-name-link" style="font-size: var(--text-xs);">
            ${escapeHtml(student.full_name)}
          </a>
          <div style="font-size: 11px; color: var(--text-dim);">${escapeHtml(student.student_code)}</div>
        </td>

        <!-- Level -->
        <td>
          <span style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(student.level || '—')}</span>
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
              ✓ Present
            </button>
            <button
              type="button"
              class="btn-status-toggle ${status === 'absent' ? 'active-absent' : ''}"
              data-status="absent"
              data-student-id="${student.id}"
            >
              ✗ Absent
            </button>
            <button
              type="button"
              class="btn-status-toggle ${status === 'excused' ? 'active-excused' : ''}"
              data-status="excused"
              data-student-id="${student.id}"
            >
              Ex Excused
            </button>
          </div>
          ${!status ? `
            <div style="margin-top: 2px;">
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
            style="font-size: 11px; padding: 4px 8px; min-height: 28px;"
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

/**
 * Modal: Create / Edit Session
 */
function setupSessionModalHandlers() {
  const modal = document.getElementById('session-modal');
  const form = document.getElementById('session-form');
  const btnOpenCreate = document.getElementById('btn-create-session');
  const btnOpenEdit = document.getElementById('btn-edit-session');
  const btnClose = document.getElementById('btn-close-session-modal');
  const btnCancel = document.getElementById('btn-cancel-session-modal');
  const modalTitle = document.getElementById('session-modal-title');

  function closeModal() {
    if (modal) modal.style.display = 'none';
  }

  if (btnClose) btnClose.onclick = closeModal;
  if (btnCancel) btnCancel.onclick = closeModal;

  // Open Create
  if (btnOpenCreate) {
    btnOpenCreate.onclick = () => {
      if (modalTitle) modalTitle.textContent = 'Create Attendance Session';
      document.getElementById('session-id-input').value = '';
      document.getElementById('session-date-input').value = getISTDateString(new Date());
      document.getElementById('session-title-input').value = '';
      document.getElementById('session-type-input').value = 'class';
      document.getElementById('session-notes-input').value = '';

      if (modal) modal.style.display = 'flex';
      document.getElementById('session-title-input')?.focus();
    };
  }

  // Open Edit
  if (btnOpenEdit) {
    btnOpenEdit.onclick = () => {
      const session = allSessions.find(s => s.id === selectedSessionId);
      if (!session) return;

      if (modalTitle) modalTitle.textContent = 'Edit Attendance Session';
      document.getElementById('session-id-input').value = session.id;
      document.getElementById('session-date-input').value = session.session_date;
      document.getElementById('session-title-input').value = session.title;
      document.getElementById('session-type-input').value = session.session_type || 'class';
      document.getElementById('session-notes-input').value = session.notes || '';

      if (modal) modal.style.display = 'flex';
      document.getElementById('session-title-input')?.focus();
    };
  }

  // Submit form
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const sessionId = document.getElementById('session-id-input').value;
      const dateVal = document.getElementById('session-date-input').value;
      const titleVal = document.getElementById('session-title-input').value.trim();
      const typeVal = document.getElementById('session-type-input').value;
      const notesVal = document.getElementById('session-notes-input').value.trim();

      const btnSubmit = document.getElementById('btn-submit-session');
      if (btnSubmit) btnSubmit.disabled = true;

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
          closeModal();
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
          closeModal();
          await loadSessions(newId);
        }
      } catch (err) {
        console.error('Failed to save session:', err);
        showToast('error', 'Failed to save session: ' + err.message);
      } finally {
        if (btnSubmit) btnSubmit.disabled = false;
      }
    };
  }
}

/**
 * Warning modal when unmarked students exist before saving
 */
let warningProceedCallback = null;

function openUnmarkedWarningModal(unmarkedCount, onProceed) {
  const modal = document.getElementById('unmarked-warning-modal');
  const bodyEl = document.getElementById('unmarked-warning-body');
  const btnBack = document.getElementById('btn-warning-back');
  const btnClose = document.getElementById('btn-close-warning-modal');
  const btnProceed = document.getElementById('btn-warning-proceed');

  if (bodyEl) {
    bodyEl.textContent = `There ${unmarkedCount === 1 ? 'is 1 active student' : `are ${unmarkedCount} active students`} without an attendance mark.`;
  }

  function closeWarning() {
    if (modal) modal.style.display = 'none';
    warningProceedCallback = null;
  }

  if (btnBack) btnBack.onclick = closeWarning;
  if (btnClose) btnClose.onclick = closeWarning;

  warningProceedCallback = onProceed;

  if (btnProceed) {
    btnProceed.onclick = async () => {
      const cb = warningProceedCallback;
      closeWarning();
      if (cb) await cb();
    };
  }

  if (modal) modal.style.display = 'flex';
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const btnLogout = document.getElementById('btn-header-logout');

  if (container) container.style.display = 'inline-flex';
  if (nameEl) nameEl.textContent = profile.full_name || profile.name || 'Admin';
  if (roleEl) roleEl.textContent = 'Teacher';

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          await supabase.auth.signOut();
        }
      } catch (e) {
        console.warn('Sign out error:', e);
      }
      window.location.href = '/index.html';
    });
  }
}

function renderDemoBanner() {
  const bannerPlaceholder = document.getElementById('demo-banner-placeholder');
  if (!bannerPlaceholder) return;
  bannerPlaceholder.innerHTML = `
    <div style="background-color: #FEF3C7; border: 1px solid #F59E0B; color: #92400E; padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-xs); margin-bottom: var(--space-4); display: flex; align-items: center; justify-content: space-between;">
      <div>
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
