/**
 * Trendz Tracker - child-safe social: pure view helpers (js/socialView.js)
 *
 * Used by the Friends page, the dashboard "My class" card and the staff
 * Community page. No free text anywhere: reactions and report reasons are the
 * same fixed lists the database checks (social migration).
 */

export const REACTIONS = Object.freeze([
  { key: 'clap', emoji: '👏', label: 'Clap' },
  { key: 'fire', emoji: '🔥', label: 'Fire' },
  { key: 'gg', emoji: 'GG', label: 'Good game' },
  { key: 'star', emoji: '⭐', label: 'Star' },
  { key: 'muscle', emoji: '💪', label: 'Strong' },
  { key: 'party', emoji: '🎉', label: 'Party' },
]);

export const REPORT_REASONS = Object.freeze([
  { key: 'unkind', label: 'Unkind' },
  { key: 'uncomfortable', label: 'Made me uncomfortable' },
  { key: 'spam', label: 'Too many / spam' },
  { key: 'other', label: 'Something else' },
]);

const CODE_MESSAGES = {
  UNAVAILABLE: 'That classmate is not available.',
  DISABLED: 'Friends are switched off at your centre.',
  ALREADY_FRIENDS: 'You are already friends.',
  PENDING: 'There is already a request waiting.',
  TOO_SOON: 'Please wait a few days before asking again.',
  TOO_MANY_PENDING: 'You have 5 requests waiting. Wait for some answers first.',
  SLOW_DOWN: 'Slow down a little and try again soon.',
  NOT_ALLOWED: 'That is not allowed.',
  NOT_FOUND: 'That is no longer waiting.',
  BAD_REACTION: 'That reaction is not available.',
  BAD_INPUT: 'Please choose one of the options.',
  NOT_STUDENT: 'Only students can do this.',
};

