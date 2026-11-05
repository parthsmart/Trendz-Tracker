/**
 * Trendz Tracker - Admin Announcements & Upcoming Tests Share Controller (js/announcements.js)
 *
 * Phase 13b:
 * - Protected by `requireAuth(['admin'])`.
 * - Compose announcement:
 *   - Title (1 to 80 chars)
 *   - Message (1 to 500 chars, with live character counter)
 *   - Audience ("Everyone" or a specific level, with suggestions from existing levels)
 *   - "Show from" (default now in India time) and "Hide after" (optional date & time in India time)
 *   - Live preview card "What students see"
 *   - Inserts into `announcements` with `created_by = currentProfile.id`.
 * - List of announcements (newest first) with audience, dates, status chip ("Active", "Scheduled", "Expired"),
 *   and Delete button with confirmation modal.
 * - "Upcoming tests" panel: weekly tests in the next 14 days (title, type chip, date, level,
 *   reminder days, number of sections) with "Share on WhatsApp" (`https://wa.me/?text=<encoded>`)
 *   and "Copy text" buttons built by `buildWeeklyTestShareMessage` in `js/reportMessage.js`.
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { showToast } from './toast.js';
import { formatEventDateChipIST } from './notificationsView.js';
import { buildWeeklyTestShareMessage } from './reportMessage.js';
import { formatDisplayDateIST } from './stats.js';
import { buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let currentProfile = null;
let announcements = [];
let upcomingTests = [];
let studentLevels = [];
let isSavingAnnouncement = false;
let pendingDeleteAnnouncementId = null;
let submitAndAddAnotherAnn = false;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a Date or ISO timestamp into `YYYY-MM-DDTHH:mm` in India Standard Time (`Asia/Kolkata`)
 * for `<input type="datetime-local">`.
 */
