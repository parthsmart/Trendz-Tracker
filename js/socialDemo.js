/**
 * Trendz Tracker - demo-mode stand-in for the social RPCs (js/socialDemo.js)
 *
 * Only used when no database is configured (local preview / demo sign-in), so the
 * Friends, dashboard card and Community pages can be tried with the seed students.
 * It follows the same rules as the database (both students say yes, then an adult;
 * preset reactions; silent blocks) but it is NOT a security boundary: the real
 * rules live in the social migration's RLS and SECURITY DEFINER functions.
 * State is kept in localStorage so two demo students can be tried one after another.
 */

import { DemoDB } from './demoDb.js';
import { REACTIONS, REPORT_REASONS } from './socialView.js';

const KEY = 'tt-social-demo-v1';
const REACTION_KEYS = new Set(REACTIONS.map((r) => r.key));
const REASON_KEYS = new Set(REPORT_REASONS.map((r) => r.key));

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.requests)) return s;
  } catch { /* fresh state below */ }
  const now = Date.now();
  const ago = (h) => new Date(now - h * 3600000).toISOString();
  return {
    seq: 10,
    settings: { friends_enabled: true, feed_enabled: true, reactions_enabled: true },
    prefs: {},
    requests: [],
    friendships: [],
    blocks: [],
    reports: [],
    reactions: [],
    feed: [
      { id: 4, student_id: 'usr-102', kind: 'badge', payload: { name: 'Speed Star', icon: '⚡' }, created_at: ago(2) },
      { id: 3, student_id: 'usr-105', kind: 'personal_best', payload: { label: 'Basics: Add & subtract' }, created_at: ago(5) },
      { id: 2, student_id: 'usr-101', kind: 'level_up', payload: { level: 'Level 3' }, created_at: ago(26) },
      { id: 1, student_id: null, kind: 'batch_goal', payload: { title: 'Level 2 finished the weekly challenge together!', icon: '🏆' }, created_at: ago(30), level: 'Level 2' },
    ],
  };
}

function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function me() {
  try { return DemoDB.getDemoAuth(); } catch { return null; }
}

function students() {
  return (DemoDB.getStudents?.() || []).filter((p) => p.role === 'student' && p.active !== false);
}

function person(id) {
  return students().find((p) => p.id === id) || null;
}

function nameOf(id) {
  const p = person(id);
  return p ? String(p.full_name || p.student_code).split(' ')[0] : 'Classmate';
}

