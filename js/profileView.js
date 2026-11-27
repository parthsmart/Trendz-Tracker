/**
 * Trendz Tracker - pure builders for the student profile page (js/profileView.js)
 *
 * Everything shown here comes from the `my_profile` RPC: badges, awards, XP and the weekly
 * summary are worked out in the database. These functions only format it.
 */

import { escapeXpHtml as esc, formatXp, tierProgress, tierIcon } from './xpRewards.js';

export const FAVOURITE_LABELS = Object.freeze({
  basics: 'Basics',
  flash: 'Flash Anzan',
  elements: 'Elements',
  memoriad: 'Memoriad',
  main_round: 'Main round',
  oral: 'Oral rounds',
});

export const BADGE_CATEGORY_LABELS = Object.freeze({
  practice: 'Practice',
  accuracy: 'Accuracy',
  improvement: 'Improvement',
  streak: 'Streaks',
  challenge: 'Daily challenge',
  rank: 'Tiers',
  award: 'Awards',
  league: 'Leagues',
  duel: 'Duels',
});

/** Badge categories that come with a printable certificate. */
export const CERTIFICATE_CATEGORIES = Object.freeze(['rank', 'award', 'league']);

/** Link to the printable certificate for an earned badge (staff pass the student id). */
export function certificateHref(badgeKey, studentId = null) {
  const q = new URLSearchParams({ badge: String(badgeKey || '') });
  if (studentId) q.set('student', String(studentId));
  return `/pages/certificate.html?${q.toString()}`;
}

export const MOTTO_MAX = 60;

const IST = 'Asia/Kolkata';

/** "2026-11-23" or ISO timestamp -> "23 Nov". */
export function shortDate(value, withYear = false) {
  if (!value) return '';
  const s = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: IST });
}

export function monthLabel(value) {
  if (!value) return '';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: IST });
}

/** Display name for other viewers (first name + initial), mirrors the leaderboard default. */
export function firstName(fullName) {
  return String(fullName ?? '').trim().split(/\s+/)[0] || 'Your child';
}

/** Earned titles from awards: [{ icon, text, count }]. */
export function awardTitles(awards) {
  const list = Array.isArray(awards) ? awards : [];
  const weeks = list.filter((a) => a?.kind === 'week');
  const months = list.filter((a) => a?.kind === 'month');
  const out = [];
  if (months.length) {
    out.push({ icon: '🌟', text: `Star of the Month${months.length > 1 ? ` ×${months.length}` : ''}`, latest: monthLabel(months[0].from), count: months.length });
  }
  if (weeks.length) {
    out.push({ icon: '🏆', text: `Champion of the Week${weeks.length > 1 ? ` ×${weeks.length}` : ''}`, latest: `week of ${shortDate(weeks[0].from)}`, count: weeks.length });
  }
  return out;
}

export function buildTitlesHtml(awards) {
  return awardTitles(awards)
    .map((t) => `<span class="pf-title" title="Latest: ${esc(t.latest)}">${t.icon} ${esc(t.text)}</span>`)
    .join('');
}

