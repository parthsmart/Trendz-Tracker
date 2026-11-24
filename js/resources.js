/**
 * Trendz Tracker - Admin Resources Management (js/resources.js)
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { setupHeaderNavigation } from './headerNav.js';
import { showToast } from './toast.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';
import { TrendzMediaPlayer, formatDuration } from './mediaPlayer.js';

let allResources = [];
let teacherAssignedStudents = [];
let submitAndAddAnotherResource = false;
let activeLecturesPlayer = null;
let lectureCategories = [];
let currentCategoryLessons = [];
let selectedCategorySlug = 'addition';
let currentPlayingLectureId = null;
let lecturePlaybackRequest = 0;

/**
 * Validates that a URL strictly starts with http:// or https://
 * @param {string} url
 * @returns {boolean}
 */
export function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

async function loadResources() {
  const tbody = document.getElementById('resources-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-state">Loading resources...</td></tr>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('resources')
          .select('*')
          .order('sort_order', { ascending: true });

        if (error) {
          console.warn('Database error loading resources:', error.message);
          allResources = [];
        } else {
          allResources = data || [];
        }
        renderResourcesTable();
        return;
      }
    }

    allResources = isSupabaseConfigured() ? [] : DemoDB.getResources();
    renderResourcesTable();
  } catch (err) {
    console.warn('Error loading resources:', err);
    allResources = isSupabaseConfigured() ? [] : DemoDB.getResources();
    renderResourcesTable();
  }
}