function toIstDatetimeLocalValue(dateVal = new Date()) {
  try {
    const dt = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (Number.isNaN(dt.getTime())) return '';
    // Shift by +05:30 (330 minutes) from UTC
    const istMs = dt.getTime() + 5.5 * 3600 * 1000;
    return new Date(istMs).toISOString().slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * Converts a `YYYY-MM-DDTHH:mm` string from `<input type="datetime-local">` (interpreted as India time +05:30)
 * into a standard ISO string (`YYYY-MM-DDTHH:mm:00+05:30` -> UTC ISO).
 */
function parseIstDatetimeLocalToIso(localVal) {
  if (!localVal || typeof localVal !== 'string') return null;
  const trimmed = localVal.trim();
  if (!trimmed) return null;
  const withOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed}:00+05:30`
    : trimmed;
  const dt = new Date(withOffset);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

/**
 * Formats an ISO timestamp for readable display in India time (e.g. "30 Oct 2026, 10:30 AM IST").
 */
function formatIstDateTimeReadable(isoVal) {
  if (!isoVal) return '—';
  try {
    const dt = new Date(isoVal);
    if (Number.isNaN(dt.getTime())) return String(isoVal);
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .format(dt)
      .replace(/\bam\b/i, 'AM')
      .replace(/\bpm\b/i, 'PM');
  } catch {
    return String(isoVal);
  }
}

/**
 * Returns today's `YYYY-MM-DD` and the date `daysAhead` in India time.
 */
function getIstDateWindow(daysAhead = 14) {
  const todayIst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const [y, m, d] = todayIst.split('-').map(Number);
  const endUtc = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const endIst = endUtc.toISOString().slice(0, 10);
  return { todayIst, endIst };
}

/**
 * Computes the status chip text ("Active", "Scheduled", or "Expired") for an announcement.
 */
export function getAnnouncementStatus(ann, nowMs = Date.now()) {
  const startsMs = ann?.starts_at ? new Date(ann.starts_at).getTime() : 0;
  const expiresMs = ann?.expires_at ? new Date(ann.expires_at).getTime() : null;

  if (expiresMs !== null && Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return 'Expired';
  }
  if (Number.isFinite(startsMs) && startsMs > nowMs) {
    return 'Scheduled';
  }
  return 'Active';
}

async function initAnnouncementsPage() {
  currentProfile = await requireAuth(['admin']);
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupAdminNav(currentProfile);
  setupModalListeners();

  resetComposeForm();
  setupComposeFormListeners();
  setupDeleteConfirmationModal();

  await Promise.all([
    loadStudentLevels(),
    loadAnnouncements(),
    loadUpcomingTests14Days(),
  ]);
}

function resetComposeForm() {
  const titleInput = document.getElementById('ann-title-input');
  const bodyInput = document.getElementById('ann-body-input');
  const everyoneRadio = document.getElementById('ann-audience-everyone');
  const levelWrapper = document.getElementById('ann-level-input-wrapper');
  const levelInput = document.getElementById('ann-level-input');
  const startsInput = document.getElementById('ann-starts-at-input');
  const expiresInput = document.getElementById('ann-expires-at-input');

  if (titleInput) titleInput.value = '';
  if (bodyInput) bodyInput.value = '';
  if (everyoneRadio) everyoneRadio.checked = true;
  if (levelWrapper) levelWrapper.style.display = 'none';
  if (levelInput) levelInput.value = '';
  if (startsInput) startsInput.value = toIstDatetimeLocalValue(new Date());
  if (expiresInput) expiresInput.value = '';

  setMoreOptionsOpen(document.getElementById('announcement-more-options'), false);
  showFormError('');
  updateLivePreview();
}

function showFormError(msg, fieldErrorId = null) {
  ['error-ann-title', 'error-ann-body', 'error-ann-level', 'error-ann-starts', 'error-ann-expires'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  if (fieldErrorId && msg) {
    const fieldEl = document.getElementById(fieldErrorId);
    if (fieldEl) {
      fieldEl.textContent = msg;
      fieldEl.style.display = 'block';
    }
  }
  const errEl = document.getElementById('ann-form-error');
  if (!errEl) return;
  if (!msg) {
    errEl.style.display = 'none';
    errEl.textContent = '';
    return;
  }
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

function setupComposeFormListeners() {
  const form = document.getElementById('announcement-form');
  const titleInput = document.getElementById('ann-title-input');
  const bodyInput = document.getElementById('ann-body-input');
  const everyoneRadio = document.getElementById('ann-audience-everyone');
  const levelRadio = document.getElementById('ann-audience-level');
  const levelWrapper = document.getElementById('ann-level-input-wrapper');
  const levelInput = document.getElementById('ann-level-input');
  const startsInput = document.getElementById('ann-starts-at-input');
  const expiresInput = document.getElementById('ann-expires-at-input');
  const openModalBtn = document.getElementById('btn-open-announcement-modal');
  const saveAddAnotherBtn = document.getElementById('btn-save-add-another-ann');

  openModalBtn?.addEventListener('click', () => {
    resetComposeForm();
    openModal('announcement-modal');
  });

  const onAudienceChange = () => {
    const isLevel = Boolean(levelRadio?.checked);
    if (levelWrapper) {
      levelWrapper.style.display = isLevel ? 'block' : 'none';
    }
    updateLivePreview();
  };

  everyoneRadio?.addEventListener('change', onAudienceChange);
  levelRadio?.addEventListener('change', onAudienceChange);
  titleInput?.addEventListener('input', updateLivePreview);
  bodyInput?.addEventListener('input', updateLivePreview);
  levelInput?.addEventListener('input', updateLivePreview);
  startsInput?.addEventListener('input', updateLivePreview);
  expiresInput?.addEventListener('input', updateLivePreview);

  if (saveAddAnotherBtn && form) {
    saveAddAnotherBtn.addEventListener('click', () => {
      submitAndAddAnotherAnn = true;
      form.requestSubmit();
    });
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleCreateAnnouncement();
  });
}

function updateLivePreview() {
  const titleInput = document.getElementById('ann-title-input');
  const bodyInput = document.getElementById('ann-body-input');
  const counterEl = document.getElementById('ann-body-counter');
  const levelRadio = document.getElementById('ann-audience-level');
  const levelInput = document.getElementById('ann-level-input');
  const startsInput = document.getElementById('ann-starts-at-input');
  const expiresInput = document.getElementById('ann-expires-at-input');
  const liveSummaryEl = document.getElementById('announcement-live-summary');

  const rawTitle = String(titleInput?.value || '').trim();
  const rawBody = String(bodyInput?.value || '');
  const trimmedBody = rawBody.trim();

  if (counterEl) {
    counterEl.textContent = `${rawBody.length} / 500`;
  }

  const previewTitleEl = document.getElementById('preview-title-text');
  const previewBodyEl = document.getElementById('preview-body-text');
  const previewDateChipEl = document.getElementById('preview-date-chip');
  const previewAudienceEl = document.getElementById('preview-audience-label');

  // Always use textContent so announcements are strictly plain text
  if (previewTitleEl) {
    previewTitleEl.textContent = rawTitle || 'Your announcement title';
  }
  if (previewBodyEl) {
    previewBodyEl.textContent = trimmedBody || 'Your message will appear here as plain text.';
  }

  const startsIso = parseIstDatetimeLocalToIso(startsInput?.value || '') || new Date().toISOString();
  const dateChip = formatEventDateChipIST(startsIso) || 'Today';
  if (previewDateChipEl) {
    previewDateChipEl.textContent = dateChip;
  }

  const isSpecificLevel = Boolean(levelRadio?.checked);
  const chosenLevel = String(levelInput?.value || '').trim();
  if (previewAudienceEl) {
    previewAudienceEl.textContent =
      isSpecificLevel && chosenLevel ? `Audience: ${chosenLevel}` : 'Audience: Everyone';
  }

  if (liveSummaryEl) {
    liveSummaryEl.textContent = buildModalLiveSummary('announcement', {
      title: rawTitle,
      audience_mode: isSpecificLevel ? 'level' : 'everyone',
      audience_level: chosenLevel,
      starts_at: startsInput?.value ? dateChip : '',
      expires_at: expiresInput?.value || '',
    });
  }
}

async function loadStudentLevels() {
  try {
    let profiles = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profiles')
        .select('level, role, active')
        .eq('role', 'student')
        .eq('active', true);
      if (!error && Array.isArray(data)) {
        profiles = data;
      }
    } else if (isDemoMode() && DemoDB) {
      profiles = DemoDB.getStudents().filter((s) => s.role === 'student' && s.active !== false);
    }

    const levelSet = new Set();
    for (const p of profiles) {
      if (p?.level && String(p.level).trim()) {
        levelSet.add(String(p.level).trim());
      }
    }
    studentLevels = Array.from(levelSet).sort();

    const datalist = document.getElementById('ann-levels-datalist');
    if (datalist) {
      datalist.innerHTML = studentLevels
        .map((lvl) => `<option value="${escapeHtml(lvl)}"></option>`)
        .join('');
    }
  } catch (err) {
    console.warn('Could not load student levels for suggestions:', err);
  }
}

async function handleCreateAnnouncement() {
  if (isSavingAnnouncement) return;

  const titleInput = document.getElementById('ann-title-input');
  const bodyInput = document.getElementById('ann-body-input');
  const levelRadio = document.getElementById('ann-audience-level');
  const levelInput = document.getElementById('ann-level-input');
  const startsInput = document.getElementById('ann-starts-at-input');
  const expiresInput = document.getElementById('ann-expires-at-input');
  const submitBtn = document.getElementById('btn-submit-announcement');

  const title = String(titleInput?.value || '').trim();
  const body = String(bodyInput?.value || '').trim();
  const isSpecificLevel = Boolean(levelRadio?.checked);
  const rawLevel = String(levelInput?.value || '').trim();
  const audienceLevel =
    isSpecificLevel && rawLevel && rawLevel.toLowerCase() !== 'everyone' ? rawLevel : null;

  showFormError('');

  if (title.length < 1 || title.length > 80) {
    showFormError('Please enter a title between 1 and 80 characters.', 'error-ann-title');
    submitAndAddAnotherAnn = false;
    return;
  }

  if (body.length < 1 || body.length > 500) {
    showFormError('Please enter a message between 1 and 500 characters.', 'error-ann-body');
    submitAndAddAnotherAnn = false;
    return;
  }

  if (isSpecificLevel && !audienceLevel) {
    showFormError('Please enter a level or choose "Everyone".', 'error-ann-level');
    submitAndAddAnotherAnn = false;
    return;
  }

  const startsAtIso = parseIstDatetimeLocalToIso(startsInput?.value || '');
  if (!startsAtIso) {
    showFormError('Please enter a valid "Show from" date and time.', 'error-ann-starts');
    submitAndAddAnotherAnn = false;
    return;
  }

  const rawExpires = String(expiresInput?.value || '').trim();
  let expiresAtIso = null;
  if (rawExpires) {
    expiresAtIso = parseIstDatetimeLocalToIso(rawExpires);
    if (!expiresAtIso) {
      setMoreOptionsOpen(document.getElementById('announcement-more-options'), true);
      showFormError('Please enter a valid "Hide after" date and time.', 'error-ann-expires');
      submitAndAddAnotherAnn = false;
      return;
    }
    if (new Date(expiresAtIso).getTime() <= new Date(startsAtIso).getTime()) {
      setMoreOptionsOpen(document.getElementById('announcement-more-options'), true);
      showFormError('"Hide after" must be later than "Show from".', 'error-ann-expires');
      submitAndAddAnotherAnn = false;
      return;
    }
  }

  isSavingAnnouncement = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
  }

  try {
    const payload = {
      title,
      body,
      audience_level: audienceLevel,
      starts_at: startsAtIso,
      expires_at: expiresAtIso,
      created_by: currentProfile.id,
    };

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { error } = await supabase.from('announcements').insert(payload);
      if (error) throw error;
    } else if (isDemoMode() && DemoDB && typeof DemoDB.insertAnnouncement === 'function') {
      DemoDB.insertAnnouncement(payload);
    }

    showToast('success', 'Announcement posted.');
    const addAnother = submitAndAddAnotherAnn;
    submitAndAddAnotherAnn = false;
    resetComposeForm();
    await loadAnnouncements();
    if (!addAnother) {
      closeModal('announcement-modal');
    }
  } catch (err) {
    submitAndAddAnotherAnn = false;
    console.error('Failed to post announcement:', err);
    showFormError(err?.message || 'Could not post announcement. Please try again.');
  } finally {
    isSavingAnnouncement = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  }
}

async function loadAnnouncements() {
  const container = document.getElementById('announcements-list-container');
  const countEl = document.getElementById('announcements-total-count');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      announcements = Array.isArray(data) ? data : [];
    } else if (isDemoMode() && DemoDB && typeof DemoDB.getAnnouncements === 'function') {
      announcements = DemoDB.getAnnouncements();
    } else {
      announcements = [];
    }

    if (countEl) countEl.textContent = String(announcements.length);
    renderAnnouncementsList();
  } catch (err) {
    console.error('Failed to load announcements:', err);
    if (container) {
      container.innerHTML = `
        <div class="banner banner-error" role="alert">
          ${escapeHtml(err?.message || 'Could not load announcements.')}
        </div>
      `;
    }
  }
}

function renderAnnouncementsList() {
  const container = document.getElementById('announcements-list-container');
  if (!container) return;

  if (announcements.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: var(--space-6); color: var(--text-muted); font-size: var(--text-sm);">
        No announcements have been posted yet.
      </div>
    `;
    return;
  }

  const nowMs = Date.now();
  container.innerHTML = announcements
    .map((ann) => {
      const status = getAnnouncementStatus(ann, nowMs);
      const audienceText = ann.audience_level ? ann.audience_level : 'Everyone';
      const showFromStr = formatIstDateTimeReadable(ann.starts_at);
      const hideAfterStr = ann.expires_at ? formatIstDateTimeReadable(ann.expires_at) : 'No expiry';

      return `
        <article
          style="padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface); display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap;"
        >
          <div style="flex: 1 1 360px; min-width: 0;">
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: 6px;">
              <h3 style="font-size: var(--text-base); font-weight: 700; margin: 0; color: var(--text-main);">
                ${escapeHtml(ann.title)}
              </h3>
              <span class="status-chip">
                ${escapeHtml(status)}
              </span>
              <span style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 600;">
                &middot; Audience: ${escapeHtml(audienceText)}
              </span>
            </div>
            <p style="font-size: var(--text-sm); color: var(--text-main); margin: 0 0 8px 0; line-height: 1.5; white-space: pre-line;">${escapeHtml(ann.body)}</p>
            <div class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
              Show from: <strong>${escapeHtml(showFromStr)}</strong> &middot; Hide after: <strong>${escapeHtml(hideAfterStr)}</strong>
            </div>
          </div>

          <div style="flex-shrink: 0;">
            <button
              type="button"
              class="btn btn-outline btn-sm btn-delete-announcement"
              data-id="${escapeHtml(ann.id)}"
              data-title="${escapeHtml(ann.title)}"
              style="color: var(--color-danger-text);"
            >
              Delete
            </button>
          </div>
        </article>
      `;
    })
    .join('');

  container.querySelectorAll('.btn-delete-announcement').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const title = btn.getAttribute('data-title') || 'this announcement';
      if (!id) return;
      pendingDeleteAnnouncementId = id;
      const labelEl = document.getElementById('delete-ann-title-label');
      if (labelEl) labelEl.textContent = `"${title}"`;
      openModal('delete-announcement-modal');
    });
  });
}

