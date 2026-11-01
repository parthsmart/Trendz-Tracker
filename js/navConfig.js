/**
 * Trendz Tracker - Single Source of Truth Navigation Configuration (js/navConfig.js)
 *
 * Phase 14d:
 * Defines every page once for 'student' and 'admin' roles:
 *   { id, label, href, group, inline, badge, action }
 * Both the >= 1100px short inline links and the three-dot menu read from this module.
 */

export const NAV_STAGE_AND_PUBLIC_ALLOWLIST = Object.freeze([
  '/index.html',
  '/pages/basics-practice.html',
  '/pages/element-drill.html',
  '/pages/memoriad-play.html',
  '/pages/student-detail.html',
]);

export const NAV_CONFIG = Object.freeze({
  student: Object.freeze([
    // Today
    Object.freeze({
      id: 'student-today',
      label: 'Today',
      href: '/pages/student.html',
      group: 'Today',
      inline: true,
    }),

    // Practice
    Object.freeze({
      id: 'student-round-scores',
      label: 'Round scores',
      href: '/pages/round-scores.html',
      group: 'Practice',
      inline: false,
    }),
    Object.freeze({
      id: 'student-basics',
      label: 'Basics',
      href: '/pages/basics.html',
      group: 'Practice',
      inline: false,
    }),
    Object.freeze({
      id: 'student-flash',
      label: 'Flash Anzan',
      href: '/pages/flash.html',
      group: 'Practice',
      inline: false,
    }),
    Object.freeze({
      id: 'student-elements',
      label: 'Elements',
      href: '/pages/elements.html',
      group: 'Practice',
      inline: false,
    }),
    Object.freeze({
      id: 'student-memoriad',
      label: 'Memoriad',
      href: '/pages/memoriad.html',
      group: 'Practice',
      inline: false,
    }),

    // Weekly Test, Leaderboard, Monthly Report, Notifications
    Object.freeze({
      id: 'student-weekly-test',
      label: 'Weekly Test',
      href: '/pages/weekly-test.html',
      group: 'Tests & Progress',
      inline: true,
    }),
    Object.freeze({
      id: 'student-leaderboard',
      label: 'Leaderboard',
      href: '/pages/leaderboard.html',
      group: 'Tests & Progress',
      inline: true,
    }),
    Object.freeze({
      id: 'student-monthly-report',
      label: 'Monthly Report',
      href: '/pages/monthly-report.html',
      group: 'Tests & Progress',
      inline: false,
    }),
    Object.freeze({
      id: 'student-notifications',
      label: 'Notifications',
      href: '/pages/notifications.html',
      group: 'Notifications',
      badge: 'notifications',
      inline: false,
    }),

    // Account & Sign out
    Object.freeze({
      id: 'student-account',
      label: 'Account',
      href: '#account',
      group: 'Account',
      action: 'account',
      inline: false,
    }),
    Object.freeze({
      id: 'student-signout',
      label: 'Sign out',
      href: '#sign-out',
      group: 'Account',
      action: 'signout',
      inline: false,
    }),
  ]),

  admin: Object.freeze([
    // Main Admin Pages (short inline list at >= 1100px: Overview, Students, Review, Weekly Tests)
    Object.freeze({
      id: 'admin-overview',
      label: 'Overview',
      href: '/pages/admin.html',
      group: 'Overview',
      inline: true,
    }),
    Object.freeze({
      id: 'admin-students',
      label: 'Students',
      href: '/pages/students.html',
      group: 'Overview',
      inline: true,
    }),
    Object.freeze({
      id: 'admin-review',
      label: 'Review',
      href: '/pages/review.html',
      group: 'Overview',
      inline: true,
    }),
    Object.freeze({
      id: 'admin-attendance',
      label: 'Attendance',
      href: '/pages/attendance.html',
      group: 'Overview',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-weekly-tests',
      label: 'Weekly Tests',
      href: '/pages/weekly-tests.html',
      group: 'Overview',
      inline: true,
    }),
    Object.freeze({
      id: 'admin-leaderboard',
      label: 'Leaderboard',
      href: '/pages/leaderboard.html',
      group: 'Overview',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-monthly-report',
      label: 'Monthly Report',
      href: '/pages/monthly-report.html',
      group: 'Overview',
      inline: false,
    }),

    // Settings Hub + All Admin Settings Pages
    Object.freeze({
      id: 'admin-settings-hub',
      label: 'Settings hub',
      href: '/pages/settings.html',
      group: 'Settings',
      inline: false,
      isHub: true,
    }),
    Object.freeze({
      id: 'admin-todos',
      label: 'Daily To-Do',
      href: '/pages/todos.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-resources',
      label: 'Resources',
      href: '/pages/resources.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-categories',
      label: 'Categories',
      href: '/pages/categories.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-rounds',
      label: 'Rounds',
      href: '/pages/rounds.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-targets',
      label: 'Targets',
      href: '/pages/targets.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-competition',
      label: 'Competition settings',
      href: '/pages/competition.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-announcements',
      label: 'Announcements',
      href: '/pages/announcements.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-reports',
      label: 'Reports',
      href: '/pages/report.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-import',
      label: 'Import',
      href: '/pages/import.html',
      group: 'Settings',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-backup',
      label: 'Backup',
      href: '/pages/backup.html',
      group: 'Settings',
      inline: false,
    }),

    // Account & Sign out
    Object.freeze({
      id: 'admin-account',
      label: 'Account',
      href: '#account',
      group: 'Account',
      action: 'account',
      inline: false,
    }),
    Object.freeze({
      id: 'admin-signout',
      label: 'Sign out',
      href: '#sign-out',
      group: 'Account',
      action: 'signout',
      inline: false,
    }),
  ]),
});