function renderResourcesTable() {
  const tbody = document.getElementById('resources-tbody');
  if (!tbody) return;

  if (allResources.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">
          <div class="empty-state">
            <h3 class="empty-state-title">No learning resources published yet</h3>
            <p class="empty-state-desc">Click <strong>+ Add Resource</strong> above to add curriculum guides, competition rulebooks, or practice worksheets.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = allResources.map((res, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === allResources.length - 1;
    const safeUrl = isValidHttpUrl(res.url) ? res.url.trim() : '#';

    return `
      <tr data-resource-id="${res.id}">
        <td>
          ${currentLoggedInProfile?.role === 'admin' ? `
          <div style="display: flex; gap: 4px; align-items: center;">
            <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="up" data-id="${res.id}" ${isFirst ? 'disabled' : ''} title="Move up" aria-label="Move resource up">▲</button>
            <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="down" data-id="${res.id}" ${isLast ? 'disabled' : ''} title="Move down" aria-label="Move resource down">▼</button>
          </div>
          ` : `<span style="font-size: var(--text-xs); color: var(--text-dim);">${idx + 1}</span>`}
        </td>
        <td>
          <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(res.title)}</div>
          ${res.description ? `<div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">${escapeHtml(res.description)}</div>` : ''}
        </td>
        <td>
          <span style="font-size: var(--text-xs); color: var(--text-main); font-weight: 500;">
            ${escapeHtml(res.topic || 'General')}
          </span>
        </td>
        <td>
          <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size: var(--text-xs); color: var(--color-primary); word-break: break-all;">
            ${escapeHtml(res.url)} ↗
          </a>
        </td>
        <td>
          <span class="badge ${res.active ? 'badge-success' : 'badge-neutral'}">
            ${res.active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td style="text-align: right;">
          ${
            currentLoggedInProfile?.role === 'student'
              ? '<span style="font-size: var(--text-xs); color: var(--text-dim);">Read only</span>'
              : currentLoggedInProfile?.role === 'teacher' && res.created_by !== currentLoggedInProfile.id
              ? '<span class="badge badge-neutral">Shared</span>'
              : `
            <div style="display: inline-flex; gap: 6px;">
              <button type="button" class="btn btn-outline btn-sm btn-edit-resource" data-id="${res.id}">
                Edit
              </button>
              <button type="button" class="btn ${res.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-resource" data-id="${res.id}" data-active="${res.active}">
                ${res.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
            `
          }
        </td>
      </tr>
    `;
  }).join('');

  attachTableEventListeners();
}

function attachTableEventListeners() {
  document.querySelectorAll('.btn-reorder').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const dir = e.currentTarget.getAttribute('data-dir');
      await handleReorder(id, dir);
    });
  });

  document.querySelectorAll('.btn-edit-resource').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      openEditModal(id);
    });
  });

  document.querySelectorAll('.btn-toggle-resource').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const currentActive = e.currentTarget.getAttribute('data-active') === 'true';
      await handleToggleActive(id, !currentActive);
    });
  });
}

function clearResourceErrors() {
  const errBanner = document.getElementById('resource-error-banner');
  if (errBanner) errBanner.style.display = 'none';
  ['error-resource-title', 'error-resource-topic', 'error-resource-url'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function showResourceError(msg, fieldErrId = null) {
  if (fieldErrId) {
    const el = document.getElementById(fieldErrId);
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }
  const errBanner = document.getElementById('resource-error-banner');
  if (errBanner) {
    errBanner.textContent = msg;
    errBanner.style.display = 'block';
  } else {
    showToast(msg, 'error');
  }
}

function updateResourceLiveSummary() {
  const summaryEl = document.getElementById('resource-live-summary');
  if (!summaryEl) return;
  summaryEl.textContent = buildModalLiveSummary('resource', {
    title: document.getElementById('resource-title')?.value || '',
    topic: document.getElementById('resource-topic')?.value || '',
    active: Boolean(document.getElementById('resource-active')?.checked),
  });
}

async function openEditModal(resourceId) {
  const res = allResources.find(r => r.id === resourceId);
  if (!res) return;

  if (currentLoggedInProfile?.role === 'teacher' && res.created_by && res.created_by !== currentLoggedInProfile.id) {
    showToast('You can only edit resources that you created.', 'error');
    return;
  }

  clearResourceErrors();
  document.getElementById('modal-resource-title').textContent = 'Edit Learning Resource';
  document.getElementById('resource-id').value = res.id;
  document.getElementById('resource-title').value = res.title;
  document.getElementById('resource-url').value = res.url;
  document.getElementById('resource-topic').value = res.topic || '';
  document.getElementById('resource-desc').value = res.description || '';
  document.getElementById('resource-active').checked = !!res.active;

  const recGroup = document.getElementById('resource-recipients-group');
  const recList = document.getElementById('resource-recipients-list');
  if (recGroup && recList) {
    if (currentLoggedInProfile?.role === 'teacher') {
      recGroup.style.display = 'block';
      let currentRecipients = new Set();
      if (isSupabaseConfigured()) {
        try {
          const supabase = await getSupabase();
          const { data: recData } = await supabase
            .from('resource_recipients')
            .select('student_id')
            .eq('resource_id', res.id);
          (recData || []).forEach((r) => currentRecipients.add(r.student_id));
        } catch (err) {
          console.warn('Could not load resource recipients:', err);
        }
      }
      recList.innerHTML = teacherAssignedStudents.length === 0
        ? '<div class="form-hint" style="padding: 4px;">No assigned students found.</div>'
        : teacherAssignedStudents
            .map((s) => {
              const checked = currentRecipients.has(s.id);
              return `
                <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; font-size: 0.9rem;">
                  <input type="checkbox" value="${s.id}" ${checked ? 'checked' : ''} />
                  <span>${escapeHtml(s.full_name || 'Student')} (${escapeHtml(s.student_code || '')})</span>
                </label>
              `;
            })
            .join('');
    } else {
      recGroup.style.display = 'none';
      recList.innerHTML = '';
    }
  }

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  if (btnSaveAnother) btnSaveAnother.style.display = 'none';

  setMoreOptionsOpen(
    document.getElementById('resource-more-options'),
    shouldOpenMoreOptions([res.description, res.active === false ? 'inactive' : ''], true)
  );

  updateResourceLiveSummary();
  openModal('modal-resource');
}

function openAddModal() {
  clearResourceErrors();
  document.getElementById('modal-resource-title').textContent = 'Add Learning Resource';
  document.getElementById('form-resource').reset();
  document.getElementById('resource-id').value = '';
  document.getElementById('resource-active').checked = true;

  const recGroup = document.getElementById('resource-recipients-group');
  const recList = document.getElementById('resource-recipients-list');
  if (recGroup && recList) {
    if (currentLoggedInProfile?.role === 'teacher') {
      recGroup.style.display = 'block';
      recList.innerHTML = teacherAssignedStudents.length === 0
        ? '<div class="form-hint" style="padding: 4px;">No assigned students found.</div>'
        : teacherAssignedStudents
            .map((s) => `
              <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; font-size: 0.9rem;">
                <input type="checkbox" value="${s.id}" checked />
                <span>${escapeHtml(s.full_name || 'Student')} (${escapeHtml(s.student_code || '')})</span>
              </label>
            `)
            .join('');
    } else {
      recGroup.style.display = 'none';
      recList.innerHTML = '';
    }
  }

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  if (btnSaveAnother) btnSaveAnother.style.display = 'inline-flex';

  setMoreOptionsOpen(document.getElementById('resource-more-options'), false);
  updateResourceLiveSummary();
  openModal('modal-resource');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  clearResourceErrors();
  const id = document.getElementById('resource-id').value;
  const title = document.getElementById('resource-title').value.trim();
  const url = document.getElementById('resource-url').value.trim();
  const topicRaw = document.getElementById('resource-topic').value.trim();
  const topic = topicRaw || 'General';
  const description = document.getElementById('resource-desc').value.trim();
  const active = document.getElementById('resource-active').checked;

  if (!title) {
    showResourceError('Please enter a resource title.', 'error-resource-title');
    submitAndAddAnotherResource = false;
    return;
  }

  if (!topicRaw) {
    showResourceError('Please enter a topic or grouping.', 'error-resource-topic');
    submitAndAddAnotherResource = false;
    return;
  }

  // Strict browser URL validation
  if (!isValidHttpUrl(url)) {
    showResourceError('URL must start with http:// or https://.', 'error-resource-url');
    submitAndAddAnotherResource = false;
    return;
  }

  let selectedRecipients = null;
  if (currentLoggedInProfile?.role === 'teacher') {
    const checkedBoxes = Array.from(
      document.querySelectorAll('#resource-recipients-list input[type="checkbox"]:checked')
    );
    selectedRecipients = checkedBoxes.map((cb) => cb.value);
    if (selectedRecipients.length === 0) {
      showResourceError('Please select at least one student recipient for this resource.');
      submitAndAddAnotherResource = false;
      return;
    }
  }

  const saveBtn = document.getElementById('btn-save-resource');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const maxSort = allResources.reduce((max, r) => Math.max(max, r.sort_order || 0), 0);
        const resourcePayload = {
          title,
          url,
          topic,
          description,
          active,
          sort_order: id ? undefined : maxSort + 1,
        };

        const { error } = await supabase.rpc('save_resource_atomic', {
          p_resource_id: id || null,
          p_resource: resourcePayload,
          p_recipients: currentLoggedInProfile?.role === 'teacher' ? (selectedRecipients || []) : null,
        });
        if (error) throw error;

        showToast(id ? 'Resource updated successfully' : 'Resource added successfully', 'success');
        const addAnother = submitAndAddAnotherResource && !id;
        submitAndAddAnotherResource = false;
        await loadResources();
        if (addAnother) {
          openAddModal();
        } else {
          closeModal('modal-resource');
        }
        return;
      }
    }

    // Demo Mode fallback
    if (id) {
      DemoDB.updateResource(id, { title, url, topic, description, active });
      showToast('Resource updated (Demo Mode)', 'success');
    } else {
      DemoDB.addResource({ title, url, topic, description });
      showToast('Resource added (Demo Mode)', 'success');
    }
    const addAnother = submitAndAddAnotherResource && !id;
    submitAndAddAnotherResource = false;
    await loadResources();
    if (addAnother) {
      openAddModal();
    } else {
      closeModal('modal-resource');
    }
  } catch (err) {
    submitAndAddAnotherResource = false;
    console.error('Error saving resource:', err);
    showResourceError(`Error saving resource: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function handleReorder(resourceId, direction) {
  const index = allResources.findIndex(r => r.id === resourceId);
  if (index === -1) return;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= allResources.length) return;

  const current = allResources[index];
  const neighbor = allResources[targetIndex];

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const curOrder = current.sort_order;
        const nbrOrder = neighbor.sort_order;

        await Promise.all([
          supabase.from('resources').update({ sort_order: nbrOrder }).eq('id', current.id),
          supabase.from('resources').update({ sort_order: curOrder }).eq('id', neighbor.id)
        ]);
        await loadResources();
        return;
      }
    }

    DemoDB.reorderResource(resourceId, direction);
    await loadResources();
  } catch (err) {
    console.error('Reorder error:', err);
    showToast('Failed to reorder resource', 'error');
  }
}

async function handleToggleActive(resourceId, newActive) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { error } = await supabase
          .from('resources')
          .update({ active: newActive })
          .eq('id', resourceId);
        if (error) throw error;
        showToast(newActive ? 'Resource activated' : 'Resource deactivated', 'info');
        await loadResources();
        return;
      }
    }

    DemoDB.toggleResourceActive(resourceId);
    showToast(newActive ? 'Resource activated (Demo)' : 'Resource deactivated (Demo)', 'info');
    await loadResources();
  } catch (err) {
    console.error('Toggle active error:', err);
    showToast('Failed to update status', 'error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let currentLoggedInProfile = null;

export async function loadLectureCategories() {
  const listEl = document.getElementById('lectures-category-list');
  const countBadge = document.getElementById('lectures-categories-count');
  if (!listEl) return;

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/lectures', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || ''}`,
      },
      body: JSON.stringify({ action: 'list_categories' }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load lecture categories.');
    }

    lectureCategories = data.categories || [];
    if (lectureCategories.length === 0) {
      // Fallback from manifest
      try {
        const manifestRes = await fetch('/data/jr_mcwc_classroom_manifest.json');
        if (manifestRes.ok) {
          const manifest = await manifestRes.json();
          lectureCategories = (manifest.categories || []).map((c, i) => ({
            title: c.title,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder || i + 1,
            lessonCount: c.lessons?.length || 0,
          }));
        }
      } catch (_) {}
    }

    if (countBadge) {
      countBadge.textContent = `${lectureCategories.length} Topics`;
    }

    renderCategoriesList();

    // Select the first category by default (e.g. Addition)
    if (lectureCategories.length > 0) {
      const activeCat = lectureCategories.find((c) => c.slug === selectedCategorySlug) || lectureCategories[0];
      await selectCategory(activeCat.slug);
    }
  } catch (err) {
    listEl.innerHTML = `<li style="padding: 16px; color: #ef4444; font-size: 13px;">Error loading categories: ${err.message}</li>`;
  }
}