function setupDeleteConfirmationModal() {
  const confirmBtn = document.getElementById('btn-confirm-delete-ann');
  confirmBtn?.addEventListener('click', async () => {
    if (!pendingDeleteAnnouncementId) return;
    const idToDelete = pendingDeleteAnnouncementId;
    confirmBtn.disabled = true;

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { error } = await supabase.from('announcements').delete().eq('id', idToDelete);
        if (error) throw error;
      } else if (isDemoMode() && DemoDB && typeof DemoDB.deleteAnnouncement === 'function') {
        DemoDB.deleteAnnouncement(idToDelete);
      }

      closeModal('delete-announcement-modal');
      pendingDeleteAnnouncementId = null;
      showToast('success', 'Announcement deleted.');
      await loadAnnouncements();
    } catch (err) {
      console.error('Failed to delete announcement:', err);
      showToast('error', err?.message || 'Could not delete announcement.');
    } finally {
      confirmBtn.disabled = false;
    }
  });
}

async function loadUpcomingTests14Days() {
  const container = document.getElementById('upcoming-tests-panel-body');
  if (!container) return;

  try {
    const { todayIst, endIst } = getIstDateWindow(14);
    let rows = [];

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('weekly_tests')
        .select('id, title, notes, test_date, test_type, audience_level, remind_days_before, weekly_test_sections(id)')
        .gte('test_date', todayIst)
        .lte('test_date', endIst)
        .order('test_date', { ascending: true });
      if (error) throw error;
      rows = Array.isArray(data) ? data : [];
    } else if (isDemoMode() && DemoDB) {
      const allTests = DemoDB.getWeeklyTests() || [];
      rows = allTests
        .filter((t) => t.test_date >= todayIst && t.test_date <= endIst)
        .sort((a, b) => String(a.test_date).localeCompare(String(b.test_date)))
        .map((t) => ({
          ...t,
          weekly_test_sections:
            typeof DemoDB.getWeeklyTestSections === 'function'
              ? DemoDB.getWeeklyTestSections(t.id)
              : [],
        }));
    }

    upcomingTests = rows;
    renderUpcomingTestsPanel();
  } catch (err) {
    console.error('Failed to load upcoming weekly tests:', err);
    container.innerHTML = `
      <div class="banner banner-error" role="alert">
        ${escapeHtml(err?.message || 'Could not load upcoming weekly tests.')}
      </div>
    `;
  }
}

