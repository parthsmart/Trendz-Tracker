/**
 * Trendz Tracker — Admin Settings Hub Pure Data & Filtering Helpers (js/settingsHub.js)
 *
 * Phase 14b Calmer UI:
 * Groups existing administrative setup and utility pages under `/pages/settings.html`:
 * - Practice: Daily To-Do, Targets, Categories, Resources
 * - Competition: Competition settings (plus Student rounds)
 * - Communication: Announcements, Reports
 * - Data: Import, Backup
 */

export const SETTINGS_GROUPS = Object.freeze([
  { id: 'all', label: 'All settings' },
  { id: 'practice', label: 'Practice' },
  { id: 'competition', label: 'Competition' },
  { id: 'communication', label: 'Communication' },
  { id: 'data', label: 'Data' },
]);

export const SETTINGS_ENTRIES = Object.freeze([
  // Practice
  {
    id: 'todos',
    group: 'practice',
    groupLabel: 'Practice',
    title: 'Daily To-Do',
    breadcrumbTitle: 'Daily To-Do',
    href: '/pages/todos.html',
    description: 'Configure daily practice tasks, required counts, and Flash Anzan settings.',
  },
  {
    id: 'targets',
    group: 'practice',
    groupLabel: 'Practice',
    title: 'Targets',
    breadcrumbTitle: 'Targets',
    href: '/pages/targets.html',
    description: 'Set minimum accuracy, speed, and time benchmarks for Basics categories.',
  },
  {
    id: 'categories',
    group: 'practice',
    groupLabel: 'Practice',
    title: 'Categories',
    breadcrumbTitle: 'Categories',
    href: '/pages/categories.html',
    description: 'Order and activate or deactivate competition rounds and speed drill categories.',
  },
  {
    id: 'resources',
    group: 'practice',
    groupLabel: 'Practice',
    title: 'Resources',
    breadcrumbTitle: 'Resources',
    href: '/pages/resources.html',
    description: 'Manage reference sheets, formula guides, and practice links for students.',
  },

  // Competition
  {
    id: 'competition',
    group: 'competition',
    groupLabel: 'Competition',
    title: 'Competition settings',
    breadcrumbTitle: 'Competition settings',
    href: '/pages/competition.html',
    description: 'Set streak rules, global leaderboard visibility, and Memoriad time limits.',
  },
  {
    id: 'rounds',
    group: 'competition',
    groupLabel: 'Competition',
    title: 'Student rounds',
    breadcrumbTitle: 'Rounds',
    href: '/pages/rounds.html',
    description: 'Create and edit per-student practice rounds across simulator series.',
  },

  // Communication
  {
    id: 'announcements',
    group: 'communication',
    groupLabel: 'Communication',
    title: 'Announcements',
    breadcrumbTitle: 'Announcements',
    href: '/pages/announcements.html',
    description: 'Post student announcements and share upcoming weekly test reminders.',
  },
  {
    id: 'reports',
    group: 'communication',
    groupLabel: 'Communication',
    title: 'Reports',
    breadcrumbTitle: 'Reports',
    href: '/pages/monthly-report.html',
    description: 'Generate printable monthly student progress reports and WhatsApp summaries.',
  },

  // Data & Administration
  {
    id: 'teachers',
    group: 'data',
    groupLabel: 'Data',
    title: 'Teacher management',
    breadcrumbTitle: 'Teachers',
    href: '/pages/teachers.html',
    description: 'Create teachers, assign students, and configure granular permissions.',
  },

  // Data
  {
    id: 'import',
    group: 'data',
    groupLabel: 'Data',
    title: 'Import',
    breadcrumbTitle: 'Import',
    href: '/pages/import.html',
    description: 'Preview and import historical student score sheets from CSV files.',
  },
  {
    id: 'backup',
    group: 'data',
    groupLabel: 'Data',
    title: 'Backup',
    breadcrumbTitle: 'Backup',
    href: '/pages/backup.html',
    description: 'Download JSON data snapshots and inspect nightly backup history.',
  },
]);

/**
 * Filters settings hub entries by group (`'all'` or group ID) and case-insensitive search query.
 *
 * @param {Array<object>} [entries=SETTINGS_ENTRIES]
 * @param {string} [query='']
 * @param {string} [group='all']
 * @returns {Array<object>}
 */
export function filterSettingsEntries(entries = SETTINGS_ENTRIES, query = '', group = 'all') {
  const safeEntries = Array.isArray(entries) ? entries : SETTINGS_ENTRIES;
  const cleanGroup = typeof group === 'string' && group.trim() ? group.trim().toLowerCase() : 'all';
  const cleanQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';

  return safeEntries.filter((entry) => {
    if (!entry) return false;
    if (cleanGroup !== 'all' && String(entry.group || '').toLowerCase() !== cleanGroup) {
      return false;
    }
    if (!cleanQuery) return true;

    const haystack = `${entry.title || ''} ${entry.description || ''} ${entry.groupLabel || ''}`.toLowerCase();
    return haystack.includes(cleanQuery);
  });
}

/**
 * Returns breadcrumb metadata (`{ title, breadcrumbTitle, group, href }`) if `pathname` matches a Settings sub-page.
 *
 * @param {string} pathname
 * @returns {object|null}
 */
export function getSettingsBreadcrumb(pathname) {
  if (typeof pathname !== 'string' || !pathname.trim()) return null;
  const cleanPath = pathname.split('?')[0].split('#')[0].trim();

  // /pages/monthly-report.html is a top-level navigation item, not a Settings subpage
  if (cleanPath.endsWith('/monthly-report.html')) return null;

  const match = SETTINGS_ENTRIES.find((entry) => cleanPath.endsWith(entry.href));
  return match || null;
}