export function renderCategoriesList(filterQuery = '') {
  const listEl = document.getElementById('lectures-category-list');
  if (!listEl) return;

  let filtered = lectureCategories;
  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    filtered = lectureCategories.filter((c) => c.title.toLowerCase().includes(q));
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<li style="padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center;">No topics matching "${filterQuery}"</li>`;
    return;
  }

  listEl.innerHTML = filtered.map((cat) => {
    const isActive = cat.slug === selectedCategorySlug;
    return `
      <li class="lectures-category-item ${isActive ? 'is-active' : ''}" data-slug="${cat.slug}">
        <div>
          <strong>${cat.title}</strong>
        </div>
        <span class="badge ${isActive ? 'badge-primary' : 'badge-neutral'}" style="font-size: 11px;">
          ${cat.lessonCount} ${cat.lessonCount === 1 ? 'lesson' : 'lessons'}
        </span>
      </li>
    `;
  }).join('');

  listEl.querySelectorAll('.lectures-category-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const slug = item.getAttribute('data-slug');
      await selectCategory(slug);
    });
  });
}

export async function selectCategory(categorySlug) {
  selectedCategorySlug = categorySlug;
  renderCategoriesList(document.getElementById('search-lectures')?.value || '');

  const cat = lectureCategories.find((c) => c.slug === categorySlug);
  const titleEl = document.getElementById('current-category-title');
  const descEl = document.getElementById('current-category-desc');
  const badgeEl = document.getElementById('current-category-badge');
  const queueEl = document.getElementById('lectures-queue-list');

  if (titleEl) titleEl.textContent = cat?.title || categorySlug;
  if (descEl) descEl.textContent = cat?.description || 'Junior MCWC course curriculum';

  if (queueEl) queueEl.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 13px;">Loading lessons...</div>';

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/lectures', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || ''}`,
      },
      body: JSON.stringify({ action: 'list_lectures', categorySlug }),
    });

    const data = await res.json();
    currentCategoryLessons = (data && data.lectures) || [];

    if (currentCategoryLessons.length === 0) {
      // Fallback from manifest
      try {
        const manifestRes = await fetch('/data/jr_mcwc_classroom_manifest.json');
        if (manifestRes.ok) {
          const manifest = await manifestRes.json();
          const mCat = (manifest.categories || []).find((c) => c.slug === categorySlug);
          if (mCat && Array.isArray(mCat.lessons)) {
            currentCategoryLessons = mCat.lessons.map((l, i) => ({
              id: `manifest-${categorySlug}-${i + 1}`,
              title: l.title,
              lessonOrder: l.lessonOrder || i + 1,
              durationSeconds: l.durationSeconds || 0,
              mediaType: l.mediaType || 'drive_embed',
              mediaUrl: l.mediaUrl,
              notes: l.notes,
              categoryTitle: mCat.title,
              categorySlug: mCat.slug,
            }));
          }
        }
      } catch (_) {}
    }

    if (badgeEl) {
      badgeEl.textContent = `${currentCategoryLessons.length} ${currentCategoryLessons.length === 1 ? 'Lesson' : 'Lessons'}`;
    }

    renderLessonQueue();

    // Auto-play the first lesson
    if (currentCategoryLessons.length > 0) {
      playLecture(currentCategoryLessons[0].id);
    }
  } catch (err) {
    if (queueEl) queueEl.innerHTML = `<div style="padding: 12px; color: #ef4444; font-size: 13px;">Error loading lessons: ${err.message}</div>`;
  }
}

