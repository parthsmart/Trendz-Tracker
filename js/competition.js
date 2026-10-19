/**
 * Trendz Tracker - Admin Competition Settings Controller (js/competition.js)
 *
 * Manages the four competition settings in `public.competition_settings`:
 * - weekly_test_multiplier (number)
 * - attendance_present_points (number)
 * - improved_min_entries (number)
 * - leaderboard_names ('first_name_initial' | 'student_code')
 *
 * Guard: Admin-only (`requireAuth(['admin'])`).
 * Each setting is saved with an update on `competition_settings` (`.update({ value }).eq('key', key)`).
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { requireAuth } from './guard.js';
import { buildHowItWorksText, fetchCompetitionRules } from './leaderboardData.js';
import { setupAdminNav } from './modal.js';
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';
import { showToast } from './toast.js';

const SETTING_KEYS = [
  'weekly_test_multiplier',
  'attendance_present_points',
  'improved_min_entries',
  'leaderboard_names'
];

const KEY_TO_ELEMENT_IDS = {
  weekly_test_multiplier: {
    input: 'input-weekly-test-multiplier',
    err: 'err-weekly-test-multiplier',
    status: 'status-weekly-test-multiplier',
    label: 'Weekly Test Points Multiplier'
  },
  attendance_present_points: {
    input: 'input-attendance-present-points',
    err: 'err-attendance-present-points',
    status: 'status-attendance-present-points',
    label: 'Session Attendance Points'
  },
  improved_min_entries: {
    input: 'input-improved-min-entries',
    err: 'err-improved-min-entries',
    status: 'status-improved-min-entries',
    label: 'Most Improved Minimum Entries'
  },
  leaderboard_names: {
    input: 'select-leaderboard-names',
    err: 'err-leaderboard-names',
    status: 'status-leaderboard-names',
    label: 'Leaderboard Display Name Format'
  }
};

/**
 * Formats database errors into a clear, friendly message for administrators.
 */
function formatFriendlyDbError(err, settingLabel = 'setting') {
  const raw = err?.message || String(err || 'Database error');
  if (raw.includes('check constraint') || raw.includes('violates check') || raw.includes('invalid')) {
    return `The database rejected the value for ${settingLabel}. Please enter a valid number or option allowed by the competition rules (${raw}).`;
  }
  if (raw.includes('permission denied') || raw.includes('row-level security')) {
    return `Permission denied while updating ${settingLabel}. Only administrators can change competition settings.`;
  }
  return raw;
}

function showTopError(message) {
  const banner = document.getElementById('competition-error-banner');
  const textEl = document.getElementById('competition-error-text');
  if (textEl) textEl.textContent = message;
  if (banner) banner.style.display = 'flex';
}

function hideTopError() {
  const banner = document.getElementById('competition-error-banner');
  if (banner) banner.style.display = 'none';
}

/**
 * Validates a setting value on the client (numbers only where numbers are needed).
 * Returns `{ valid: boolean, value: string, error?: string }`.
 */
function validateSettingInput(key) {
  const meta = KEY_TO_ELEMENT_IDS[key];
  if (!meta) return { valid: false, value: '', error: 'Unknown setting key.' };

  const inputEl = document.getElementById(meta.input);
  const errEl = document.getElementById(meta.err);
  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  const rawVal = String(inputEl?.value ?? '').trim();

  if (key === 'leaderboard_names') {
    if (rawVal !== 'first_name_initial' && rawVal !== 'student_code') {
      const msg = 'Please choose either "First name + last initial" or "Student ID code only".';
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      return { valid: false, value: rawVal, error: msg };
    }
    return { valid: true, value: rawVal };
  }

  // Numeric settings: numbers only
  if (!rawVal || !/^\d+$/.test(rawVal)) {
    const msg = 'Numbers only: please enter a whole non-negative number.';
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
    return { valid: false, value: rawVal, error: msg };
  }

  const num = Number(rawVal);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    const msg = 'Please enter a valid whole number (0 or greater).';
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
    return { valid: false, value: rawVal, error: msg };
  }

  if (key === 'improved_min_entries' && num < 1) {
    const msg = 'Minimum entries per week must be at least 1.';
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
    return { valid: false, value: rawVal, error: msg };
  }

  return { valid: true, value: String(num) };
}

/**
 * Updates the live Sample Student Name preview and "How it works" preview text.
 */
function updateLivePreviews() {
  const nameMode = document.getElementById('select-leaderboard-names')?.value || 'first_name_initial';
  const samplePreviewEl = document.getElementById('sample-student-name-preview');
  if (samplePreviewEl) {
    // Sample student: Aarav Sharma (STU101)
    samplePreviewEl.textContent = nameMode === 'student_code' ? 'STU101' : 'Aarav S.';
  }

  const currentDraftRules = {
    weekly_test_multiplier: Number(document.getElementById('input-weekly-test-multiplier')?.value || 2),
    attendance_present_points: Number(document.getElementById('input-attendance-present-points')?.value || 10),
    improved_min_entries: Number(document.getElementById('input-improved-min-entries')?.value || 5),
    leaderboard_names: nameMode
  };

  const pointsPreviewEl = document.getElementById('preview-rule-points');
  const improvedPreviewEl = document.getElementById('preview-rule-improved');
  if (pointsPreviewEl) {
    pointsPreviewEl.textContent = ' ' + buildHowItWorksText('points', currentDraftRules);
  }
  if (improvedPreviewEl) {
    improvedPreviewEl.textContent = ' ' + buildHowItWorksText('improved', currentDraftRules);
  }
}

