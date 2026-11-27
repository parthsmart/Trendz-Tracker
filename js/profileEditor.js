/**
 * Trendz Tracker - Shared Admin Profile Editor & Change History Drawer (js/profileEditor.js)
 *
 * Intent:
 * Provides the "Edit Profile" modal and "Change history" drawer used on both
 * the Admin Students Roster (/pages/students.html) and the Admin Student Detail
 * page (/pages/student-detail.html).
 *
 * Rules enforced:
 * - Student ID is read-only with tooltip "The student ID is the login name and cannot be changed here".
 * - Role is never shown.
 * - Full name is trimmed (2 to 60 characters).
 * - Level is a dropdown of STUDENT_LEVELS (shared/levels.js) plus "No level".
 * - Above the level field shows:
 *   "Changing the level moves this student to another leaderboard group and changes which targets and tasks apply."
 * - Saves with a single update on `profiles` containing ONLY the changed fields.
 * - Shows database/trigger messages in a friendly banner while keeping the modal open on error.
 * - Prevents double clicks during save.
 * - "Change history" drawer reads `profile_audit` for that student (newest first):
 *   date in India time, admin name (from profiles), and each changed field as old value to new value.
 */

import { isSupabaseConfigured } from './config.js';
import { closeModal, openModal } from './modal.js';
import {
  diffProfileFields,
  formatProfileAuditChanges,
  normalizeProfileInput
} from './profileForm.js';
import { levelOptionsHtml, normalizeLevel } from '../shared/levels.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';
import { clearProfileCache } from './profileCache.js';

let currentEditingStudent = null;
let editorCallbacks = {
  getExistingLevels: () => [],
  onProfileSaved: async () => {}
};
let isSavingProfile = false;

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
 * Formats an ISO timestamp in India Standard Time (Asia/Kolkata)
 */
export function formatAuditTimestampIST(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    return `${formatter.format(d)} IST`;
  } catch {
    return String(isoStr);
  }
}

/**
 * Formats database or trigger errors into a friendly presentation while preserving the exact message.
 */
function formatDatabaseProfileError(err) {
  const rawMessage = String(err?.message || err || 'Unable to save profile changes.').trim();
  const details = [err?.details, err?.hint].filter(Boolean).join(' — ');
  return {
    message: rawMessage,
    details
  };
}

/**
 * Ensures the Edit Profile modal and Change History drawer DOM exist in the document body.
 */
