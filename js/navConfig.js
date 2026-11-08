/**
 * Trendz Tracker - Single Source of Truth Navigation Configuration (js/navConfig.js)
 *
 * Phase 14d & 14e:
 * - Defines every page once for 'student' and 'admin' roles:
 *     { id, label, href, group, inline, desktopPlacement, badge, action, isHub }
 * - Exports the single breakpoint constant `NAV_MOBILE_BREAKPOINT_PX = 1024`
 *   matching `--nav-mobile-breakpoint: 1024px` in `css/variables.css`.
 * - Both the desktop inline links/dropdowns (>= 1024px) and the mobile three-dot
 *   menu (< 1024px) read from this module.
 */

export const NAV_MOBILE_BREAKPOINT_PX = 1024;

export const SETTINGS_SUBPAGE_PATHS = Object.freeze([
  '/pages/todos.html',
  '/pages/resources.html',
  '/pages/categories.html',
  '/pages/rounds.html',
  '/pages/targets.html',
  '/pages/competition.html',
  '/pages/announcements.html',
  '/pages/import.html',
  '/pages/backup.html',
]);

export const NAV_STAGE_AND_PUBLIC_ALLOWLIST = Object.freeze([
  '/index.html',
  '/pages/basics-practice.html',
  '/pages/element-drill.html',
  '/pages/memoriad-play.html',
  '/pages/student-detail.html',
  '/pages/report.html',
  '/pages/teacher.html',
  '/pages/teachers.html',
  ...SETTINGS_SUBPAGE_PATHS,
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
      desktopPlacement: 'inline',
    }),

    // Practice (Main Round top-level inline; Basics, Flash Anzan, Elements, Memoriad in Practice ▾ dropdown on desktop)
    Object.freeze({
      id: 'student-round-scores',
      label: 'Main Round',
      href: '/pages/round-scores.html',
      group: 'Practice',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'student-basics',
      label: 'Basics',
      href: '/pages/basics.html',
      group: 'Practice',
      inline: false,
      desktopPlacement: 'practice-dropdown',
    }),
    Object.freeze({
      id: 'student-flash',
      label: 'Flash Anzan',
      href: '/pages/flash.html',
      group: 'Practice',
      inline: false,
      desktopPlacement: 'practice-dropdown',
    }),
    Object.freeze({
      id: 'student-elements',
      label: 'Elements',
      href: '/pages/elements.html',
      group: 'Practice',
      inline: false,
      desktopPlacement: 'practice-dropdown',
    }),
    Object.freeze({
      id: 'student-memoriad',
      label: 'Memoriad',
      href: '/pages/memoriad.html',
      group: 'Practice',
      inline: false,
      desktopPlacement: 'practice-dropdown',
    }),

    // Weekly Test, Leaderboard, Monthly Report, Notifications
    Object.freeze({
      id: 'student-weekly-test',
      label: 'Weekly Test',
      href: '/pages/weekly-test.html',
      group: 'Tests & Progress',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'student-leaderboard',
      label: 'Leaderboard',
      href: '/pages/leaderboard.html',
      group: 'Tests & Progress',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'student-monthly-report',
      label: 'Monthly Report',
      href: '/pages/monthly-report.html',
      group: 'Tests & Progress',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'student-notifications',
      label: 'Notifications',
      href: '/pages/notifications.html',
      group: 'Notifications',
      badge: 'notifications',
      inline: false,
      desktopPlacement: 'bell',
    }),

    // Account & Sign out (in right-side actions on desktop, and in the mobile menu)
    Object.freeze({
      id: 'student-account',
      label: 'Account',
      href: '#account',
      group: 'Account',
      action: 'account',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
    Object.freeze({
      id: 'student-signout',
      label: 'Sign out',
      href: '#sign-out',
      group: 'Account',
      action: 'signout',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
  ]),

  admin: Object.freeze([
    // Main Admin Pages in pre-14d desktop order:
    // Overview, Review, Students, Attendance, Weekly Tests, Leaderboard, Monthly Report
    Object.freeze({
      id: 'admin-overview',
      label: 'Overview',
      href: '/pages/admin.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-review',
      label: 'Review',
      href: '/pages/review.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-students',
      label: 'Students',
      href: '/pages/students.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-attendance',
      label: 'Attendance',
      href: '/pages/attendance.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-weekly-tests',
      label: 'Weekly Tests',
      href: '/pages/weekly-tests.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-leaderboard',
      label: 'Leaderboard',
      href: '/pages/leaderboard.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),
    Object.freeze({
      id: 'admin-monthly-report',
      label: 'Monthly Report',
      href: '/pages/monthly-report.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),

    // Settings Hub: direct top-level link (replaces Setup dropdown)
    Object.freeze({
      id: 'admin-settings',
      label: 'Settings',
      href: '/pages/settings.html',
      group: 'Settings',
      inline: true,
      desktopPlacement: 'inline',
      isHub: true,
    }),

    // Account & Sign out
    Object.freeze({
      id: 'admin-account',
      label: 'Account',
      href: '#account',
      group: 'Account',
      action: 'account',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
    Object.freeze({
      id: 'admin-signout',
      label: 'Sign out',
      href: '#sign-out',
      group: 'Account',
      action: 'signout',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
  ]),

  teacher: Object.freeze([
    // Overview (inline)
    Object.freeze({
      id: 'teacher-overview',
      label: 'Overview',
      href: '/pages/teacher.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
    }),

    // My Students (inline, permission: can_view_students)
    Object.freeze({
      id: 'teacher-students',
      label: 'My Students',
      href: '/pages/students.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_view_students',
    }),

    // Attendance (inline, permission: can_mark_attendance)
    Object.freeze({
      id: 'teacher-attendance',
      label: 'Attendance',
      href: '/pages/attendance.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_mark_attendance',
    }),

    // Tasks (inline, permission: can_manage_tasks)
    Object.freeze({
      id: 'teacher-todos',
      label: 'Tasks',
      href: '/pages/todos.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_manage_tasks',
    }),

    // Weekly Tests (inline, permission: can_manage_tests)
    Object.freeze({
      id: 'teacher-weekly-tests',
      label: 'Weekly Tests',
      href: '/pages/weekly-tests.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_manage_tests',
    }),

    // Review (inline, permission: can_review_scores)
    Object.freeze({
      id: 'teacher-review',
      label: 'Review',
      href: '/pages/review.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_review_scores',
    }),

    // Monthly Reports (inline, permission: can_generate_reports)
    Object.freeze({
      id: 'teacher-monthly-report',
      label: 'Monthly Reports',
      href: '/pages/monthly-report.html',
      group: 'Overview',
      inline: true,
      desktopPlacement: 'inline',
      permission: 'can_generate_reports',
    }),

    // Class Content (Announcements & Resources in dropdown)
    Object.freeze({
      id: 'teacher-announcements',
      label: 'Announcements',
      href: '/pages/announcements.html',
      group: 'Class Content',
      inline: false,
      desktopPlacement: 'content-dropdown',
      permission: 'can_publish_announcements',
    }),
    Object.freeze({
      id: 'teacher-resources',
      label: 'Resources',
      href: '/pages/resources.html',
      group: 'Class Content',
      inline: false,
      desktopPlacement: 'content-dropdown',
      permission: 'can_manage_resources',
    }),

    // Account & Sign out
    Object.freeze({
      id: 'teacher-account',
      label: 'Account',
      href: '#account',
      group: 'Account',
      action: 'account',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
    Object.freeze({
      id: 'teacher-signout',
      label: 'Sign out',
      href: '#sign-out',
      group: 'Account',
      action: 'signout',
      inline: false,
      desktopPlacement: 'menu-only',
    }),
  ]),
});

/**
 * Returns all navigation items for a given role ('student', 'teacher', or 'admin').
 * Filters items if permissions object is passed for a teacher.
 * @param {'student' | 'teacher' | 'admin'} role
 * @param {Record<string, boolean> | null} [permissions=null]
 */
export function getRoleNavItems(role, permissions = null) {
  let items = NAV_CONFIG.student;
  if (role === 'admin') {
    items = NAV_CONFIG.admin;
  } else if (role === 'teacher') {
    items = NAV_CONFIG.teacher;
  }

  if (role === 'teacher' && permissions) {
    return items.filter((item) => {
      if (!item.permission) return true;
      return permissions[item.permission] !== false;
    });
  }
  return items;
}

/**
 * Returns the top-level inline navigation links shown on desktop (>= 1024px).
 * Student: Today, Main Round, Weekly Test, Leaderboard, Monthly Report
 * Admin: Overview, Review, Students, Attendance, Weekly Tests, Leaderboard, Monthly Report, Settings
 * Teacher: Overview, My Students, Attendance, Tasks, Weekly Tests, Review, Monthly Reports
 * @param {'student' | 'teacher' | 'admin'} role
 * @param {Record<string, boolean> | null} [permissions=null]
 */
export function getInlineNavItems(role, permissions = null) {
  return getRoleNavItems(role, permissions).filter((item) => item.desktopPlacement === 'inline');
}

/**
 * Returns the ordered desktop navigation entries (inline links, dropdowns, and notification bell)
 * derived strictly from `NAV_CONFIG` so desktop and mobile share one source of truth.
 *
 * Student desktop layout:
 *   Today, Main Round, Practice ▾ (Basics, Flash Anzan, Elements, Memoriad),
 *   Weekly Test, Leaderboard, Monthly Report, Notifications bell
 *
 * Admin desktop layout:
 *   Overview, Review, Students, Attendance, Weekly Tests, Leaderboard, Monthly Report, Settings
 *
 * Teacher desktop layout:
 *   Overview, My Students, Attendance, Tasks, Weekly Tests, Review, Monthly Reports,
 *   Class Content ▾ (Announcements, Resources)
 *
 * @param {'student' | 'teacher' | 'admin'} role
 * @param {Record<string, boolean> | null} [permissions=null]
 * @returns {Array<
 *   | { type: 'link', item: Record<string, any> }
 *   | { type: 'dropdown', id: string, toggleId: string, menuId: string, label: string, items: Array<Record<string, any>> }
 *   | { type: 'bell', item: Record<string, any> }
 * >}
 */
export function getDesktopNavEntries(role, permissions = null) {
  const items = getRoleNavItems(role, permissions);
  const entries = [];
  let practiceDropdownAdded = false;
  let setupDropdownAdded = false;
  let contentDropdownAdded = false;

  for (const item of items) {
    if (item.desktopPlacement === 'inline') {
      entries.push({ type: 'link', item });
    } else if (item.desktopPlacement === 'practice-dropdown') {
      if (!practiceDropdownAdded) {
        practiceDropdownAdded = true;
        const dropdownItems = items.filter((i) => i.desktopPlacement === 'practice-dropdown');
        if (dropdownItems.length > 0) {
          entries.push({
            type: 'dropdown',
            id: 'nav-practice-dropdown',
            toggleId: 'btn-nav-practice-dropdown',
            menuId: 'nav-practice-dropdown-menu',
            label: 'Practice',
            items: dropdownItems,
          });
        }
      }
    } else if (item.desktopPlacement === 'content-dropdown') {
      if (!contentDropdownAdded) {
        contentDropdownAdded = true;
        const dropdownItems = items.filter((i) => i.desktopPlacement === 'content-dropdown');
        if (dropdownItems.length > 0) {
          entries.push({
            type: 'dropdown',
            id: 'nav-content-dropdown',
            toggleId: 'btn-nav-content-dropdown',
            menuId: 'nav-content-dropdown-menu',
            label: 'Class Content',
            items: dropdownItems,
          });
        }
      }
    } else if (item.desktopPlacement === 'setup-dropdown') {
      if (!setupDropdownAdded) {
        setupDropdownAdded = true;
        const dropdownItems = items.filter((i) => i.desktopPlacement === 'setup-dropdown');
        if (dropdownItems.length > 0) {
          entries.push({
            type: 'dropdown',
            id: 'nav-setup-dropdown',
            toggleId: 'btn-nav-setup-dropdown',
            menuId: 'nav-setup-dropdown-menu',
            label: 'Setup',
            items: dropdownItems,
          });
        }
      }
    } else if (item.desktopPlacement === 'bell') {
      entries.push({ type: 'bell', item });
    }
  }

  return entries;
}

/**
 * Groups a role's navigation items by their `group` property in declaration order
 * for the mobile (< 1024px) three-dot menu.
 * @param {'student' | 'teacher' | 'admin'} role
 * @param {Record<string, boolean> | null} [permissions=null]
 * @returns {Array<{ group: string, items: Array<Record<string, any>> }>}
 */
export function getGroupedNavItems(role, permissions = null) {
  const items = getRoleNavItems(role, permissions);
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
  // Treat Settings subpages as active under Settings in both desktop and mobile nav
  if (
    item.href === '/pages/settings.html' &&
    SETTINGS_SUBPAGE_PATHS.some((subPath) => cleanPath === subPath || cleanPath.endsWith(subPath))
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts the first name for compact header display.
 * @param {string} fullName
 * @param {string} [fallback='User']
 * @returns {string}
 */
export function formatShortFirstName(fullName, fallback = 'User') {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0] || fallback;
}
