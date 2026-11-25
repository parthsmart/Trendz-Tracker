/**
 * Trendz Tracker - Teacher / admin Home header (js/staffHome.js)
 *
 * Fills the greeting in the .sf-hero header and hides quick-action tiles a teacher
 * has no permission for (tiles carry data-perm="can_..."). The linked pages keep
 * their own requireAuth checks; this only avoids showing dead ends.
 */

/** Greeting by hour in India Standard Time. Exported for tests. */
export function greetingFor(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(date)
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** First name without role suffixes such as "(Admin)". Exported for tests. */
export function staffFirstName(fullName, fallback = 'there') {
  const clean = String(fullName || '').replace(/\(.*?\)/g, '').trim();
  return clean.split(/\s+/)[0] || fallback;
}

/**
 * @param {{ full_name?: string, role?: string, permissions?: Record<string, boolean> } | null} profile
 */
export function renderStaffHome(profile) {
  if (typeof document === 'undefined' || !profile) return;
  document.querySelectorAll('[data-staff-greeting]').forEach((el) => { el.textContent = greetingFor(); });
  document.querySelectorAll('[data-staff-first-name]').forEach((el) => { el.textContent = staffFirstName(profile.full_name); });

  const perms = profile.role === 'teacher' ? profile.permissions || null : null;
  document.querySelectorAll('.sf-quick').forEach((quick) => {
    let shown = 0;
    quick.querySelectorAll('.sf-tile').forEach((tile) => {
      const perm = tile.getAttribute('data-perm');
      const roles = (tile.getAttribute('data-roles') || '').split(',').filter(Boolean);
      const hidden = (perm && perms && perms[perm] === false) || (roles.length && !roles.includes(profile.role));
      tile.hidden = Boolean(hidden);
      if (!hidden) shown += 1;
    });
    quick.hidden = shown === 0;
  });
}