export function renderLessonQueue() {
  const queueEl = document.getElementById('lectures-queue-list');
  if (!queueEl) return;

  if (currentCategoryLessons.length === 0) {
    queueEl.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 13px;">No lessons found for this topic yet.</div>';
    return;
  }

  queueEl.innerHTML = currentCategoryLessons.map((lec) => {
    const isPlaying = lec.id === currentPlayingLectureId;
    return `
      <div class="lectures-queue-card ${isPlaying ? 'is-playing' : ''}" data-id="${lec.id}">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span class="badge ${isPlaying ? 'badge-primary' : 'badge-neutral'}" style="font-weight: 700;">
            Part ${lec.lessonOrder}
          </span>
          <div>
            <div class="lectures-queue-title" style="font-size: var(--text-sm);">${lec.title}</div>
            ${lec.notes ? `<div style="font-size: var(--text-xs); color: var(--text-muted);">${lec.notes}</div>` : ''}
          </div>
        </div>
        <div style="font-family: monospace; font-size: var(--text-xs); color: var(--text-muted);">
          ${lec.durationSeconds ? formatDuration(lec.durationSeconds) : '—'}
        </div>
      </div>
    `;
  }).join('');

  queueEl.querySelectorAll('.lectures-queue-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      playLecture(id);
    });
  });
}

