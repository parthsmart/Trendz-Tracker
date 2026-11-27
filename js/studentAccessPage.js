/**
 * Trendz Tracker — Student Practice Access Page Controller (js/studentAccessPage.js)
 *
 * Powers /pages/student-access.html:
 * - Admin: Selects curriculum level and saves institute-wide level defaults.
 * - Teacher: Selects level, inspects assigned student count, and performs bulk action
 *   "Apply to my students in this level".
 */

import { requireAuth } from './guard.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { showToast } from './toast.js';
import { setupAdminNav, setupModalListeners, openModal, closeModal } from './modal.js';
import { STUDENT_LEVELS } from '../shared/levels.js';
import {
  PRESET_FULL_ACCESS,
  fetchLevelAccessDefaults,
  saveLevelAccessDefaults,
  getTeacherLevelStudentCount,
  teacherBulkApplyLevelAccess,
  renderAccessEditorHtml,
  extractAccessSettingsFromEditor,
  wireAccessEditorEvents,
} from './studentAccess.js';

let currentUser = null;
let currentLevel = 'Level 1';
let currentSettings = null;
let basicsCategories = [];
let assignedCount = 0;

async function loadBasicsCategories(supabase, isDemo) {
  if (isDemo || !supabase) {
    if (DemoDB && typeof DemoDB.getCategories === 'function') {
      return DemoDB.getCategories().filter((c) => c.section === 'basics' && c.active);
    }
    return [
      { id: 'cat-bas-1', name: '1d4r', section: 'basics' },
      { id: 'cat-bas-2', name: '2d2r', section: 'basics' },
      { id: 'cat-bas-3', name: '2d4r', section: 'basics' },
    ];
  }

  const { data } = await supabase
    .from('categories')
    .select('id, name, section, sort_order, active')
    .eq('section', 'basics')
    .eq('active', true)
    .order('sort_order', { ascending: true });

  return data || [];
}

async function loadStudentLevels() {
  // Rules are set per standard level, in the fixed order.
  return [...STUDENT_LEVELS];
}

async function refreshLevelData() {
  const mountEl = document.getElementById('access-editor-mount');
  const badgeEl = document.getElementById('level-rule-badge');
  const countBadge = document.getElementById('teacher-bulk-info-badge');
  const countText = document.getElementById('teacher-student-count-text');
  const isDemo = isDemoMode();
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  if (mountEl) {
    mountEl.innerHTML = `
      <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-muted);">
        <span class="spinner" style="margin-right: 8px;"></span> Loading practice access for ${currentLevel}...
      </div>
    `;
  }

  const [defaultsRes, countRes] = await Promise.all([
    fetchLevelAccessDefaults(currentLevel, { supabase, isDemo, DemoDB }),
    getTeacherLevelStudentCount(currentLevel, { supabase, isDemo, DemoDB, currentProfile: currentUser }),
  ]);

  currentSettings = defaultsRes.ok ? defaultsRes.settings : PRESET_FULL_ACCESS;
  assignedCount = countRes.ok ? countRes.count : 0;

  if (badgeEl) {
    if (defaultsRes.has_rule) {
      badgeEl.className = 'badge badge-primary';
      badgeEl.textContent = 'Custom level rule';
    } else {
      badgeEl.className = 'badge badge-neutral';
      badgeEl.textContent = 'Default (Full access)';
    }
  }

  const isTeacher = currentUser?.role === 'teacher';
  if (countBadge && countText) {
    countText.textContent = `${assignedCount} active ${isTeacher ? 'assigned ' : ''}students in ${currentLevel}`;
    countBadge.style.display = 'inline-block';
  }

  if (mountEl) {
    mountEl.innerHTML = renderAccessEditorHtml({
      settings: currentSettings,
      basicsCategories,
      isTeacher,
      isEligibleForMainRound: true,
      canToggleEligibility: currentUser?.role === 'admin',
    });

    wireAccessEditorEvents(mountEl, (updated) => {
      currentSettings = updated;
    });
  }
}