function ensureProfileEditorDom() {
  if (!document.getElementById('edit-profile-modal')) {
    const modalWrapper = document.createElement('div');
    modalWrapper.innerHTML = `
      <!-- Edit Student Profile Modal -->
      <div id="edit-profile-modal" class="modal-backdrop" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="edit-profile-modal-title">
        <div class="modal-dialog" style="max-width: 520px;">
          <header class="modal-header">
            <div>
              <h2 id="edit-profile-modal-title" class="modal-title">Edit Student Profile</h2>
              <p class="modal-subtitle">Update student name, curriculum level, and visibility.</p>
            </div>
            <button type="button" class="modal-close" data-close-modal="edit-profile-modal" aria-label="Close modal">&times;</button>
          </header>
          <form id="edit-profile-form" novalidate>
            <div class="modal-body">
              <!-- Top Error Summary Banner -->
              <div id="edit-profile-error-banner" class="banner banner-error" style="display: none; margin-bottom: var(--space-4);" role="alert"></div>

              <div class="form-row-2">
                <!-- Student ID (Read-Only with required tooltip) -->
                <div class="form-group">
                  <label for="edit-profile-student-code" class="form-label">
                    Student ID
                    <span
                      class="info-tooltip-btn"
                      title="The student ID is the login name and cannot be changed here"
                      aria-label="The student ID is the login name and cannot be changed here"
                    >i</span>
                  </label>
                  <input
                    type="text"
                    id="edit-profile-student-code"
                    class="form-input num"
                    readonly
                    disabled
                    title="The student ID is the login name and cannot be changed here"
                    style="background-color: var(--bg-surface-subtle); color: var(--text-muted); cursor: not-allowed;"
                  />
                </div>

                <!-- Full Name (2 to 60 characters) -->
                <div class="form-group">
                  <label for="edit-profile-full-name" class="form-label">Full name *</label>
                  <input
                    type="text"
                    id="edit-profile-full-name"
                    class="form-input"
                    placeholder="2 to 60 characters"
                    maxlength="60"
                    required
                  />
                  <div id="edit-profile-name-error" class="form-error" style="display: none;"></div>
                </div>
              </div>

              <!-- Collapsible More Options -->
              <details id="edit-profile-more-options" class="form-more-options">
                <summary>More options</summary>
                <div class="form-more-options-body">
                  <!-- Level (optional; one of STUDENT_LEVELS from shared/levels.js) -->
                  <div class="form-group">
                    <label for="edit-profile-level" class="form-label">Level (optional)</label>
                    <div
                      id="edit-profile-level-note"
                      class="form-hint"
                      style="margin-top: 0; margin-bottom: var(--space-2);"
                    >
                      Changing the level moves this student to another leaderboard group and changes which targets and tasks apply.
                    </div>
                    <select id="edit-profile-level" class="form-select">
                      ${levelOptionsHtml({ blankLabel: 'No level' })}
                    </select>

                    <div id="edit-profile-level-error" class="form-error" style="display: none;"></div>
                  </div>

                  <!-- Toggles: Show on leaderboards & Active -->
                  <div class="form-group" style="display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: 0;">
                    <label style="display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-sm); font-weight: 500; color: var(--text-main);">
                      <input
                        type="checkbox"
                        id="edit-profile-leaderboard-visible"
                        style="width: 16px; height: 16px; accent-color: var(--color-primary); cursor: pointer;"
                      />
                      <span>Show on leaderboards</span>
                    </label>

                    <label style="display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-sm); font-weight: 500; color: var(--text-main);">
                      <input
                        type="checkbox"
                        id="edit-profile-active"
                        style="width: 16px; height: 16px; accent-color: var(--color-primary); cursor: pointer;"
                      />
                      <span>Active</span>
                    </label>
                  </div>
                </div>
              </details>

              <!-- Live Summary Sentence -->
              <div id="edit-profile-live-summary" class="form-live-summary" aria-live="polite">
                Student: Unnamed, all levels, active, shown on leaderboards
              </div>
            </div>
            <footer class="modal-footer">
              <button type="button" class="btn btn-ghost" id="btn-cancel-edit-profile" data-close-modal="edit-profile-modal">Cancel</button>
              <button type="submit" id="btn-submit-edit-profile" class="btn btn-primary">
                <span id="btn-edit-profile-text">Save</span>
              </button>
            </footer>
          </form>
        </div>
      </div>

      <!-- Change History Drawer -->
      <div id="profile-audit-overlay" class="audit-drawer-overlay" style="display: none;" aria-hidden="true"></div>
      <aside id="profile-audit-drawer" class="audit-drawer" style="display: none;" aria-hidden="true" aria-labelledby="profile-audit-title">
        <header class="audit-drawer-header">
          <div>
            <h2 id="profile-audit-title" style="font-size: var(--text-base); font-weight: 700; margin: 0;">Change History</h2>
            <p id="profile-audit-subtitle" style="font-size: var(--text-xs); color: var(--text-muted); margin: 2px 0 0 0;">Profile audit log</p>
          </div>
          <button type="button" id="btn-close-profile-audit" class="modal-close" aria-label="Close change history">&times;</button>
        </header>
        <div class="audit-drawer-body" id="profile-audit-body">
          <div class="loading-state">Loading change history...</div>
        </div>
      </aside>
    `;
    document.body.appendChild(modalWrapper);

    // Close modal listeners for dynamically injected modal
    const modalEl = document.getElementById('edit-profile-modal');
    modalEl?.querySelectorAll('[data-close-modal="edit-profile-modal"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!isSavingProfile) closeModal('edit-profile-modal');
      });
    });
    modalEl?.addEventListener('click', e => {
      if (e.target === modalEl && !isSavingProfile) {
        closeModal('edit-profile-modal');
      }
    });

    // Level select listener
    const levelInput = document.getElementById('edit-profile-level');
    levelInput?.addEventListener('change', () => {
      updateEditProfileLiveSummary();
      const levelErr = document.getElementById('edit-profile-level-error');
      if (levelErr) levelErr.style.display = 'none';
    });

    const nameInput = document.getElementById('edit-profile-full-name');
    nameInput?.addEventListener('input', () => {
      updateEditProfileLiveSummary();
      const nameErr = document.getElementById('edit-profile-name-error');
      if (nameErr) nameErr.style.display = 'none';
    });

    document.getElementById('edit-profile-leaderboard-visible')?.addEventListener('change', updateEditProfileLiveSummary);
    document.getElementById('edit-profile-active')?.addEventListener('change', updateEditProfileLiveSummary);

    // Submit form handler
    document.getElementById('edit-profile-form')?.addEventListener('submit', handleSaveProfileSubmit);

    // Drawer close listeners
    document.getElementById('btn-close-profile-audit')?.addEventListener('click', closeProfileAuditDrawer);
    document.getElementById('profile-audit-overlay')?.addEventListener('click', closeProfileAuditDrawer);
  }
}