/** Badge wall grouped by category; locked badges are shown greyed out. */
export function buildBadgeWallHtml(badges, { studentId = null } = {}) {
  const list = Array.isArray(badges) ? badges : [];
  if (!list.length) return '<p class="pf-dim">Badges will appear here soon.</p>';
  const groups = new Map();
  for (const b of list) {
    const key = b?.category || 'practice';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  let html = '';
  for (const [cat, items] of groups) {
    html += `<div class="pf-badge-group"><h3>${esc(BADGE_CATEGORY_LABELS[cat] || cat)}</h3><ul class="pf-badges">`;
    for (const b of items) {
      const earned = Boolean(b?.earned_at);
      const when = earned ? `Earned ${shortDate(b.earned_at, true)}` : 'Locked';
      html += `<li class="pf-badge ${earned ? 'is-earned' : 'is-locked'}" title="${esc(b?.description)}">`
        + `<span class="pf-badge-ic" aria-hidden="true">${esc(b?.icon)}</span>`
        + `<b>${esc(b?.name)}</b>`
        + `<span class="pf-badge-d">${esc(b?.description)}</span>`
        + `<span class="pf-badge-w">${earned ? '✅ ' : '🔒 '}${esc(when)}</span>`
        + (earned && CERTIFICATE_CATEGORIES.includes(b?.category)
          ? `<a class="pf-cert" href="${esc(certificateHref(b.key, studentId))}">🎓 Certificate</a>`
          : '')
        + '</li>';
    }
    html += '</ul></div>';
  }
  return html;
}

export function badgeCounts(badges) {
  const list = Array.isArray(badges) ? badges : [];
  return { earned: list.filter((b) => b?.earned_at).length, total: list.length };
}

export function buildStatsHtml(p) {
  const streak = p?.streak || {};
  const stat = (label, value, sub = '') =>
    `<div class="pf-stat"><span class="pf-dim">${esc(label)}</span><b>${value}</b>${sub ? `<span class="pf-dim">${sub}</span>` : ''}</div>`;
  return [
    stat('Total XP', `${formatXp(p?.total_xp)}`),
    stat('This week', `${formatXp(p?.week_xp)} XP`, p?.week_rank?.rank ? `#${formatXp(p.week_rank.rank)} of ${formatXp(p.week_rank.of)} in level` : ''),
    stat('Streak', `🔥 ${formatXp(streak.current)}`, `Best ${formatXp(streak.best)} days`),
    stat('Rounds', formatXp(p?.rounds_total)),
    stat('Personal bests beaten', formatXp(p?.pb_total)),
    stat('Daily challenges', formatXp(p?.challenge?.played)),
  ].join('');
}

export function buildBestsHtml(bests) {
  const list = Array.isArray(bests) ? bests.slice(0, 10) : [];
  if (!list.length) return '<p class="pf-dim">Score 70% or more in a round to set a personal best.</p>';
  return `<ul class="xp-list">${list
    .map((b) => `<li><span>${esc(b?.label)}</span><span><strong>${esc(b?.score)}</strong> <span class="xp-dim">${esc(shortDate(b?.day))}</span></span></li>`)
    .join('')}</ul>`;
}

export function buildChallengeHistoryHtml(challenge) {
  const recent = Array.isArray(challenge?.recent) ? challenge.recent : [];
  if (!recent.length) {
    return '<p class="pf-dim">No daily challenges yet. A new 1-minute challenge opens every day on your home page.</p>';
  }
  return `<ul class="xp-list">${recent
    .map((c) => `<li><span>${esc(shortDate(c?.day))} · ${esc(c?.name)}</span><span><strong>${formatXp(c?.correct)}/${formatXp(c?.total)}</strong></span></li>`)
    .join('')}</ul>`;
}

/** Plain-text weekly summary a parent can read on WhatsApp or paper. */
export function buildParentSummaryText(p) {
  const profile = p?.profile || {};
  const week = p?.week || {};
  const name = firstName(profile.full_name);
  const tp = tierProgress(p?.total_xp, p?.tier);
  const lines = [];
  lines.push(`Trendz Tracker weekly summary for ${name}`);
  lines.push(`Week: ${shortDate(week.from)} – ${shortDate(week.to, true)}`);
  lines.push('');
  const rounds = Number(week.rounds) || 0;
  const days = Number(week.practice_days) || 0;
  if (!rounds) {
    lines.push(`${name} has not practised online yet this week.`);
  } else {
    lines.push(`• Practised on ${days} day${days === 1 ? '' : 's'} (${rounds} round${rounds === 1 ? '' : 's'})`);
    const total = Number(week.total) || 0;
    if (total > 0) {
      const pct = Math.round((100 * (Number(week.correct) || 0)) / total);
      lines.push(`• Answered ${formatXp(week.correct)} of ${formatXp(total)} correctly (${pct}%)`);
    }
    lines.push(`• Earned ${formatXp(p?.week_xp)} XP this week`);
  }
  const streak = Number(p?.streak?.current) || 0;
  if (streak > 0) lines.push(`• Practice streak: ${streak} day${streak === 1 ? '' : 's'}`);
  const bests = Array.isArray(week.new_bests) ? week.new_bests : [];
  if (bests.length) {
    lines.push(`• New personal best${bests.length === 1 ? '' : 's'}: ${bests.map((b) => `${b.label} (${b.score})`).join(', ')}`);
  }
  const newBadges = Array.isArray(week.new_badges) ? week.new_badges : [];
  if (newBadges.length) {
    lines.push(`• New badge${newBadges.length === 1 ? '' : 's'}: ${newBadges.map((b) => `${b.icon} ${b.name}`).join(', ')}`);
  }
  lines.push(`• Level: ${profile.level || '—'} · Tier: ${tierIcon(tp.name)} ${tp.name} (${formatXp(p?.total_xp)} XP total)`);
  const titles = awardTitles(p?.awards);
  if (titles.length) lines.push(`• Titles: ${titles.map((t) => t.text).join(', ')}`);
  lines.push('');
  lines.push(rounds >= 5 ? 'Great effort this week, keep it up!' : 'A little practice every day makes a big difference.');
  return lines.join('\n');
}

export function whatsappShareUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(String(text ?? ''))}`;
}