async function initStudentAccessPage() {
  const profile = await requireAuth(['admin', 'teacher']);
  if (!profile) return;
  currentUser = profile;

  // Render header user pill
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || (profile.role === 'admin' ? 'Admin' : 'Teacher');
  if (roleEl) roleEl.textContent = profile.student_code || (profile.role === 'admin' ? 'Admin' : 'Teacher');
  if (pillContainer) pillContainer.style.display = 'flex';

  if (isDemoMode()) {
    const placeholder = document.getElementById('config-banner-placeholder');
    if (placeholder) {
      placeholder.innerHTML = `
        <div class="banner banner-warning" role="alert" style="margin-bottom: var(--space-4);">
          <div><strong>Demo mode:</strong> Exploring Student Access in local preview mode.</div>
        </div>
      `;
    }
  }

  setupModalListeners();
  setupAdminNav(profile);

  const isDemo = isDemoMode();
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  // Load basics categories and student levels
  const [cats, levels] = await Promise.all([
    loadBasicsCategories(supabase, isDemo),
    loadStudentLevels(),
  ]);
  basicsCategories = cats;

  // Populate level select
  const selectLevel = document.getElementById('select-access-level');
  if (selectLevel) {
    selectLevel.innerHTML = levels
      .map((lvl) => `<option value="${lvl}" ${lvl === currentLevel ? 'selected' : ''}>${lvl}</option>`)
      .join('');
    selectLevel.addEventListener('change', (e) => {
      currentLevel = e.target.value;
      refreshLevelData();
    });
  }

  // Configure action buttons according to role
  const btnSaveLevel = document.getElementById('btn-save-level-defaults');
  const btnBulkApply = document.getElementById('btn-teacher-bulk-apply');
  const statusText = document.getElementById('action-status-text');

  if (profile.role === 'admin') {
    if (btnSaveLevel) btnSaveLevel.style.display = 'inline-flex';
    if (btnBulkApply) {
      btnBulkApply.style.display = 'inline-flex';
      btnBulkApply.textContent = 'Apply to all students in this level';
    }
    if (statusText) statusText.textContent = 'Admins manage institute-wide defaults and bulk applications.';
  } else if (profile.role === 'teacher') {
    if (btnBulkApply) {
      btnBulkApply.style.display = 'inline-flex';
      btnBulkApply.textContent = 'Apply to my students in this level';
    }
    if (statusText) statusText.textContent = 'Teachers can bulk-apply access to assigned students in this level.';
  }

  // Wire Admin Save Level Defaults
  btnSaveLevel?.addEventListener('click', async () => {
    btnSaveLevel.disabled = true;
    btnSaveLevel.textContent = 'Saving...';
    try {
      const mountEl = document.getElementById('access-editor-mount');
      const settingsToSave = extractAccessSettingsFromEditor(mountEl);
      const res = await saveLevelAccessDefaults(currentLevel, settingsToSave, { supabase, isDemo, DemoDB });
      if (!res.ok) throw new Error(res.error || 'Failed to save level defaults');
      showToast('success', `Level defaults for ${currentLevel} saved successfully.`);
      await refreshLevelData();
    } catch (err) {
      showToast('error', err.message || 'Error saving level defaults');
    } finally {
      btnSaveLevel.disabled = false;
      btnSaveLevel.textContent = 'Save Level Defaults';
    }
  });

  // Wire Teacher Bulk Apply modal
  btnBulkApply?.addEventListener('click', () => {
    const modal = document.getElementById('modal-bulk-confirm');
    const descEl = document.getElementById('bulk-confirm-desc');
    const countEl = document.getElementById('bulk-affected-count');
    if (descEl) {
      descEl.textContent = profile.role === 'admin'
        ? `Apply these practice settings to all active students in ${currentLevel}?`
        : `Apply these practice settings to students assigned to you in ${currentLevel}?`;
    }
    if (countEl) countEl.textContent = String(assignedCount);
    openModal('modal-bulk-confirm');
  });

  document.getElementById('btn-close-bulk-modal')?.addEventListener('click', () => {
    closeModal('modal-bulk-confirm');
  });
  document.getElementById('btn-cancel-bulk-apply')?.addEventListener('click', () => {
    closeModal('modal-bulk-confirm');
  });

  document.getElementById('btn-confirm-bulk-apply')?.addEventListener('click', async () => {
    const btnConfirm = document.getElementById('btn-confirm-bulk-apply');
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Applying...';
    try {
      const mountEl = document.getElementById('access-editor-mount');
      const settingsToSave = extractAccessSettingsFromEditor(mountEl);
      const res = await teacherBulkApplyLevelAccess(currentLevel, settingsToSave, {
        supabase,
        isDemo,
        DemoDB,
        currentProfile: currentUser,
      });
      if (!res.ok) throw new Error(res.error || 'Failed to apply bulk access');
      closeModal('modal-bulk-confirm');
      showToast('success', `Practice settings applied to ${res.count || assignedCount} students in ${currentLevel}.`);
      await refreshLevelData();
    } catch (err) {
      showToast('error', err.message || 'Error applying bulk access');
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Apply Access Settings';
    }
  });

  // Initial load
  await refreshLevelData();
}

initStudentAccessPage().catch((err) => {
  console.error('[studentAccessPage] Initialization error:', err);
});