const pairKey = (a, b) => [a, b].sort().join('|');
const blocked = (s, a, b) => s.blocks.some((x) => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
const friends = (s, a, b) => s.friendships.some((f) => !f.ended_at && f.key === pairKey(a, b));

function counts(s, kind, target, viewer) {
  const rows = s.reactions.filter((r) => r.kind === kind && String(r.target) === String(target)
    && !blocked(s, viewer, r.reactor_id));
  const c = {};
  for (const r of rows) c[r.reaction] = (c[r.reaction] || 0) + 1;
  return { counts: c, mine: rows.filter((r) => r.reactor_id === viewer).map((r) => r.reaction) };
}

function feedRow(s, i, viewer) {
  const p = i.student_id ? person(i.student_id) : null;
  return {
    id: i.id, kind: i.kind, payload: i.payload, level: i.level || p?.level || null, created_at: i.created_at,
    mine: i.student_id === viewer, student_id: i.student_id,
    name: p ? nameOf(p.id) : null, avatar_path: null, reactions: counts(s, 'feed', i.id, viewer),
  };
}

const HANDLERS = {
  social_home() {
    const s = load(); const u = me(); const my = person(u?.id);
    if (!my) return { ok: false, code: 'NOT_STUDENT' };
    const friendIds = s.friendships.filter((f) => !f.ended_at && f.key.split('|').includes(my.id))
      .map((f) => f.key.split('|').find((x) => x !== my.id));
    const open = s.requests.filter((r) => ['pending_student', 'pending_staff'].includes(r.status)
      && (r.from_id === my.id || r.to_id === my.id));
    const busy = new Set(open.map((r) => (r.from_id === my.id ? r.to_id : r.from_id)));
    return {
      ok: true, level: my.level, auto_post: s.prefs[my.id] !== false,
      enabled: { friends: s.settings.friends_enabled, feed: s.settings.feed_enabled, reactions: s.settings.reactions_enabled },
      friends: friendIds.map(person).filter(Boolean).map((o) => ({ id: o.id, name: nameOf(o.id), avatar_path: null, level: o.level, same_level: o.level === my.level })),
      requests: open.filter((r) => !blocked(s, r.from_id, r.to_id)).map((r) => {
        const other = r.from_id === my.id ? r.to_id : r.from_id;
        return { id: r.id, direction: r.from_id === my.id ? 'out' : 'in', status: r.status, other_id: other, name: nameOf(other), avatar_path: null, created_at: r.created_at };
      }),
      classmates: students().filter((o) => o.id !== my.id && o.leaderboard_visible !== false && !blocked(s, my.id, o.id)
        && !friendIds.includes(o.id) && !busy.has(o.id))
        .map((o) => ({ id: o.id, name: nameOf(o.id), avatar_path: null, level: o.level, same_level: o.level === my.level }))
        .sort((a, b) => Number(b.same_level) - Number(a.same_level) || a.name.localeCompare(b.name)),
      blocked: s.blocks.filter((b) => b.blocker_id === my.id).map((b) => ({ id: b.blocked_id, name: nameOf(b.blocked_id) })),
      my_events: s.feed.filter((i) => i.student_id === my.id && !i.removed_at).map((i) => ({ id: i.id, kind: i.kind, payload: i.payload, created_at: i.created_at, hidden: Boolean(i.hidden_at) })),
    };
  },
  social_request_friend({ p_to }) {
    const s = load(); const u = me(); const to = person(p_to);
    if (!person(u?.id) || !to || to.id === u.id || blocked(s, u.id, to.id)) return { ok: false, code: 'UNAVAILABLE' };
    if (!s.settings.friends_enabled) return { ok: false, code: 'DISABLED' };
    if (friends(s, u.id, to.id)) return { ok: false, code: 'ALREADY_FRIENDS' };
    if (s.requests.some((r) => ['pending_student', 'pending_staff'].includes(r.status) && pairKey(r.from_id, r.to_id) === pairKey(u.id, to.id))) return { ok: false, code: 'PENDING' };
    if (s.requests.filter((r) => r.from_id === u.id && ['pending_student', 'pending_staff'].includes(r.status)).length >= 5) return { ok: false, code: 'TOO_MANY_PENDING' };
    const id = `req-${++s.seq}`;
    s.requests.push({ id, from_id: u.id, to_id: to.id, status: 'pending_student', created_at: new Date().toISOString() });
    save(s);
    return { ok: true, id };
  },
  social_respond_request({ p_id, p_accept }) {
    const s = load(); const u = me(); const r = s.requests.find((x) => x.id === p_id && x.to_id === u?.id && x.status === 'pending_student');
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    r.status = p_accept ? 'pending_staff' : 'declined_student';
    save(s);
    return { ok: true, status: r.status };
  },
  social_cancel_request({ p_id }) {
    const s = load(); const u = me(); const r = s.requests.find((x) => x.id === p_id && x.from_id === u?.id && ['pending_student', 'pending_staff'].includes(x.status));
    if (r) { r.status = 'cancelled'; save(s); }
    return { ok: Boolean(r) };
  },
  social_unfriend({ p_other }) {
    const s = load(); const u = me(); const f = s.friendships.find((x) => !x.ended_at && x.key === pairKey(u?.id, p_other));
    if (f) { f.ended_at = new Date().toISOString(); save(s); }
    return { ok: Boolean(f) };
  },
  social_block({ p_other }) {
    const s = load(); const u = me();
    if (!person(u?.id) || !person(p_other) || p_other === u.id) return { ok: false, code: 'NOT_ALLOWED' };
    if (!s.blocks.some((b) => b.blocker_id === u.id && b.blocked_id === p_other)) s.blocks.push({ blocker_id: u.id, blocked_id: p_other, created_at: new Date().toISOString() });
    for (const f of s.friendships) if (!f.ended_at && f.key === pairKey(u.id, p_other)) f.ended_at = new Date().toISOString();
    for (const r of s.requests) if (['pending_student', 'pending_staff'].includes(r.status) && pairKey(r.from_id, r.to_id) === pairKey(u.id, p_other)) r.status = 'blocked';
    save(s);
    return { ok: true };
  },
  social_unblock({ p_other }) {
    const s = load(); const u = me(); const before = s.blocks.length;
    s.blocks = s.blocks.filter((b) => !(b.blocker_id === u?.id && b.blocked_id === p_other));
    save(s);
    return { ok: s.blocks.length < before };
  },
  social_report({ p_target, p_context, p_context_id, p_reason }) {
    const s = load(); const u = me();
    if (!person(u?.id) || !person(p_target) || p_target === u.id) return { ok: false, code: 'NOT_ALLOWED' };
    if (!REASON_KEYS.has(p_reason)) return { ok: false, code: 'BAD_INPUT' };
    s.reports.push({ id: ++s.seq, reporter_id: u.id, target_id: p_target, context: p_context, context_id: p_context_id, reason: p_reason, status: 'open', created_at: new Date().toISOString() });
    save(s);
    return { ok: true };
  },
  social_feed({ p_scope = 'level' } = {}) {
    const s = load(); const u = me(); const my = person(u?.id);
    if (!my) return { ok: false, code: 'NOT_STUDENT' };
    if (!s.settings.feed_enabled) return { ok: true, enabled: false, items: [] };
    const items = s.feed.filter((i) => !i.removed_at && !i.hidden_at && !(i.student_id && blocked(s, my.id, i.student_id)))
      .map((i) => feedRow(s, i, my.id))
      .filter((i) => p_scope === 'centre' || i.level === my.level)
      .sort((a, b) => b.id - a.id);
    return { ok: true, enabled: true, reactions_enabled: s.settings.reactions_enabled, items };
  },
  social_react({ p_kind, p_target, p_reaction }) {
    const s = load(); const u = me();
    if (!REACTION_KEYS.has(p_reaction)) return { ok: false, code: 'BAD_REACTION' };
    const item = s.feed.find((i) => String(i.id) === String(p_target));
    if (!person(u?.id) || !s.settings.reactions_enabled || p_kind !== 'feed' || !item || item.student_id === u.id) return { ok: false, code: 'NOT_ALLOWED' };
    const at = s.reactions.findIndex((r) => r.kind === p_kind && String(r.target) === String(p_target) && r.reactor_id === u.id && r.reaction === p_reaction);
    if (at >= 0) s.reactions.splice(at, 1);
    else s.reactions.push({ kind: p_kind, target: String(p_target), reactor_id: u.id, reaction: p_reaction });
    save(s);
    return { ok: true, reactions: counts(s, p_kind, p_target, u.id) };
  },
  social_reactions_for() { return {}; },
  social_hide_item({ p_id, p_hidden }) {
    const s = load(); const u = me(); const i = s.feed.find((x) => x.id === Number(p_id) && x.student_id === u?.id);
    if (i) { i.hidden_at = p_hidden ? new Date().toISOString() : null; save(s); }
    return { ok: Boolean(i) };
  },
  social_set_auto_post({ p_on }) {
    const s = load(); const u = me();
    if (!person(u?.id)) return { ok: false, code: 'NOT_STUDENT' };
    s.prefs[u.id] = Boolean(p_on); save(s);
    return { ok: true };
  },
  social_mod_queue() {
    const s = load();
    return {
      can_settings: true, centre_id: 'demo-centre', settings: s.settings,
      requests: s.requests.filter((r) => r.status === 'pending_staff').map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, from_id: r.from_id, from_name: person(r.from_id)?.full_name, to_id: r.to_id, to_name: person(r.to_id)?.full_name })),
      reports: s.reports.map((x) => ({ ...x, reporter_name: person(x.reporter_id)?.full_name, target_name: person(x.target_id)?.full_name })).reverse(),
      feed: s.feed.map((i) => ({ id: i.id, kind: i.kind, payload: i.payload, level: i.level || person(i.student_id)?.level || null, created_at: i.created_at, student_id: i.student_id, student_name: i.student_id ? person(i.student_id)?.full_name : null, hidden: Boolean(i.hidden_at), removed: Boolean(i.removed_at) })).sort((a, b) => b.id - a.id),
      friendships: s.friendships.filter((f) => !f.ended_at).map((f) => { const [a, b] = f.key.split('|'); return { a_id: a, a_name: person(a)?.full_name, b_id: b, b_name: person(b)?.full_name, created_at: f.created_at, approved_by: 'Demo teacher' }; }),
      blocks: s.blocks.map((b) => ({ blocker_name: person(b.blocker_id)?.full_name, blocked_name: person(b.blocked_id)?.full_name, created_at: b.created_at })),
    };
  },
  social_decide_request({ p_id, p_approve }) {
    const s = load(); const r = s.requests.find((x) => x.id === p_id && x.status === 'pending_staff');
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    if (p_approve && blocked(s, r.from_id, r.to_id)) { r.status = 'declined_staff'; save(s); return { ok: false, code: 'UNAVAILABLE' }; }
    r.status = p_approve ? 'approved' : 'declined_staff';
    if (p_approve) s.friendships.push({ key: pairKey(r.from_id, r.to_id), created_at: new Date().toISOString() });
    save(s);
    return { ok: true };
  },
  social_remove_item({ p_id, p_removed }) {
    const s = load(); const i = s.feed.find((x) => x.id === Number(p_id));
    if (!i) return { ok: false, code: 'NOT_FOUND' };
    i.removed_at = p_removed ? new Date().toISOString() : null; save(s);
    return { ok: true };
  },
  social_end_friendship({ p_a, p_b }) {
    const s = load(); const f = s.friendships.find((x) => !x.ended_at && x.key === pairKey(p_a, p_b));
    if (f) { f.ended_at = new Date().toISOString(); save(s); }
    return f ? { ok: true } : { ok: false, code: 'NOT_FOUND' };
  },
  social_handle_report({ p_id, p_status, p_action }) {
    const s = load(); const x = s.reports.find((r) => r.id === Number(p_id));
    if (!x) return { ok: false, code: 'NOT_FOUND' };
    x.status = p_status; x.action = p_action || null; save(s);
    return { ok: true };
  },
  social_update_settings({ p_friends, p_feed, p_reactions }) {
    const s = load();
    s.settings = { friends_enabled: Boolean(p_friends), feed_enabled: Boolean(p_feed), reactions_enabled: Boolean(p_reactions) };
    save(s);
    return { ok: true };
  },
};

/** Same { data, error } shape as the real rpc wrapper. */
export async function demoSocialRpc(name, args = {}) {
  const fn = HANDLERS[name];
  if (!fn) return { data: null, error: 'Not available in demo mode.' };
  try {
    return { data: fn(args), error: null };
  } catch (err) {
    return { data: null, error: err?.message || 'Something went wrong.' };
  }
}
