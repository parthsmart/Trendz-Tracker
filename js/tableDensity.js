/**
 * Trendz Tracker — Admin Table Compact Density Toggle (js/tableDensity.js)
 *
 * Phase 14b Calmer UI:
 * - Remembers the admin's table density preference (`'compact'` vs `'comfortable'`) in `localStorage`
 *   wrapped inside `try/catch`.
 * - Applies `.table-compact` (`8px` vertical padding instead of `12px`) to `.table` and `.data-table` elements.
 */

export const TABLE_DENSITY_STORAGE_KEY = 'tt_table_density_compact';

/**
 * Reads the saved compact density boolean from storage (`localStorage` by default), wrapped in `try/catch`.
 *
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function getTableDensity(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return false;
    return storage.getItem(TABLE_DENSITY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Saves the compact density boolean to storage (`localStorage` by default), wrapped in `try/catch`.
 *
 * @param {boolean} isCompact
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function setTableDensity(
  isCompact,
  storage = typeof localStorage !== 'undefined' ? localStorage : null
) {
  const normalized = Boolean(isCompact);
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(TABLE_DENSITY_STORAGE_KEY, normalized ? '1' : '0');
    }
  } catch {
    // Ignore storage quota or privacy mode errors
  }
  return normalized;
}

/**
 * Applies `.table-compact` to all `.table` and `.data-table` elements on the page
 * and updates any `.table-density-btn` toggle buttons.
 *
 * @param {boolean} isCompact
 * @param {Document|HTMLElement} [root=document]
 */
export function applyTableDensityToDom(isCompact, root = typeof document !== 'undefined' ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const compact = Boolean(isCompact);

  root.querySelectorAll('.table, .data-table').forEach((tbl) => {
    tbl.classList.toggle('table-compact', compact);
  });

  root.querySelectorAll('.table-density-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
    btn.textContent = compact ? 'Compact: On' : 'Compact';
  });
}

/**
 * Initializes the Compact density toggle on admin tables.
 * Automatically injects a quiet "Compact" toggle button into `.table-toolbar` or `.card-header`
 * above admin tables if one is not already present.
 */
export function initTableDensityToggle() {
  if (typeof document === 'undefined') return;

  const initialCompact = getTableDensity();
  applyTableDensityToDom(initialCompact, document);

  const tables = Array.from(document.querySelectorAll('.table, .data-table'));
  if (tables.length === 0) return;

  // Attach listeners to any existing .table-density-btn elements
  document.querySelectorAll('.table-density-btn').forEach((btn) => {
    if (btn.dataset.densityBound === '1') return;
    btn.dataset.densityBound = '1';
    btn.addEventListener('click', () => {
      const next = !getTableDensity();
      setTableDensity(next);
      applyTableDensityToDom(next, document);
    });
  });

  // Ensure the primary table card has a Compact toggle button in its toolbar or card-header
  if (document.querySelector('.table-density-btn')) {
    applyTableDensityToDom(initialCompact, document);
    return;
  }

  const firstTable = tables[0];
  const card = firstTable.closest('.card') || firstTable.parentElement;
  const hostBar =
    card?.querySelector('.table-toolbar') ||
    card?.querySelector('.card-header') ||
    document.querySelector('.table-toolbar');

  if (hostBar && !hostBar.querySelector('.table-density-btn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'table-density-btn';
    btn.setAttribute('aria-pressed', initialCompact ? 'true' : 'false');
    btn.title = 'Toggle compact table row spacing';
    btn.textContent = initialCompact ? 'Compact: On' : 'Compact';
    btn.dataset.densityBound = '1';
    btn.addEventListener('click', () => {
      const next = !getTableDensity();
      setTableDensity(next);
      applyTableDensityToDom(next, document);
    });
    hostBar.appendChild(btn);
  }
}