/**
 * Returns all navigation items for a given role ('student' or 'admin').
 * @param {'student' | 'admin'} role
 */
export function getRoleNavItems(role) {
  return role === 'admin' ? NAV_CONFIG.admin : NAV_CONFIG.student;
}

/**
 * Returns only the short inline navigation links shown at >= 1100px width.
 * Student: Today, Weekly Test, Leaderboard
 * Admin: Overview, Students, Review, Weekly Tests
 * @param {'student' | 'admin'} role
 */
export function getInlineNavItems(role) {
  return getRoleNavItems(role).filter((item) => Boolean(item.inline));
}

/**
 * Groups a role's navigation items by their `group` property in declaration order.
 * @param {'student' | 'admin'} role
 * @returns {Array<{ group: string, items: Array<Record<string, any>> }>}
 */
export function getGroupedNavItems(role) {
  const items = getRoleNavItems(role);
  const groups = [];
  const map = new Map();

  for (const item of items) {
    const groupName = item.group || 'Navigation';
    if (!map.has(groupName)) {
      const groupEntry = { group: groupName, items: [] };
      map.set(groupName, groupEntry);
      groups.push(groupEntry);
    }
    map.get(groupName).items.push(item);
  }

  return groups;
}

/**
 * Checks whether a navigation item matches the current location pathname.
 * @param {{ href?: string, action?: string }} item
 * @param {string} pathname
 * @returns {boolean}
 */
export function isNavItemCurrent(item, pathname) {
  if (!item || !item.href || item.href.startsWith('#') || !pathname) {
    return false;
  }
  const cleanPath = String(pathname).split('?')[0].split('#')[0];
  if (cleanPath === item.href || cleanPath.endsWith(item.href)) {
    return true;
  }
  // Treat student-detail.html as active under Students in the inline bar
  if (item.href === '/pages/students.html' && cleanPath.endsWith('/student-detail.html')) {
    return true;
  }
  return false;
}

/**
 * Extracts the first name for compact mobile header display.
 * @param {string} fullName
 * @param {string} [fallback='User']
 * @returns {string}
 */
export function formatShortFirstName(fullName, fallback = 'User') {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0] || fallback;
}
