/**
 * Teacher / admin visual touches (js/staffUi.js). Visual only: adds small decorations to
 * content the page scripts render, and keeps adding them as tables and lists re-render.
 *  - student name links in tables get an initial avatar
 *  - destructive row buttons (Deactivate, Delete, Remove) get a red style; Activate gets green
 *  - Settings entries get an icon tile
 */

export const STAFF_PAGE_ICONS = Object.freeze({
  'todos.html': '☑️', 'targets.html': '🎯', 'categories.html': '🗂️', 'resources.html': '📁',
  'homework.html': '📚', 'student-access.html': '🔐', 'competition.html': '🏁', 'rounds.html': '🔁',
  'live-classes.html': '🎥', 'announcements.html': '📣', 'monthly-report.html': '📊', 'teachers.html': '🧑‍🏫',
  'import.html': '📥', 'backup.html': '💾', 'notifications.html': '🔔',
});

const DANGER = /^(deactivate|delete|remove|reject|unassign|revoke)\b/i;
const POSITIVE = /^(activate|restore|verify|✓ verify)\b/i;

/** First letter of a display name, for the avatar. Exported for tests. */
export function initialFor(name) {
  const clean = String(name || '').replace(/\(.*?\)/g, '').trim();
  return (clean.match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase();
}

function decorate(root) {
  root.querySelectorAll('td .student-name-link:not([data-sf-av])').forEach((a) => {
    a.dataset.sfAv = '1';
    a.insertAdjacentHTML('afterbegin', `<span class="sf-av" aria-hidden="true">${initialFor(a.textContent)}</span>`);
  });
  root.querySelectorAll('button.btn:not([data-sf-tone])').forEach((b) => {
    const t = b.textContent.trim();
    b.dataset.sfTone = DANGER.test(t) ? 'danger' : POSITIVE.test(t) ? 'positive' : '';
  });
  root.querySelectorAll('.settings-entry-link:not([data-sf-ic])').forEach((a) => {
    a.dataset.sfIc = '1';
    const icon = STAFF_PAGE_ICONS[(a.getAttribute('href') || '').split('/').pop()] || '⚙️';
    a.insertAdjacentHTML('afterbegin', `<span class="sf-entry-ic" aria-hidden="true">${icon}</span>`);
  });
}

/** Decorates the page now and whenever its content changes. Safe to call more than once. */
export function enhanceStaffUi() {
  if (typeof document === 'undefined') return;
  const main = document.querySelector('.main-content') || document.body;
  if (main.dataset.sfUi) return;
  main.dataset.sfUi = '1';
  decorate(main);
  if (typeof MutationObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; decorate(main); });
  }).observe(main, { childList: true, subtree: true });
}
