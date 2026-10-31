/**
 * Trendz Tracker — Admin Settings Hub Controller (js/settings.js)
 *
 * Phase 14b Calmer UI:
 * - Admin-only route guard (`requireAuth(['admin'])`)
 * - Left category list on desktop + `<select>` on narrow screens
 * - Search box filtering entries live across Practice, Competition, Communication, and Data
 */

import { requireAuth } from './guard.js';
import { isDemoMode } from './demoDb.js';
import { setupAdminNav, setupModalListeners } from './modal.js';
import { SETTINGS_GROUPS, SETTINGS_ENTRIES, filterSettingsEntries } from './settingsHub.js';

let activeGroup = 'all';
let searchQuery = '';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderGroupNavigation() {
  const navList = document.getElementById('settings-group-list');
  const navSelect = document.getElementById('settings-group-select');

  if (navList) {
    navList.innerHTML = SETTINGS_GROUPS.map((g) => {
      const count =
        g.id === 'all'
          ? SETTINGS_ENTRIES.length
          : SETTINGS_ENTRIES.filter((e) => e.group === g.id).length;
      const isActive = g.id === activeGroup;
      return `
        <button
          type="button"
          class="settings-nav-btn ${isActive ? 'active' : ''}"
          data-group="${escapeHtml(g.id)}"
          aria-current="${isActive ? 'true' : 'false'}"
        >
          <span>${escapeHtml(g.label)}</span>
          <span class="badge badge-neutral num">${count}</span>
        </button>
      `;
    }).join('');

    navList.querySelectorAll('.settings-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeGroup = btn.getAttribute('data-group') || 'all';
        if (navSelect) navSelect.value = activeGroup;
        renderGroupNavigation();
        renderSettingsEntries();
      });
    });
  }

  if (navSelect && navSelect.options.length === 0) {
    navSelect.innerHTML = SETTINGS_GROUPS.map(
      (g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`
    ).join('');
  }
  if (navSelect) {
    navSelect.value = activeGroup;
  }
}

function renderSettingsEntries() {
  const container = document.getElementById('settings-entries-container');
  if (!container) return;

  const filtered = filterSettingsEntries(SETTINGS_ENTRIES, searchQuery, activeGroup);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <div class="empty-state-title">No matching settings found</div>
          <p class="empty-state-desc">Try clearing the search box or switching to All settings.</p>
        </div>
      </div>
    `;
    return;
  }

  const groupsOrder = SETTINGS_GROUPS.filter((g) => g.id !== 'all');
  const html = groupsOrder
    .map((groupObj) => {
      const items = filtered.filter((item) => item.group === groupObj.id);
      if (items.length === 0) return '';

      return `
        <section class="settings-group-section" aria-labelledby="settings-heading-${escapeHtml(groupObj.id)}">
          <h2 id="settings-heading-${escapeHtml(groupObj.id)}" class="settings-group-title">
            ${escapeHtml(groupObj.label)}
          </h2>
          <div class="settings-entries-list">
            ${items
              .map(
                (item) => `
                  <a href="${escapeHtml(item.href)}" class="settings-entry-link">
                    <div>
                      <div class="settings-entry-title">${escapeHtml(item.title)}</div>
                      <div class="settings-entry-desc">${escapeHtml(item.description)}</div>
                    </div>
                    <span aria-hidden="true" style="color: var(--color-primary); font-weight: 600;">Open &rarr;</span>
                  </a>
                `
              )
              .join('')}
          </div>
        </section>
      `;
    })
    .filter(Boolean)
    .join('');

  container.innerHTML = html;
}

async function initSettingsPage() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'Teacher';
  if (pillContainer) pillContainer.style.display = 'flex';

  if (isDemoMode()) {
    const placeholder = document.getElementById('config-banner-placeholder');
    if (placeholder) {
      placeholder.innerHTML = `
        <div class="banner banner-warning" role="alert">
          <div><strong>Demo mode — data is fake:</strong> Exploring Settings in local preview mode.</div>
        </div>
      `;
    }
  }

  setupModalListeners();
  setupAdminNav();

  renderGroupNavigation();
  renderSettingsEntries();

  const searchInput = document.getElementById('settings-search-input');
  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderSettingsEntries();
  });

  const groupSelect = document.getElementById('settings-group-select');
  groupSelect?.addEventListener('change', (e) => {
    activeGroup = e.target.value || 'all';
    renderGroupNavigation();
    renderSettingsEntries();
  });
}

document.addEventListener('DOMContentLoaded', initSettingsPage);
