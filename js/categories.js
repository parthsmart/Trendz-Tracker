/**
 * Trendz Tracker - Admin Categories Management
 * Grouped listing, adding, renaming, reordering, and deactivating categories.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupModalListeners } from './modal.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';

let allCategories = [];
let activeSectionFilter = 'all';

const SECTION_CONFIG = {
  round: { title: 'Championship Round Categories', icon: '🏆', description: 'Official Junior Mental Calculation World Championship round disciplines.' },
  basics: { title: 'Basics Drills (Digits & Rows)', icon: '⚡', description: 'Mental calculation daily speed drills (e.g. 1d4r, 2d2r).' },
  elements: { title: 'Elements', icon: '🧩', description: 'Building-block calculation exercises.' },
  flash: { title: 'Flash Anzan', icon: '⏱️', description: 'Rapid flashing mental calculation drills.' },
};

/**
 * Fetch categories from Supabase or DemoDB
 */
async function loadCategories() {
  const container = document.getElementById('categories-container');
  const countDisplay = document.getElementById('cat-count-display');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .order('section')
        .order('sort_order', { ascending: true });

      if (error) throw new Error(error.message);
      allCategories = data || [];
    } else {
      allCategories = DemoDB.getCategories();
    }

    if (countDisplay) {
      countDisplay.textContent = `${allCategories.length} total categories`;
    }

    renderCategories();
  } catch (err) {
    console.error('Error loading categories:', err);
    showToast('error', 'Failed to load categories: ' + err.message);
    container.innerHTML = `
      <div class="banner banner-error">
        Error loading categories: ${escapeHtml(err.message)}
      </div>
    `;
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
    const meta = SECTION_CONFIG[sectionKey];
    const items = allCategories
      .filter(c => c.section === sectionKey)
      .sort((a, b) => a.sort_order - b.sort_order);

    html += `
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
                  data-id="${cat.id}"
                  data-section="${cat.section}"
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
                  data-id="${cat.id}"
                  data-section="${cat.section}"
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
                  data-id="${cat.id}"
                  data-name="${escapeHtml(cat.name)}"
                  title="Rename category"
                >
                  Rename
                </button>
                <button
                  type="button"
                  class="btn ${cat.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-active"
                  data-id="${cat.id}"
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
  });

  container.innerHTML = html;
  attachCategoryActionListeners();
}

/**
 * Attach button click handlers for reordering, renaming, and active toggling
 */
function attachCategoryActionListeners() {
  // Reordering
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
 * Reorder category up or down within its section
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

  // Swap sort_order
  const currentSort = currentItem.sort_order;
  const targetSort = targetItem.sort_order;

  // Update both in Supabase
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
 * Add a new category
 */
async function addCategory(name, section) {
  if (!isSupabaseConfigured()) {
    return DemoDB.addCategory({ name, section });
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
  return data;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

/**
 * Initialize Categories Page
 */
async function initCategories() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();

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
