/**
 * Trendz Tracker - Admin Categories Management (js/categories.js)
 *
 * Phase 4c-0 Architecture:
 * - Grouped listing by section ('round', 'basics', 'elements', 'flash').
 * - For Round categories (`section === 'round'`):
 *     - Displays simulator series checkboxes (`round_series`) showing which series each round category belongs to (`category_series`).
 *     - Provides a Series Ordering selector so admins can reorder round categories within each simulator series (`category_series.sort_order`),
 *       and also displays unassigned round categories so they can be toggled into any series.
 *     - Adding a new round category automatically assigns it to the current series (`round_series.is_current = true`) at the end of `category_series`.
 * - For Basics, Elements, and Flash categories:
 *     - Reorders `categories.sort_order` within their section as before.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupAdminNav, setupModalListeners } from './modal.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';

let allCategories = [];
let allSeries = [];
let allCategorySeries = []; // { category_id, series_id, sort_order }
let activeSectionFilter = 'all';
let selectedRoundSeriesId = '';

const SECTION_CONFIG = {
  round: {
    title: 'Championship Round Categories',
    icon: '🏆',
    description: 'Official Junior Mental Calculation World Championship round disciplines, ordered per simulator series.'
  },
  basics: {
    title: 'Basics Drills (Digits & Rows)',
    icon: '⚡',
    description: 'Mental calculation daily speed drills (e.g. 1d4r, 2d2r).'
  },
  elements: {
    title: 'Elements',
    icon: '🧩',
    description: 'Building-block calculation exercises.'
  },
  flash: {
    title: 'Flash Anzan',
    icon: '⏱️',
    description: 'Rapid flashing mental calculation drills.'
  },
};

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
 * Fetch categories, round_series, and category_series from Supabase or DemoDB
 */
async function loadCategories() {
  const container = document.getElementById('categories-container');
  const countDisplay = document.getElementById('cat-count-display');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const [catsRes, seriesRes, catSeriesRes] = await Promise.all([
        supabase
          .from('categories')
          .select('*')
          .order('section')
          .order('sort_order', { ascending: true }),
        supabase
          .from('round_series')
          .select('*')
          .order('sort_order', { ascending: true }),
        supabase
          .from('category_series')
          .select('*')
          .order('sort_order', { ascending: true })
      ]);

      if (catsRes.error) throw new Error(catsRes.error.message);
      if (seriesRes.error) throw new Error(seriesRes.error.message);
      if (catSeriesRes.error) throw new Error(catSeriesRes.error.message);

      allCategories = catsRes.data || [];
      allSeries = seriesRes.data || [];
      allCategorySeries = catSeriesRes.data || [];
    } else {
      allCategories = DemoDB.getCategories();
      allSeries = DemoDB.getRoundSeries();
      allCategorySeries = DemoDB.getCategorySeries();
    }

    // Default selectedRoundSeriesId to the current series
    if (!selectedRoundSeriesId || !allSeries.some(s => s.id === selectedRoundSeriesId)) {
      const current = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1];
      selectedRoundSeriesId = current ? current.id : '';
    }

    if (countDisplay) {
      countDisplay.textContent = `${allCategories.length} total categories`;
    }

    // Update the Rounds tab button label with accurate count
    const roundTabBtn = document.querySelector('.segmented-btn[data-section="round"]');
    if (roundTabBtn) {
      const roundTotal = allCategories.filter(c => c.section === 'round').length;
      roundTabBtn.textContent = `Rounds (${roundTotal})`;
    }

    renderCategories();
  } catch (err) {
    console.error('Error loading categories:', err);
    showToast('error', 'Failed to load categories: ' + err.message);
    if (container) {
      container.innerHTML = `
        <div class="banner banner-error" style="display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3);">
          <div>Error loading categories: ${escapeHtml(err.message)}</div>
          <button type="button" id="btn-retry-load-cats" class="btn btn-outline btn-sm" style="background: #fff;">
            ↻ Retry
          </button>
        </div>
      `;
      document.getElementById('btn-retry-load-cats')?.addEventListener('click', () => {
        container.innerHTML = '<div style="padding: var(--space-6); text-align: center; color: var(--text-muted);"><span class="spinner" style="margin-right: 8px;"></span> Loading categories...</div>';
        loadCategories();
      });
    }
  }
}