/**
 * Initialize the shared Profile Editor with callbacks for retrieving levels and refreshing the page after save.
 */
export function initProfileEditor({ getExistingLevels, onProfileSaved } = {}) {
  ensureProfileEditorDom();
  if (typeof getExistingLevels === 'function') {
    editorCallbacks.getExistingLevels = getExistingLevels;
  }
  if (typeof onProfileSaved === 'function') {
    editorCallbacks.onProfileSaved = onProfileSaved;
  }
}

/**
 * Opens the Edit Profile modal prefilled with the given student's current profile.
 */
export async function openEditProfileModal(student) {
  if (!student) return;
  ensureProfileEditorDom();
  currentEditingStudent = { ...student };

  const codeInput = document.getElementById('edit-profile-student-code');
  const nameInput = document.getElementById('edit-profile-full-name');
  const levelInput = document.getElementById('edit-profile-level');
  const lbCheckbox = document.getElementById('edit-profile-leaderboard-visible');
  const activeCheckbox = document.getElementById('edit-profile-active');

  const nameErr = document.getElementById('edit-profile-name-error');
  const levelErr = document.getElementById('edit-profile-level-error');
  const bannerErr = document.getElementById('edit-profile-error-banner');

  if (nameErr) nameErr.style.display = 'none';
  if (levelErr) levelErr.style.display = 'none';
  if (bannerErr) bannerErr.style.display = 'none';

  if (codeInput) codeInput.value = student.student_code || student.id || '';
  if (nameInput) nameInput.value = student.full_name || '';
  if (levelInput) {
    // A legacy value that is no longer a level shows as 'No level' until the admin picks one.
    levelInput.value = normalizeLevel(student.level) || '';
  }
  if (lbCheckbox) lbCheckbox.checked = student.leaderboard_visible !== false;
  if (activeCheckbox) activeCheckbox.checked = student.active !== false;

  const moreDetails = document.getElementById('edit-profile-more-options');
  const hasNonDefaultVisibility = student.leaderboard_visible === false ? 'hidden' : '';
  const hasNonDefaultActive = student.active === false ? 'inactive' : '';
  setMoreOptionsOpen(
    moreDetails,
    shouldOpenMoreOptions([student.level, hasNonDefaultVisibility, hasNonDefaultActive], true)
  );

  updateEditProfileLiveSummary();

  openModal('edit-profile-modal');
}

function updateEditProfileLiveSummary() {
  const summaryEl = document.getElementById('edit-profile-live-summary');
  if (!summaryEl) return;
  const codeInput = document.getElementById('edit-profile-student-code');
  const nameInput = document.getElementById('edit-profile-full-name');
  const levelInput = document.getElementById('edit-profile-level');
  const lbCheckbox = document.getElementById('edit-profile-leaderboard-visible');
  const activeCheckbox = document.getElementById('edit-profile-active');

  summaryEl.textContent = buildModalLiveSummary('profile', {
    student_code: codeInput?.value || '',
    full_name: nameInput?.value || '',
    level: levelInput?.value || '',
    leaderboard_visible: Boolean(lbCheckbox?.checked),
    active: Boolean(activeCheckbox?.checked),
  });
}