export function socialMessage(code) {
  return CODE_MESSAGES[code] || 'Something went wrong. Please try again.';
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** One positive line for a feed item. Never shows numbers other than a level name. */
export function feedItemText(item) {
  const name = item?.name || 'A classmate';
  const p = item?.payload || {};
  switch (item?.kind) {
    case 'level_up': return { icon: '🎓', text: `${name} reached ${p.level || 'a new level'}!` };
    case 'badge': return { icon: p.icon || '🏅', text: `${name} earned the “${p.name || 'new'}” badge!` };
    case 'personal_best': return { icon: '📈', text: `${name} set a new personal best${p.label ? ` in ${p.label}` : ''}!` };
    case 'batch_goal': return { icon: p.icon || '🏆', text: p.title || 'Your batch reached a goal!' };
    default: return { icon: '✨', text: `${name} did something great!` };
  }
}

export function timeAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Preset reaction buttons with counts. Disabled when reactions are off. */
export function reactionBarHtml(kind, targetId, reactions = {}, { enabled = true } = {}) {
  const counts = reactions?.counts || {};
  const mine = new Set(reactions?.mine || []);
  return `<div class="sc-react" role="group" aria-label="Reactions">${REACTIONS.map((r) => {
    const n = Number(counts[r.key] || 0);
    const on = mine.has(r.key);
    return `<button type="button" class="sc-react-btn${on ? ' is-on' : ''}" data-react="${r.key}" data-kind="${esc(kind)}" data-target="${esc(targetId)}"
      aria-pressed="${on}" aria-label="${esc(r.label)}${n ? ` (${n})` : ''}"${enabled ? '' : ' disabled'}><span aria-hidden="true">${r.emoji}</span>${n ? `<b>${n}</b>` : ''}</button>`;
  }).join('')}</div>`;
}

export function feedItemHtml(item, { reactionsEnabled = true, avatarUrl = null, showReport = true, now = Date.now() } = {}) {
  const { icon, text } = feedItemText(item);
  const avatar = avatarUrl
    ? `<img class="sc-av" src="${esc(avatarUrl)}" alt="" width="32" height="32" />`
    : `<span class="sc-av sc-av-icon" aria-hidden="true">${esc(icon)}</span>`;
  const report = showReport && !item.mine && item.student_id
    ? `<button type="button" class="sc-link" data-report-item="${esc(item.id)}" data-student="${esc(item.student_id)}">Report</button>` : '';
  return `<li class="sc-item" data-item="${esc(item.id)}">
    ${avatar}
    <div class="sc-body"><p class="sc-text">${esc(text)}</p>
      <p class="sc-meta">${esc(timeAgo(item.created_at, now))}${item.level ? ` · ${esc(item.level)}` : ''} ${report}</p>
      ${reactionBarHtml('feed', item.id, item.reactions, { enabled: reactionsEnabled && !item.mine })}
    </div></li>`;
}

export function requestLabel(req) {
  if (req.direction === 'in' && req.status === 'pending_student') return 'wants to be friends';
  if (req.direction === 'out' && req.status === 'pending_student') return 'waiting for them to say yes';
  if (req.status === 'pending_staff') return 'waiting for your teacher to approve';
  return '';
}

/** Splits social_home().requests for the page. */
export function splitRequests(requests = []) {
  return {
    incoming: requests.filter((r) => r.direction === 'in' && r.status === 'pending_student'),
    waiting: requests.filter((r) => !(r.direction === 'in' && r.status === 'pending_student')),
  };
}

/** Classmates matching a search, own level first (the database already sorts that way). */
export function filterClassmates(classmates = [], query = '') {
  const q = String(query).trim().toLowerCase();
  return q ? classmates.filter((c) => String(c.name || '').toLowerCase().includes(q)) : classmates;
}

export const REPORT_STATUS_LABEL = { open: 'Open', reviewed: 'Reviewed', actioned: 'Action taken' };
export const REQUEST_REASON_LABEL = Object.fromEntries(REPORT_REASONS.map((r) => [r.key, r.label]));

export const SOCIAL_CSS = `
.sc-card{background:var(--color-surface,#fff);border:1px solid var(--border-color,#e2e8f0);border-radius:14px;padding:16px;margin-bottom:16px}
.sc-card h2{font-size:var(--text-base,1rem);margin:0 0 10px;display:flex;align-items:center;gap:8px;justify-content:space-between}
.sc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.sc-item{display:flex;gap:10px;align-items:flex-start}
.sc-av{width:32px;height:32px;border-radius:50%;flex:none;object-fit:cover;background:#eef2ff;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
.sc-body{flex:1;min-width:0}
.sc-text{margin:0;font-weight:600;font-size:var(--text-sm,.9rem)}
.sc-meta{margin:2px 0 4px;color:var(--text-muted,#64748b);font-size:var(--text-xs,.75rem)}
.sc-react{display:flex;flex-wrap:wrap;gap:4px}
.sc-react-btn{border:1px solid var(--border-color,#e2e8f0);background:transparent;border-radius:999px;padding:2px 8px;font-size:13px;cursor:pointer;display:inline-flex;gap:4px;align-items:center;min-height:28px}
.sc-react-btn.is-on{background:#eef2ff;border-color:#818cf8}
.sc-react-btn:disabled{opacity:.5;cursor:default}
.sc-react-btn b{font-size:11px}
.sc-link{background:none;border:none;color:var(--text-muted,#64748b);text-decoration:underline;cursor:pointer;font-size:inherit;padding:0}
.sc-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border-color,#f1f5f9)}
.sc-row:first-child{border-top:none}
.sc-row .sc-name{flex:1;font-weight:600}
.sc-row .sc-sub{display:block;font-weight:400;color:var(--text-muted,#64748b);font-size:var(--text-xs,.75rem)}
.sc-actions{display:flex;gap:6px;flex-wrap:wrap}
.sc-tabs{display:flex;gap:6px}
.sc-tab{border:1px solid var(--border-color,#e2e8f0);background:transparent;border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer}
.sc-tab[aria-selected="true"]{background:var(--color-primary,#4338ca);color:#fff;border-color:transparent}
.sc-empty{color:var(--text-muted,#64748b);font-size:var(--text-sm,.9rem);margin:0}
.sc-badge{background:#ef4444;color:#fff;border-radius:999px;font-size:11px;padding:1px 7px}
.sc-hero{margin:8px 0 16px}.sc-hero h1{margin:0 0 4px}
.sc-grid{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:860px){.sc-grid{grid-template-columns:1fr 1fr}}
.sc-dialog{border:none;border-radius:14px;padding:20px;max-width:360px}.sc-dialog::backdrop{background:rgba(15,23,42,.4)}
.sc-safe{font-size:var(--text-xs,.75rem);color:var(--text-muted,#64748b);margin:8px 0 0}
`;

export function ensureSocialStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById('social-styles')) return;
  const style = doc.createElement('style');
  style.id = 'social-styles';
  style.textContent = SOCIAL_CSS;
  doc.head.appendChild(style);
}