function renderUpcomingTestsPanel() {
  const container = document.getElementById('upcoming-tests-panel-body');
  if (!container) return;

  if (upcomingTests.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: var(--space-5); color: var(--text-muted); font-size: var(--text-sm);">
        No weekly tests scheduled in the next 14 days.
      </div>
    `;
    return;
  }

  container.innerHTML = upcomingTests
    .map((test, idx) => {
      const isOnline = String(test.test_type || test.type || 'offline').toLowerCase() === 'online';
      const typeLabel = isOnline ? 'Online' : 'Offline';
      const dateStr = formatDisplayDateIST(test.test_date);
      const levelStr = test.audience_level ? test.audience_level : 'All levels';
      const remindDays =
        test.remind_days_before !== undefined && test.remind_days_before !== null
          ? Number(test.remind_days_before)
          : 7;
      const sectionsCount = Array.isArray(test.weekly_test_sections)
        ? test.weekly_test_sections.length
        : Number(test.sections_count || 0);

      const shareMessage = buildWeeklyTestShareMessage(test);
      const waHref = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;

      return `
        <div
          style="padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface);"
        >
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); flex-wrap: wrap; margin-bottom: 6px;">
            <div style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
              ${escapeHtml(test.title)}
            </div>
            <span class="status-chip">
              ${escapeHtml(typeLabel)}
            </span>
          </div>

          <div class="num" style="font-size: var(--text-xs); color: var(--text-muted); margin-bottom: var(--space-3); display: flex; flex-wrap: wrap; gap: 6px;">
            <span>${escapeHtml(dateStr)}</span>
            <span aria-hidden="true">&middot;</span>
            <span>Level: <strong>${escapeHtml(levelStr)}</strong></span>
            <span aria-hidden="true">&middot;</span>
            <span>Remind: <strong>${remindDays}d before</strong></span>
            ${
              isOnline
                ? `<span aria-hidden="true">&middot;</span><span><strong>${sectionsCount} ${sectionsCount === 1 ? 'section' : 'sections'}</strong></span>`
                : ''
            }
          </div>

          <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
            <a
              href="${escapeHtml(waHref)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-secondary btn-sm"
              style="text-decoration: none;"
            >
              Share on WhatsApp
            </a>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-copy-test-message"
              data-idx="${idx}"
            >
              Copy text
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.btn-copy-test-message').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-idx'));
      const test = upcomingTests[idx];
      if (!test) return;
      const msg = buildWeeklyTestShareMessage(test);
      try {
        await navigator.clipboard.writeText(msg);
        showToast('success', 'Weekly test message copied to clipboard.');
      } catch {
        showToast('info', msg, 6000);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', initAnnouncementsPage);