/**
 * Validates and saves the edited profile with a single `.update(changedFields)` call on `profiles`.
 */
async function handleSaveProfileSubmit(e) {
  e.preventDefault();
  if (isSavingProfile || !currentEditingStudent) return;

  const nameInput = document.getElementById('edit-profile-full-name');
  const levelInput = document.getElementById('edit-profile-level');
  const lbCheckbox = document.getElementById('edit-profile-leaderboard-visible');
  const activeCheckbox = document.getElementById('edit-profile-active');

  const nameErr = document.getElementById('edit-profile-name-error');
  const levelErr = document.getElementById('edit-profile-level-error');
  const bannerErr = document.getElementById('edit-profile-error-banner');
  const submitBtn = document.getElementById('btn-submit-edit-profile');
  const cancelBtn = document.getElementById('btn-cancel-edit-profile');
  const btnText = document.getElementById('btn-edit-profile-text');

  if (nameErr) nameErr.style.display = 'none';
  if (levelErr) levelErr.style.display = 'none';
  if (bannerErr) bannerErr.style.display = 'none';

  const normalized = normalizeProfileInput({
    full_name: nameInput?.value ?? '',
    level: levelInput?.value ?? '',
    leaderboard_visible: Boolean(lbCheckbox?.checked),
    active: Boolean(activeCheckbox?.checked)
  });

  if (normalized.errors) {
    if (normalized.errors.full_name && nameErr) {
      nameErr.textContent = normalized.errors.full_name;
      nameErr.style.display = 'block';
    }
    if (normalized.errors.level && levelErr) {
      levelErr.textContent = normalized.errors.level;
      levelErr.style.display = 'block';
      const moreDetails = document.getElementById('edit-profile-more-options');
      setMoreOptionsOpen(moreDetails, true);
    }
    if (bannerErr) {
      bannerErr.textContent = Object.values(normalized.errors).join(' ');
      bannerErr.style.display = 'flex';
    }
    return;
  }

  const changedFields = diffProfileFields(currentEditingStudent, normalized.value);

  if (Object.keys(changedFields).length === 0) {
    showToast('info', 'No changes to save.');
    closeModal('edit-profile-modal');
    return;
  }

  isSavingProfile = true;
  if (submitBtn) submitBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (btnText) btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

  try {
    let updatedProfile = { ...currentEditingStudent, ...changedFields };

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profiles')
        .update(changedFields)
        .eq('id', currentEditingStudent.id)
        .select('*')
        .single();

      if (error) {
        throw error;
      }
      if (data) {
        updatedProfile = data;
      }
    } else {
      const demoAuth = DemoDB.getDemoAuth();
      updatedProfile = DemoDB.updateStudentProfile(
        currentEditingStudent.id,
        changedFields,
        demoAuth?.id || 'usr-admin-1'
      );
    }

    currentEditingStudent = updatedProfile;
    clearProfileCache();
    isSavingProfile = false;
    closeModal('edit-profile-modal');
    showToast('success', `Saved profile changes for ${updatedProfile.full_name}.`);
    await editorCallbacks.onProfileSaved(updatedProfile);
  } catch (err) {
    console.error('Error updating student profile:', err);
    const formatted = formatDatabaseProfileError(err);
    if (bannerErr) {
      bannerErr.innerHTML = `
        <div class="banner-body">
          <strong>Could not save profile changes:</strong> ${escapeHtml(formatted.message)}
          ${formatted.details ? `<div style="font-size: 11px; margin-top: 4px; opacity: 0.9;">${escapeHtml(formatted.details)}</div>` : ''}
        </div>
      `;
      bannerErr.style.display = 'flex';
    }
    showToast('error', formatted.message);
  } finally {
    isSavingProfile = false;
    if (submitBtn) submitBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    if (btnText) btnText.textContent = 'Save';
  }
}

/**
 * Opens the Change History drawer and loads `profile_audit` rows for the given student (newest first).
 */