export async function playLecture(lectureId) {
  const lecture = currentCategoryLessons.find((l) => l.id === lectureId);
  if (!lecture) return;

  currentPlayingLectureId = lectureId;
  const request = ++lecturePlaybackRequest;
  renderLessonQueue();

  const mountEl = document.getElementById('lectures-player-mount');
  if (!mountEl) return;

  if (activeLecturesPlayer) {
    activeLecturesPlayer.destroy();
    activeLecturesPlayer = null;
  }

  let mediaUrl = lecture.mediaUrl;
  if (/^(storage|private):\/\//.test(mediaUrl || '')) {
    mountEl.textContent = 'Loading video…';
    try {
      const supabase = await getSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch('/api/lectures', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ action: 'get_lecture', lectureId }),
      });
      const result = await response.json();
      if (!response.ok || !result.lecture?.mediaUrl) {
        throw new Error(result.error || 'Could not open the video.');
      }
      mediaUrl = result.lecture.mediaUrl;
    } catch (error) {
      if (request === lecturePlaybackRequest && currentCategoryLessons.includes(lecture)) {
        mountEl.textContent = `${error.message || 'Could not open the video.'} Select the lesson to retry.`;
      }
      return;
    }
    if (request !== lecturePlaybackRequest || !currentCategoryLessons.includes(lecture)) return;
  }

  const currentIndex = currentCategoryLessons.findIndex((l) => l.id === lectureId);
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < currentCategoryLessons.length - 1;

  activeLecturesPlayer = new TrendzMediaPlayer(mountEl, {
    userId: currentLoggedInProfile?.id || 'student',
    mediaId: lecture.id,
    mediaType: lecture.mediaType || 'drive_embed',
    mediaUrl,
    title: lecture.title,
    category: lecture.categoryTitle || 'Jr. MCWC Lecture',
    lessonOrder: lecture.lessonOrder,
    totalLessons: currentCategoryLessons.length,
    hasPrevious,
    hasNext,
    onPrevious: () => {
      if (hasPrevious) playLecture(currentCategoryLessons[currentIndex - 1].id);
    },
    onNext: () => {
      if (hasNext) playLecture(currentCategoryLessons[currentIndex + 1].id);
    },
  });
}