/**
 * Render categories grouped by section
 */
function renderCategories() {
  const container = document.getElementById('categories-container');
  const sectionsToDisplay = activeSectionFilter === 'all'
    ? ['round', 'basics', 'elements', 'flash']
    : [activeSectionFilter];

  let html = '';

  sectionsToDisplay.forEach(sectionKey => {
    if (sectionKey === 'round') {
      html += renderRoundSectionHtml();
    } else {
      html += renderStandardSectionHtml(sectionKey);
    }
  });

  container.innerHTML = html;
  attachCategoryActionListeners();
}

/**
 * Render Round Categories section with Simulator Series selector, category_series.sort_order ordering,
 * and per-series membership checkboxes
 */
function renderRoundSectionHtml() {
  const meta = SECTION_CONFIG.round;
  const roundCats = allCategories.filter(c => c.section === 'round');

  // Map category_id -> Map(series_id -> sort_order)
  const membershipMap = new Map();
  allCategorySeries.forEach(cs => {
    if (!membershipMap.has(cs.category_id)) {
      membershipMap.set(cs.category_id, new Map());
    }
    membershipMap.get(cs.category_id).set(cs.series_id, cs.sort_order);
  });

  const activeSeriesObj = allSeries.find(s => s.id === selectedRoundSeriesId) || null;

  // Categories belonging to the selected series, ordered strictly by category_series.sort_order
  const inSelectedSeries = roundCats
    .filter(c => membershipMap.get(c.id)?.has(selectedRoundSeriesId))
    .map(c => ({
      ...c,
      series_sort_order: membershipMap.get(c.id).get(selectedRoundSeriesId)
    }))
    .sort((a, b) => (a.series_sort_order || 0) - (b.series_sort_order || 0));

  // Round categories NOT in the selected series (e.g. Old simulator categories when viewing New simulator)
  const notInSelectedSeries = roundCats
    .filter(c => !membershipMap.get(c.id)?.has(selectedRoundSeriesId))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const renderRoundCategoryRow = (cat, index, listLength, isInSelectedSeries) => {
    const seriesCheckboxesHtml = allSeries.map(ser => {
      const belongs = membershipMap.get(cat.id)?.has(ser.id) || false;
      const orderNum = membershipMap.get(cat.id)?.get(ser.id);
      return `
        <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-main); background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); padding: 2px 8px; border-radius: var(--radius-sm); cursor: pointer;">
          <input
            type="checkbox"
            class="chk-category-series"
            data-cat-id="${escapeHtml(cat.id)}"
            data-series-id="${escapeHtml(ser.id)}"
            ${belongs ? 'checked' : ''}
          />
          <span>${escapeHtml(ser.name)}${belongs && orderNum !== undefined ? ` (#${orderNum})` : ''}</span>
        </label>
      `;
    }).join('');

    return `
      <div class="category-item ${cat.active ? '' : 'category-inactive'}" style="flex-wrap: wrap; gap: var(--space-3);">
        <div class="category-main-info" style="flex-wrap: wrap; gap: var(--space-2);">
          <span class="category-order-num num" title="${isInSelectedSeries ? 'Order in selected series' : 'Not in selected series'}">
            ${isInSelectedSeries ? `#${cat.series_sort_order}` : '—'}
          </span>
          <span class="category-name-text">${escapeHtml(cat.name)}</span>
          <span class="status-indicator ${cat.active ? 'active' : 'inactive'}">
            ${cat.active ? 'Active' : 'Inactive'}
          </span>
          <div style="display: inline-flex; gap: 6px; flex-wrap: wrap; margin-left: var(--space-2);">
            ${seriesCheckboxesHtml}
          </div>
        </div>

        <div class="category-actions">
          ${isInSelectedSeries ? `
            <button
              type="button"
              class="btn btn-outline btn-sm btn-reorder-series"
              data-id="${escapeHtml(cat.id)}"
              data-series-id="${escapeHtml(selectedRoundSeriesId)}"
              data-direction="up"
              ${index === 0 ? 'disabled' : ''}
              aria-label="Move ${escapeHtml(cat.name)} up in ${escapeHtml(activeSeriesObj?.name || 'series')}"
              title="Move up in ${escapeHtml(activeSeriesObj?.name || 'series')}"
            >
              ↑
            </button>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-reorder-series"
              data-id="${escapeHtml(cat.id)}"
              data-series-id="${escapeHtml(selectedRoundSeriesId)}"
              data-direction="down"
              ${index === listLength - 1 ? 'disabled' : ''}
              aria-label="Move ${escapeHtml(cat.name)} down in ${escapeHtml(activeSeriesObj?.name || 'series')}"
              title="Move down in ${escapeHtml(activeSeriesObj?.name || 'series')}"
            >
              ↓
            </button>
          ` : ''}
          <button
            type="button"
            class="btn btn-outline btn-sm btn-rename"
            data-id="${escapeHtml(cat.id)}"
            data-name="${escapeHtml(cat.name)}"
            title="Rename category"
          >
            Rename
          </button>
          <button
            type="button"
            class="btn ${cat.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-active"
            data-id="${escapeHtml(cat.id)}"
            data-active="${cat.active}"
            title="${cat.active ? 'Deactivate category' : 'Activate category'}"
          >
            ${cat.active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
    `;
  };

  return `
    <section class="categories-section-group" aria-labelledby="section-heading-round">
      <div class="section-header-row" style="flex-wrap: wrap; gap: var(--space-3);">
        <div>
          <h2 id="section-heading-round" class="section-badge-title">
            <span>${meta.icon}</span>
            <span>${meta.title}</span>
            <span class="num" style="font-size: var(--text-xs); color: var(--text-dim); font-weight: normal;">
              (${inSelectedSeries.length} in ${escapeHtml(activeSeriesObj?.name || 'series')} · ${roundCats.length} total)
            </span>
          </h2>
          <p style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
            ${meta.description}
          </p>
        </div>

        <!-- Series Selector for Ordering Round Categories -->
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <label for="select-round-series-order" class="form-label" style="margin-bottom: 0; font-size: var(--text-xs); white-space: nowrap;">
            Order for Series:
          </label>
          <select id="select-round-series-order" class="form-select" style="min-height: 36px; font-size: var(--text-xs); font-weight: 600;">
            ${allSeries.map(s => `
              <option value="${escapeHtml(s.id)}" ${s.id === selectedRoundSeriesId ? 'selected' : ''}>
                ${escapeHtml(s.is_current ? `${s.name} (Current)` : s.name)}
              </option>
            `).join('')}
          </select>
        </div>
      </div>

      <div class="categories-list">
        ${inSelectedSeries.length === 0 ? `
          <div class="card" style="padding: var(--space-4); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
            No round categories assigned to ${escapeHtml(activeSeriesObj?.name || 'this series')} yet. Check a series box below to assign categories.
          </div>
        ` : inSelectedSeries.map((cat, idx) => renderRoundCategoryRow(cat, idx, inSelectedSeries.length, true)).join('')}
      </div>

      ${notInSelectedSeries.length > 0 ? `
        <div style="margin-top: var(--space-4);">
          <h3 style="font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: var(--space-2);">
            Other Round Categories (Not in ${escapeHtml(activeSeriesObj?.name || 'selected series')})
          </h3>
          <div class="categories-list">
            ${notInSelectedSeries.map((cat, idx) => renderRoundCategoryRow(cat, idx, notInSelectedSeries.length, false)).join('')}
          </div>
        </div>
      ` : ''}
    </section>
  `;
}

/**
 * Render non-round sections (basics, elements, flash)
 */
function renderStandardSectionHtml(sectionKey) {
  const meta = SECTION_CONFIG[sectionKey];
  const items = allCategories
    .filter(c => c.section === sectionKey)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  return `
    <section class="categories-section-group" aria-labelledby="section-heading-${sectionKey}">
      <div class="section-header-row">
        <div>
          <h2 id="section-heading-${sectionKey}" class="section-badge-title">
            <span>${meta.icon}</span>
            <span>${meta.title}</span>
            <span class="num" style="font-size: var(--text-xs); color: var(--text-dim); font-weight: normal;">
              (${items.length})
            </span>
          </h2>
          <p style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
            ${meta.description}
          </p>
        </div>
      </div>

      <div class="categories-list">
        ${items.length === 0 ? `
          <div class="card" style="padding: var(--space-4); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
            No categories configured in this section yet.
          </div>
        ` : items.map((cat, index) => `
          <div class="category-item ${cat.active ? '' : 'category-inactive'}">
            <div class="category-main-info">
              <span class="category-order-num num">#${cat.sort_order}</span>
              <span class="category-name-text">${escapeHtml(cat.name)}</span>
              <span class="status-indicator ${cat.active ? 'active' : 'inactive'}">
                ${cat.active ? 'Active' : 'Inactive'}
              </span>
            </div>

            <div class="category-actions">
              <button
                type="button"
                class="btn btn-outline btn-sm btn-reorder"
                data-id="${escapeHtml(cat.id)}"
                data-section="${escapeHtml(cat.section)}"
                data-direction="up"
                ${index === 0 ? 'disabled' : ''}
                aria-label="Move ${escapeHtml(cat.name)} up"
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm btn-reorder"
                data-id="${escapeHtml(cat.id)}"
                data-section="${escapeHtml(cat.section)}"
                data-direction="down"
                ${index === items.length - 1 ? 'disabled' : ''}
                aria-label="Move ${escapeHtml(cat.name)} down"
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm btn-rename"
                data-id="${escapeHtml(cat.id)}"
                data-name="${escapeHtml(cat.name)}"
                title="Rename category"
              >
                Rename
              </button>
              <button
                type="button"
                class="btn ${cat.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-active"
                data-id="${escapeHtml(cat.id)}"
                data-active="${cat.active}"
                title="${cat.active ? 'Deactivate category' : 'Activate category'}"
              >
                ${cat.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

/**
 * Attach button click handlers for series switching, series membership, reordering, renaming, and active toggling
 */
function attachCategoryActionListeners() {
  // Series selector change for Round section
  const seriesSelect = document.getElementById('select-round-series-order');
  seriesSelect?.addEventListener('change', () => {
    selectedRoundSeriesId = seriesSelect.value;
    renderCategories();
  });

  // Series membership checkbox toggle
  document.querySelectorAll('.chk-category-series').forEach(chk => {
    chk.addEventListener('change', async () => {
      const catId = chk.getAttribute('data-cat-id');
      const seriesId = chk.getAttribute('data-series-id');
      const shouldBelong = chk.checked;

      chk.disabled = true;
      try {
        await toggleCategorySeries(catId, seriesId, shouldBelong);
        showToast('success', shouldBelong ? 'Category added to series.' : 'Category removed from series.');
        await loadCategories();
      } catch (err) {
        chk.checked = !shouldBelong;
        chk.disabled = false;
        showToast('error', 'Failed to update series membership: ' + err.message);
      }
    });
  });

  // Reordering within a simulator series (category_series.sort_order)
  document.querySelectorAll('.btn-reorder-series').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catId = btn.getAttribute('data-id');
      const seriesId = btn.getAttribute('data-series-id');
      const direction = btn.getAttribute('data-direction');

      btn.disabled = true;
      try {
        await reorderCategoryInSeries(catId, seriesId, direction);
        await loadCategories();
      } catch (err) {
        showToast('error', 'Series reorder failed: ' + err.message);
        btn.disabled = false;
      }
    });
  });

  // Reordering standard non-round sections
  document.querySelectorAll('.btn-reorder').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catId = btn.getAttribute('data-id');
      const section = btn.getAttribute('data-section');
      const direction = btn.getAttribute('data-direction');

      btn.disabled = true;
      try {
        await reorderCategory(catId, section, direction);
        await loadCategories();
      } catch (err) {
        showToast('error', 'Reorder failed: ' + err.message);
        btn.disabled = false;
      }
    });
  });

  // Renaming
  document.querySelectorAll('.btn-rename').forEach(btn => {
    btn.addEventListener('click', () => {
      const catId = btn.getAttribute('data-id');
      const catName = btn.getAttribute('data-name');

      document.getElementById('rename-cat-id').value = catId;
      document.getElementById('rename-cat-name').value = catName;
      document.getElementById('rename-cat-error').style.display = 'none';

      openModal('rename-category-modal');
    });
  });

  // Toggle active
  document.querySelectorAll('.btn-toggle-active').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catId = btn.getAttribute('data-id');
      const currentActive = btn.getAttribute('data-active') === 'true';
      const actionName = currentActive ? 'deactivated' : 'activated';

      btn.disabled = true;
      try {
        await toggleCategoryActive(catId, currentActive);
        showToast('success', `Category has been ${actionName}.`);
        await loadCategories();
      } catch (err) {
        showToast('error', `Failed to update status: ` + err.message);
        btn.disabled = false;
      }
    });
  });
}

/**
 * Add or remove a round category from a simulator series (`category_series`)
 */
async function toggleCategorySeries(catId, seriesId, shouldBelong) {
  if (!isSupabaseConfigured()) {
    DemoDB.toggleCategorySeriesMembership(catId, seriesId, shouldBelong);
    return;
  }

  const supabase = await getSupabase();
  if (shouldBelong) {
    const inSeries = allCategorySeries.filter(cs => cs.series_id === seriesId);
    const maxSort = inSeries.reduce((m, cs) => Math.max(m, cs.sort_order || 0), 0);
    const { error } = await supabase
      .from('category_series')
      .insert({
        category_id: catId,
        series_id: seriesId,
        sort_order: maxSort + 1
      });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from('category_series')
      .delete()
      .eq('category_id', catId)
      .eq('series_id', seriesId);
    if (error) throw new Error(error.message);
  }
}

/**
 * Reorder a round category up or down within a simulator series (`category_series.sort_order`)
 */
async function reorderCategoryInSeries(catId, seriesId, direction) {
  if (!isSupabaseConfigured()) {
    DemoDB.reorderCategoryInSeries(catId, seriesId, direction);
    return;
  }

  const supabase = await getSupabase();
  const seriesItems = allCategorySeries
    .filter(cs => cs.series_id === seriesId)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const currentIndex = seriesItems.findIndex(cs => cs.category_id === catId);
  if (currentIndex === -1) return;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= seriesItems.length) return;

  const currentItem = seriesItems[currentIndex];
  const targetItem = seriesItems[targetIndex];

  const currentSort = currentItem.sort_order;
  const targetSort = targetItem.sort_order;

  const { error: err1 } = await supabase
    .from('category_series')
    .update({ sort_order: targetSort })
    .eq('category_id', currentItem.category_id)
    .eq('series_id', seriesId);

  if (err1) throw new Error(err1.message);

  const { error: err2 } = await supabase
    .from('category_series')
    .update({ sort_order: currentSort })
    .eq('category_id', targetItem.category_id)
    .eq('series_id', seriesId);

  if (err2) throw new Error(err2.message);
}

/**
 * Reorder non-round category up or down within its section
 */
async function reorderCategory(catId, section, direction) {
  if (!isSupabaseConfigured()) {
    DemoDB.reorderCategory(catId, direction);
    return;
  }

  const supabase = await getSupabase();
  const sectionItems = allCategories
    .filter(c => c.section === section)
    .sort((a, b) => a.sort_order - b.sort_order);

  const currentIndex = sectionItems.findIndex(c => c.id === catId);
  if (currentIndex === -1) return;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= sectionItems.length) return;

  const currentItem = sectionItems[currentIndex];
  const targetItem = sectionItems[targetIndex];

  const currentSort = currentItem.sort_order;
  const targetSort = targetItem.sort_order;

  const { error: err1 } = await supabase
    .from('categories')
    .update({ sort_order: targetSort })
    .eq('id', currentItem.id);

  if (err1) throw new Error(err1.message);

  const { error: err2 } = await supabase
    .from('categories')
    .update({ sort_order: currentSort })
    .eq('id', targetItem.id);

  if (err2) throw new Error(err2.message);
}

/**
 * Toggle category active state
 */
async function toggleCategoryActive(catId, currentActive) {
  if (!isSupabaseConfigured()) {
    return DemoDB.toggleCategoryActive(catId);
  }

  const supabase = await getSupabase();
  const { error } = await supabase
    .from('categories')
    .update({ active: !currentActive })
    .eq('id', catId);

  if (error) throw new Error(error.message);
}

/**
 * Rename category
 */
async function renameCategory(catId, newName) {
  if (!isSupabaseConfigured()) {
    return DemoDB.renameCategory(catId, newName);
  }

  const supabase = await getSupabase();
  const { error } = await supabase
    .from('categories')
    .update({ name: newName.trim() })
    .eq('id', catId);

  if (error) throw new Error(error.message);
}

/**
 * Add a new category (and if section === 'round', attach it to the current series in category_series)
 */
async function addCategory(name, section) {
  const currentSeries = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1];

  if (!isSupabaseConfigured()) {
    const created = DemoDB.addCategory({ name, section });
    if (section === 'round' && currentSeries) {
      DemoDB.toggleCategorySeriesMembership(created.id, currentSeries.id, true);
    }
    return created;
  }

  const supabase = await getSupabase();
  const sameSection = allCategories.filter(c => c.section === section);
  const maxSort = sameSection.reduce((max, c) => Math.max(max, c.sort_order || 0), 0);

  const { data, error } = await supabase
    .from('categories')
    .insert({
      name: name.trim(),
      section,
      sort_order: maxSort + 1,
      active: true,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  // Automatically link new round category to the current series
  if (section === 'round' && currentSeries && data?.id) {
    const inSeries = allCategorySeries.filter(cs => cs.series_id === currentSeries.id);
    const maxSeriesSort = inSeries.reduce((m, cs) => Math.max(m, cs.sort_order || 0), 0);
    const { error: csErr } = await supabase
      .from('category_series')
      .insert({
        category_id: data.id,
        series_id: currentSeries.id,
        sort_order: maxSeriesSort + 1
      });
    if (csErr) console.warn('Could not auto-link category to current series:', csErr.message);
  }

  return data;
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder || !isDemoMode()) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Managing categories and simulator series mappings in local demo storage.
      </div>
    </div>
  `;
}

/**
 * Initialize Categories Page
 */
async function initCategories() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  if (pillContainer) pillContainer.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });

  setupModalListeners();
  setupAdminNav();
  renderDemoBanner();

  // Add Category modal trigger
  document.getElementById('btn-open-add-cat-modal')?.addEventListener('click', () => {
    document.getElementById('add-category-form').reset();
    document.getElementById('add-cat-error').style.display = 'none';
    openModal('add-category-modal');
  });

  // Section filter tabs
  document.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSectionFilter = btn.getAttribute('data-section');
      renderCategories();
    });
  });

  // Add Category Form submit
  document.getElementById('add-category-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('add-cat-error');
    const submitBtn = document.getElementById('btn-submit-add-cat');
    const btnText = document.getElementById('btn-add-cat-text');

    errorEl.style.display = 'none';

    const section = document.getElementById('new-cat-section').value;
    const name = document.getElementById('new-cat-name').value.trim();

    if (!name) {
      errorEl.textContent = 'Please enter a category name.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Adding...';

    try {
      await addCategory(name, section);
      showToast('success', `Category "${name}" added successfully.`);
      closeModal('add-category-modal');
      await loadCategories();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to add category.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Add Category';
    }
  });

  // Rename Category Form submit
  document.getElementById('rename-category-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('rename-cat-error');
    const submitBtn = document.getElementById('btn-submit-rename-cat');
    const btnText = document.getElementById('btn-rename-cat-text');

    errorEl.style.display = 'none';

    const catId = document.getElementById('rename-cat-id').value;
    const newName = document.getElementById('rename-cat-name').value.trim();

    if (!newName) {
      errorEl.textContent = 'Please enter a valid category name.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      await renameCategory(catId, newName);
      showToast('success', 'Category renamed successfully.');
      closeModal('rename-category-modal');
      await loadCategories();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to rename category.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Save Changes';
    }
  });

  // Initial load
  await loadCategories();
}

document.addEventListener('DOMContentLoaded', initCategories);