/**
 * Loads the current 4 settings from `competition_settings` (or `competition_rules()`).
 */
async function loadCompetitionSettings() {
  const loadingCard = document.getElementById('competition-loading');
  const formEl = document.getElementById('competition-settings-form');
  hideTopError();

  try {
    const map = new Map();

    if (!isSupabaseConfigured()) {
      if (!isDemoAllowedHost()) {
        throw new Error('Configuration error - contact the administrator.');
      }
      const rows = DemoDB.getCompetitionSettings();
      rows.forEach(r => map.set(r.key, r.value));
    } else {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('competition_settings')
        .select('key, value');

      if (error) {
        const msg = error.message || '';
        if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
          clearStaleSupabaseSession();
          window.location.href = '/index.html';
          return;
        }
        // Fallback to competition_rules() RPC if reading table fails
        const rules = await fetchCompetitionRules();
        map.set('weekly_test_multiplier', String(rules.weekly_test_multiplier));
        map.set('attendance_present_points', String(rules.attendance_present_points));
        map.set('improved_min_entries', String(rules.improved_min_entries));
        map.set('leaderboard_names', String(rules.leaderboard_names));
      } else {
        (data || []).forEach(r => map.set(r.key, r.value));
      }
    }

    const multEl = document.getElementById('input-weekly-test-multiplier');
    const attEl = document.getElementById('input-attendance-present-points');
    const impEl = document.getElementById('input-improved-min-entries');
    const nameEl = document.getElementById('select-leaderboard-names');

    if (multEl) multEl.value = map.get('weekly_test_multiplier') ?? '2';
    if (attEl) attEl.value = map.get('attendance_present_points') ?? '10';
    if (impEl) impEl.value = map.get('improved_min_entries') ?? '5';
    if (nameEl) nameEl.value = map.get('leaderboard_names') || 'first_name_initial';

    updateLivePreviews();

    if (loadingCard) loadingCard.style.display = 'none';
    if (formEl) formEl.style.display = 'block';
  } catch (err) {
    console.error('Failed to load competition settings:', err);
    if (loadingCard) loadingCard.style.display = 'none';
    if (formEl) formEl.style.display = 'block';
    showTopError(formatFriendlyDbError(err, 'competition settings'));
  }
}

/**
 * Updates a single setting in `competition_settings` by key.
 * @param {string} key
 * @param {boolean} silentSuccessToast
 */
async function saveSingleSetting(key, silentSuccessToast = false) {
  hideTopError();
  const meta = KEY_TO_ELEMENT_IDS[key];
  if (!meta) return false;

  const check = validateSettingInput(key);
  if (!check.valid) {
    return false;
  }

  const statusEl = document.getElementById(meta.status);
  const saveBtn = document.querySelector(`.btn-save-setting[data-key="${key}"]`);
  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
  }

  try {
    if (!isSupabaseConfigured()) {
      if (!isDemoAllowedHost()) {
        throw new Error('Configuration error - contact the administrator.');
      }
      DemoDB.updateCompetitionSetting(key, check.value);
    } else {
      const supabase = await getSupabase();
      const { error } = await supabase
        .from('competition_settings')
        .update({ value: check.value })
        .eq('key', key);

      if (error) {
        throw new Error(error.message);
      }
    }

    if (statusEl) {
      statusEl.textContent = '✓ Saved';
      statusEl.style.color = 'var(--color-accent-text)';
    }
    if (!silentSuccessToast) {
      showToast('success', `${meta.label} saved.`);
    }
    updateLivePreviews();
    return true;
  } catch (err) {
    const friendly = formatFriendlyDbError(err, meta.label);
    if (statusEl) {
      statusEl.textContent = 'Save failed';
      statusEl.style.color = 'var(--color-danger)';
    }
    const errEl = document.getElementById(meta.err);
    if (errEl) {
      errEl.textContent = friendly;
      errEl.style.display = 'block';
    }
    showTopError(friendly);
    showToast('error', friendly);
    return false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function attachListeners() {
  // Live preview updates as inputs change
  SETTING_KEYS.forEach(key => {
    const meta = KEY_TO_ELEMENT_IDS[key];
    const el = document.getElementById(meta.input);
    if (el) {
      el.addEventListener('input', () => {
        const statusEl = document.getElementById(meta.status);
        if (statusEl) statusEl.textContent = '';
        const errEl = document.getElementById(meta.err);
        if (errEl) errEl.style.display = 'none';
        updateLivePreviews();
      });
      el.addEventListener('change', () => {
        updateLivePreviews();
      });
    }
  });

  // Individual setting save buttons
  document.querySelectorAll('.btn-save-setting').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-key');
      if (key) {
        await saveSingleSetting(key, false);
      }
    });
  });

  // Save All 4 Settings form submit (updates each setting with an update on competition_settings)
  document.getElementById('competition-settings-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const saveAllBtn = document.getElementById('btn-save-all-competition');
    if (saveAllBtn) saveAllBtn.disabled = true;

    let allOk = true;
    for (const key of SETTING_KEYS) {
      const ok = await saveSingleSetting(key, true);
      if (!ok) {
        allOk = false;
      }
    }

    if (saveAllBtn) saveAllBtn.disabled = false;
    if (allOk) {
      showToast('success', 'All 4 competition settings saved.');
    }
  });

  document.getElementById('btn-dismiss-competition-error')?.addEventListener('click', () => {
    hideTopError();
  });
}

async function initCompetitionPage() {
  // Admin-only guard
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupAdminNav();
  attachListeners();
  await loadCompetitionSettings();
}

document.addEventListener('DOMContentLoaded', initCompetitionPage);