export async function openProfileAuditDrawer(student) {
  if (!student) return;
  ensureProfileEditorDom();

  const overlay = document.getElementById('profile-audit-overlay');
  const drawer = document.getElementById('profile-audit-drawer');
  const subtitle = document.getElementById('profile-audit-subtitle');
  const body = document.getElementById('profile-audit-body');

  if (subtitle) {
    subtitle.textContent = `${student.full_name || 'Student'} (${student.student_code || student.id})`;
  }
  if (body) {
    body.innerHTML = '<div class="loading-state">Loading change history...</div>';
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
  }
  if (drawer) {
    drawer.style.display = 'flex';
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  try {
    let auditRows = [];
    const adminNameMap = new Map();

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profile_audit')
        .select('id, profile_id, changed_by, changed_at, old_values, new_values')
        .eq('profile_id', student.id)
        .order('changed_at', { ascending: false });

      if (error) throw error;
      auditRows = data || [];

      const adminIds = Array.from(
        new Set(auditRows.map(r => r.changed_by).filter(Boolean))
      );

      if (adminIds.length > 0) {
        const { data: adminProfiles } = await supabase
          .from('profiles')
          .select('id, full_name, student_code')
          .in('id', adminIds);

        (adminProfiles || []).forEach(p => {
          adminNameMap.set(p.id, p.full_name || p.student_code || 'Admin');
        });
      }
    } else {
      auditRows = DemoDB.getProfileAudit(student.id);
      const demoAuth = DemoDB.getDemoAuth();
      if (demoAuth?.id) {
        adminNameMap.set(demoAuth.id, demoAuth.full_name || 'Teacher Admin');
      }
      adminNameMap.set('usr-admin-1', 'Coach Sharma (Admin)');
    }

    if (!body) return;

    if (auditRows.length === 0) {
      body.innerHTML = `
        <div class="empty-state" style="padding: var(--space-8) var(--space-4); text-align: center;">
          <div class="empty-state-icon" style="font-size: 2rem; margin-bottom: var(--space-2);">🕓</div>
          <h3 class="empty-state-title" style="font-size: var(--text-sm);">No profile changes recorded yet</h3>
          <p class="empty-state-desc" style="font-size: var(--text-xs);">
            When an admin edits this student's name, level, leaderboard visibility, or active status, each change will appear here.
          </p>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="audit-timeline">
        ${auditRows.map(row => {
          const adminName = (row.changed_by && adminNameMap.get(row.changed_by)) || 'Admin';
          const changes = formatProfileAuditChanges(row.old_values, row.new_values);
          return `
            <div class="audit-item">
              <div class="audit-item-meta">
                <span><strong>${escapeHtml(adminName)}</strong></span>
                <span class="num">${escapeHtml(formatAuditTimestampIST(row.changed_at))}</span>
              </div>
              <div class="audit-item-title">Updated student profile</div>
              ${changes.length > 0 ? `
                <table class="audit-diff-table" aria-label="Changed profile fields">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Old Value</th>
                      <th>New Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${changes.map(c => `
                      <tr>
                        <td><strong>${escapeHtml(c.label)}</strong></td>
                        <td class="audit-val-old">${escapeHtml(c.oldDisplay)}</td>
                        <td class="audit-val-new">${escapeHtml(c.newDisplay)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              ` : `
                <div style="font-size: var(--text-xs); color: var(--text-muted);">No field diff recorded.</div>
              `}
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    console.error('Error loading profile_audit:', err);
    if (body) {
      body.innerHTML = `
        <div class="banner banner-error">
          <div class="banner-body">
            <strong>Failed to load change history:</strong> ${escapeHtml(err.message || String(err))}
          </div>
        </div>
      `;
    }
  }
}

export function closeProfileAuditDrawer() {
  const overlay = document.getElementById('profile-audit-overlay');
  const drawer = document.getElementById('profile-audit-drawer');
  if (overlay) {
    overlay.classList.remove('is-open');
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
  }
  if (drawer) {
    drawer.classList.remove('is-open');
    drawer.style.display = 'none';
    drawer.setAttribute('aria-hidden', 'true');
  }
}