export async function openClassroomImportModal() {
  const tbody = document.getElementById('import-preview-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 16px;">Loading import preview from Google Classroom...</td></tr>';

  openModal('modal-classroom-import');

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/lectures', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || ''}`,
      },
      body: JSON.stringify({ action: 'import_preview' }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to generate classroom import preview.');
    }

    const { preview } = data;
    const catCount = document.getElementById('import-categories-count');
    const lesCount = document.getElementById('import-lessons-count');
    const warCount = document.getElementById('import-warnings-count');

    if (catCount) catCount.textContent = preview.categoriesCount;
    if (lesCount) lesCount.textContent = preview.totalLessonsCount;
    if (warCount) warCount.textContent = preview.warnings?.length || 0;

    if (tbody) {
      tbody.innerHTML = preview.categories.map((cat) => `
        <tr style="border-bottom: 1px solid var(--border-hairline);">
          <td style="padding: 8px 12px; font-weight: 600;">${cat.title}</td>
          <td style="padding: 8px 12px; font-family: monospace;">#${cat.sortOrder}</td>
          <td style="padding: 8px 12px;"><span class="badge badge-info">${cat.lessonCount}</span></td>
          <td style="padding: 8px 12px; color: var(--text-muted);">${cat.lessons[0]?.title || '—'}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" style="color: #ef4444; padding: 16px; text-align: center;">${err.message}</td></tr>`;
    }
  }
}

export async function publishClassroomImport() {
  const btn = document.getElementById('btn-publish-classroom-import');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Publishing Catalogue...';
  }

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/lectures', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || ''}`,
      },
      body: JSON.stringify({ action: 'publish_import' }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to publish classroom import.');
    }

    closeModal('modal-classroom-import');
    showToast(data.message || 'Classroom lectures successfully imported!', 'success');
    await loadLectureCategories();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Publish to Catalogue';
    }
  }
}

export async function initResourcesPage() {
  const profile = await requireAuth(['student', 'teacher', 'admin']);
  if (!profile) return;
  currentLoggedInProfile = profile;

  // Header user info
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || (profile.role === 'admin' ? 'Admin' : profile.role === 'teacher' ? 'Teacher' : 'Student');
  if (roleEl) roleEl.textContent = profile.student_code || (profile.role === 'admin' ? 'Admin' : profile.role === 'teacher' ? 'Teacher' : 'Student');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();
  if (profile.role === 'admin') {
    setupAdminNav(profile);
  } else {
    setupHeaderNavigation(profile);
  }

  // Setup tab switcher: Lectures vs Materials
  const tabLectures = document.getElementById('tab-btn-lectures');
  const tabMaterials = document.getElementById('tab-btn-materials');
  const viewLectures = document.getElementById('view-lectures-tab');
  const viewMaterials = document.getElementById('view-materials-tab');

  if (tabLectures && tabMaterials) {
    tabLectures.addEventListener('click', () => {
      tabLectures.classList.add('btn-primary', 'tab-active');
      tabLectures.classList.remove('btn-outline');
      tabMaterials.classList.remove('btn-primary', 'tab-active');
      tabMaterials.classList.add('btn-outline');
      if (viewLectures) viewLectures.style.display = 'block';
      if (viewMaterials) viewMaterials.style.display = 'none';
    });

    tabMaterials.addEventListener('click', async () => {
      tabMaterials.classList.add('btn-primary', 'tab-active');
      tabMaterials.classList.remove('btn-outline');
      tabLectures.classList.remove('btn-primary', 'tab-active');
      tabLectures.classList.add('btn-outline');
      if (viewLectures) viewLectures.style.display = 'none';
      if (viewMaterials) viewMaterials.style.display = 'block';
      await loadResources();
    });
  }

  // Admin-only buttons visibility
  const importBtn = document.getElementById('btn-open-classroom-import');
  if (importBtn) {
    if (profile.role === 'admin') {
      importBtn.style.display = 'inline-flex';
      importBtn.addEventListener('click', openClassroomImportModal);
    } else {
      importBtn.style.display = 'none';
    }
  }

  const addResourceBtn = document.getElementById('btn-open-add-resource');
  if (addResourceBtn && profile.role !== 'admin') {
    addResourceBtn.style.display = 'none';
  }

  document.getElementById('btn-publish-classroom-import')?.addEventListener('click', publishClassroomImport);

  // Search input in lectures sidebar
  document.getElementById('search-lectures')?.addEventListener('input', (e) => {
    renderCategoriesList(e.target.value.trim());
  });

  // Material resources handlers
  document.getElementById('btn-open-add-resource')?.addEventListener('click', openAddModal);
  document.getElementById('form-resource')?.addEventListener('submit', handleFormSubmit);

  ['resource-title', 'resource-topic', 'resource-active'].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', updateResourceLiveSummary);
    el?.addEventListener('change', updateResourceLiveSummary);
  });

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  const formEl = document.getElementById('form-resource');
  if (btnSaveAnother && formEl) {
    btnSaveAnother.addEventListener('click', () => {
      submitAndAddAnotherResource = true;
      formEl.requestSubmit();
    });
  }

  // Load lectures categories initially
  await loadLectureCategories();
}

document.addEventListener('DOMContentLoaded', initResourcesPage);
