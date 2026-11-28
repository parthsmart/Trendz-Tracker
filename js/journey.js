/**
 * Trendz Tracker - Journey page (pages/journey.html)
 *
 * Students: pick a mascot, see their level island and its stages (counted on the
 * server from real practice), take the boss round and checked oral sets (made and
 * marked by /api/drill journey_* actions), and the season board for their level and centre.
 * Staff: boss results and "ready for level-up" flags (a decision never changes the
 * official level). Owners and directors also schedule themed seasons.
 *
 * Nothing here decides progress, scores or rewards: they all come from the database.
 */

import { requireAuth } from './guard.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { showToast } from './toast.js';
import { fetchXpSummary, tierIcon, formatXp } from './xpRewards.js';
import { mascotSvg, ensureMascotStyles, writeMascotCache } from './mascot.js';
import { celebrate } from './motion.js';
import {
  MASCOTS,
  MASCOT_KINDS,
  ISLAND_NAMES,
  STAGE_KINDS,
  STAGES_FOR_BOSS,
  BOSS_ATTEMPTS_PER_DAY,
  SEASON_THEMES,
  journeyState,
  journeyStages,
  mascotForm,
  levelIndex,
  oralSpeech,
  generateBossPaper,
  generateOralSet,
  publicQuestions,
  gradePaper,
  BOSS_PASS_PERCENT,
  ORAL_PASS_PERCENT,
  validateSeasonDraft,
  seasonEnd,
} from '../shared/world.js';
import { STUDENT_LEVELS } from '../shared/levels.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const state = {
  profile: null,
  demo: false,
  world: null,
  seasons: null,
  board: null,
  xp: null,
  run: null,
};

/* ------------------------------------------------------------------ data */

async function rpc(name, args = {}) {
  if (state.demo) return demoRpc(name, args);
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'Something went wrong.');
  return data;
}

async function drillApi(body) {
  if (state.demo) return demoApi(body);
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Please sign in again.');
  const res = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

/* ------------------------------------------------------- demo (no server) */

const DEMO_KEY = 'tt_world_demo';
function demoState() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveDemo(s) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function demoRpc(name, args) {
  const s = demoState();
  const level = state.profile?.level || 'Level 2';
  const today = new Date().toISOString().slice(0, 10);
  if (name === 'my_world') {
    const done = [3, 4, 2, 1, 2, s.oral || 0];
    return {
      level,
      stages: journeyStages(level).map((st, i) => ({ ...st, done: Math.max(done[i], i === 2 ? 2 : 0) })),
      boss_attempts_today: s.bossToday === today ? s.bossTries || 0 : 0,
      boss_best: s.bossBest || null,
      flag: s.flag || null,
      mascot: s.mascot || null,
      items: ['space'],
    };
  }
  if (name === 'set_my_mascot') {
    s.mascot = { kind: args.p_kind, equipped: args.p_equipped || null };
    saveDemo(s);
    return s.mascot;
  }
  if (name === 'season_list') {
    const start = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
    return {
      today,
      can_manage: state.profile?.role !== 'student',
      current: { from: start, to: seasonEnd(start), themed_id: 1, name: 'Space Season', theme: 'space', days_left: 36 },
      seasons: [{ id: 1, name: 'Space Season', theme: 'space', starts_on: start, ends_on: seasonEnd(start), status: 'scheduled', badge_xp: 500, settled: false, badge: { name: 'Space Season', icon: '🚀' } }, ...(s.seasons || [])],
      my_podiums: [],
    };
  }
  if (name === 'season_board') {
    const names = ['Rohan S.', 'Diya K.', 'Aarav Sharma', 'Kabir M.', 'Isha P.'];
    return { name: 'Space Season', theme: 'space', level, rows: names.map((n, i) => ({ rank: i + 1, display_name: n, xp: 1800 - i * 260, is_me: i === 2 })) };
  }
  if (name === 'journey_staff_board') {
    return {
      flags: [{ student_id: 'demo-1', name: 'Diya Kapoor', code: 'TT-102', level: 'Level 2', current_level: 'Level 2', percent: 88, flagged_at: new Date().toISOString(), status: 'pending' }],
      attempts: [{ student_id: 'demo-1', name: 'Diya Kapoor', code: 'TT-102', level: 'Level 2', percent: 88, passed: true, correct: 15, total: 17, by_type: { add: { correct: 4, total: 4 }, mul: { correct: 3, total: 3 }, div: { correct: 2, total: 3 }, flash: { correct: 2, total: 2 }, oral: { correct: 1, total: 2 } }, submitted_at: new Date().toISOString() }],
    };
  }
  if (name === 'journey_levelup_review') return null;
  if (name === 'season_cancel') {
    s.seasons = (s.seasons || []).map((x) => (x.id === args.p_id ? { ...x, status: 'cancelled' } : x));
    saveDemo(s);
    return null;
  }
  if (name === 'season_save') {
    const id = 2 + (s.seasons || []).length;
    const icon = SEASON_THEMES[args.p_theme]?.icon || '';
    s.seasons = [...(s.seasons || []), { id, name: args.p_name, theme: args.p_theme, starts_on: args.p_starts_on, ends_on: seasonEnd(args.p_starts_on), status: 'scheduled', badge_xp: args.p_badge_xp, settled: false, badge: { name: args.p_name, icon } }];
    saveDemo(s);
    return id;
  }
  return null;
}

function demoApi(body) {
  const s = demoState();
  const level = state.profile?.level || 'Level 2';
  const today = new Date().toISOString().slice(0, 10);
  if (body.action === 'journey_start') {
    const seed = Math.floor(Math.random() * 1e9);
    const paper = body.kind === 'boss' ? generateBossPaper(level, seed) : generateOralSet(level, seed);
    if (body.kind === 'boss') {
      s.bossTries = s.bossToday === today ? (s.bossTries || 0) + 1 : 1;
      s.bossToday = today;
    }
    s.paper = { kind: body.kind, questions: paper.questions };
    saveDemo(s);
    return {
      session_id: '00000000-0000-4000-8000-000000000000',
      kind: body.kind,
      level,
      minutes: paper.minutes,
      pass_percent: body.kind === 'boss' ? BOSS_PASS_PERCENT : ORAL_PASS_PERCENT,
      questions: publicQuestions(paper.questions),
    };
  }
  if (body.action === 'journey_submit') {
    const p = s.paper;
    const pass = p.kind === 'boss' ? BOSS_PASS_PERCENT : ORAL_PASS_PERCENT;
    const g = gradePaper(p.questions, body.answers, pass);
    if (p.kind === 'oral' && g.passed) s.oral = (s.oral || 0) + 1;
    if (p.kind === 'boss') {
      if (!s.bossBest || g.percent > s.bossBest.percent) s.bossBest = { percent: g.percent, passed: g.passed };
      if (g.passed) s.flag = { status: 'pending', flagged_at: new Date().toISOString() };
    }
    saveDemo(s);
    return {
      kind: p.kind, level, ...g, pass_percent: pass,
      review: p.questions.map((q, i) => ({ n: i + 1, type: q.type, prompt: q.prompt, answer: q.answer, given: String(body.answers[i] ?? ''), correct: g.marks[i] })),
    };
  }
  return null;
}

/* ---------------------------------------------------------------- render */

function seasonBanner() {
  const cur = state.seasons?.current;
  if (!cur) return '';
  const theme = SEASON_THEMES[cur.theme];
  const xp = state.xp;
  const tier = xp?.tier;
  const title = cur.name ? `${theme?.icon || '🌟'} ${esc(cur.name)}` : '📅 This month’s season';
  const tierHtml = tier ? `<span class="jy-chip">${tierIcon(tier.name)} ${esc(tier.name)} · ${formatXp(xp.season_xp)} XP</span>` : '';
  return `<section class="card jy-season" style="--jy-theme:${theme?.colour || 'var(--color-primary)'}">
    <div class="jy-season-main">
      <div class="jy-eyebrow">Season</div>
      <h2>${title}</h2>
      <div class="jy-dim">${fmtDate(cur.from)} – ${fmtDate(cur.to)} · ${cur.days_left} day${cur.days_left === 1 ? '' : 's'} left</div>
    </div>
    <div class="jy-season-side">${tierHtml}${cur.name ? `<span class="jy-dim">Season badge + ${esc(theme?.itemLabel || 'outfit')} for your mascot when you reach the badge XP</span>` : ''}</div>
  </section>`;
}

function mascotCard() {
  const w = state.world;
  const m = w?.mascot;
  const level = w?.level || state.profile?.level;
  if (!m) {
    return `<section class="card jy-mascot jy-mascot-empty">
      <div><h2>Pick your practice buddy</h2><p class="jy-dim">Your mascot grows at every level and cheers you on after each round.</p></div>
      <button type="button" class="btn btn-primary" data-act="pick">Choose a mascot</button>
    </section>`;
  }
  const f = mascotForm(m.kind, level);
  const next = STUDENT_LEVELS[f.stage + 1];
  return `<section class="card jy-mascot">
    <div class="jy-mascot-art">${mascotSvg({ kind: m.kind, level, mood: 'happy', equipped: m.equipped, size: 150 })}</div>
    <div class="jy-mascot-info">
      <div class="jy-eyebrow">Your mascot</div>
      <h2>${esc(MASCOTS[f.kind].name)} <span class="jy-dim">· ${esc(f.name)}</span></h2>
      <p class="jy-dim">${next ? `Reaches its <b>${esc(MASCOTS[f.kind].forms[f.stage + 1])}</b> form when your teacher moves you up to ${esc(next)}.` : 'Fully grown: the Grandmaster form.'}</p>
      <button type="button" class="btn btn-outline btn-sm" data-act="pick">Change mascot or outfit</button>
    </div>
  </section>`;
}

function pickerHtml() {
  const w = state.world || {};
  const level = w.level || state.profile?.level;
  const cur = w.mascot || {};
  const items = Array.isArray(w.items) ? w.items : [];
  const cards = MASCOT_KINDS.map((k) => `
    <button type="button" class="jy-pick ${cur.kind === k ? 'is-on' : ''}" data-kind="${k}" aria-pressed="${cur.kind === k}">
      ${mascotSvg({ kind: k, level, mood: 'idle', size: 110, equipped: cur.kind === k ? cur.equipped : null })}
      <b>${esc(MASCOTS[k].title)}</b>
      <span class="jy-dim">${esc(MASCOTS[k].blurb)}</span>
    </button>`).join('');
  const outfits = items.length
    ? `<div class="jy-outfits"><span class="jy-dim">Season outfits:</span>
        <button type="button" class="jy-chip-btn ${!cur.equipped ? 'is-on' : ''}" data-item="">None</button>
        ${items.map((it) => `<button type="button" class="jy-chip-btn ${cur.equipped === it ? 'is-on' : ''}" data-item="${esc(it)}">${esc(SEASON_THEMES[it]?.icon || '')} ${esc(SEASON_THEMES[it]?.itemLabel || it)}</button>`).join('')}
      </div>`
    : '<p class="jy-dim">Reach the badge XP in a themed season to earn an outfit for your mascot.</p>';
  return `<section class="card jy-picker" id="jy-picker">
    <div class="jy-row-head"><h2>Choose your mascot</h2><button type="button" class="btn btn-ghost btn-sm" data-act="close-pick">Close</button></div>
    <div class="jy-pick-grid">${cards}</div>
    ${outfits}
  </section>`;
}

function islandsHtml(level) {
  const idx = levelIndex(level);
  return `<ol class="jy-islands" aria-label="Level islands">${STUDENT_LEVELS.map((lv, i) => {
    const cls = i < idx ? 'is-past' : i === idx ? 'is-here' : 'is-ahead';
    const mark = i < idx ? '✓' : i === idx ? '📍' : '🔒';
    return `<li class="jy-island ${cls}" ${i === idx ? 'aria-current="step"' : ''}><span class="jy-isle-dot" aria-hidden="true">${mark}</span><b>${esc(ISLAND_NAMES[lv])}</b><span class="jy-dim">${esc(lv)}</span></li>`;
  }).join('')}</ol>`;
}

function stagesHtml() {
  const w = state.world;
  const js = journeyState(w.stages || []);
  const stages = js.stages.map((s) => {
    const meta = STAGE_KINDS[s.kind] || {};
    const pct = Math.min(100, Math.round((s.done / Math.max(1, s.rounds_needed)) * 100));
    const href = s.kind === 'oral' ? '#oral' : meta.href;
    return `<li class="jy-stage ${s.complete ? 'is-done' : ''}">
      <span class="jy-stage-icon" aria-hidden="true">${s.complete ? '✅' : meta.icon || '•'}</span>
      <div class="jy-stage-body">
        <b>${esc(s.title)}</b>
        <span class="jy-dim">${Math.min(s.done, s.rounds_needed)} of ${s.rounds_needed} round${s.rounds_needed === 1 ? '' : 's'} at ${s.min_accuracy}%+</span>
        <div class="jy-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(s.title)} progress"><span style="width:${pct}%"></span></div>
      </div>
      ${s.complete ? '' : s.kind === 'oral'
        ? '<button type="button" class="btn btn-outline btn-sm" data-act="oral">Start</button>'
        : `<a class="btn btn-outline btn-sm" href="${esc(href)}">Practise</a>`}
    </li>`;
  }).join('');

  const tries = Number(w.boss_attempts_today) || 0;
  const left = Math.max(0, BOSS_ATTEMPTS_PER_DAY - tries);
  const best = w.boss_best;
  const flag = w.flag;
  let bossNote;
  if (flag?.status === 'pending') bossNote = '🎉 You passed! Your teacher will check if you are ready to level up.';
  else if (flag?.status === 'agreed') bossNote = '🌟 Your teacher agrees you are ready for the next level.';
  else if (flag?.status === 'not_yet') bossNote = `Your teacher says not yet${flag.note ? `: “${esc(flag.note)}”` : ''}. Keep practising and try again.`;
  else if (!js.bossOpen) bossNote = `Clear ${Math.min(STAGES_FOR_BOSS, js.total)} of ${js.total} stages to open the boss round (${js.cleared} cleared).`;
  else bossNote = `A mixed paper from this level’s question types. Score ${BOSS_PASS_PERCENT}% to pass.`;

  return `<section class="card jy-island-card">
    <div class="jy-row-head">
      <div><div class="jy-eyebrow">${esc(w.level)}</div><h2>${esc(ISLAND_NAMES[w.level] || w.level)}</h2></div>
      <span class="jy-chip">${js.cleared} / ${js.total} stages</span>
    </div>
    <p class="jy-dim">Stages count rounds you practise from ${fmtDate(w.since) || 'today'} on this island.</p>
    <ol class="jy-stages">${stages}</ol>
    <div class="jy-boss ${js.bossOpen ? 'is-open' : ''}">
      <span class="jy-boss-icon" aria-hidden="true">${js.bossOpen ? '🐉' : '🔒'}</span>
      <div class="jy-stage-body">
        <b>Boss round</b>
        <span>${bossNote}</span>
        ${best ? `<span class="jy-dim">Best: ${best.percent}%${best.passed ? ' · passed' : ''}</span>` : ''}
      </div>
      ${js.bossOpen ? `<button type="button" class="btn btn-primary btn-sm" data-act="boss" ${left === 0 ? 'disabled' : ''}>${left === 0 ? 'Back tomorrow' : `Start (${left} left today)`}</button>` : ''}
    </div>
  </section>`;
}

function boardHtml() {
  const b = state.board;
  const cur = state.seasons?.current;
  if (!b) return '';
  const rows = (b.rows || []).map((r) => `<tr class="${r.is_me ? 'is-me' : ''}"><td class="num">${r.rank}</td><td>${esc(r.display_name)}${r.is_me ? ' <span class="jy-chip">You</span>' : ''}</td><td class="num">${formatXp(r.xp)}</td></tr>`).join('');
  const pods = state.seasons?.my_podiums || [];
  return `<section class="card jy-board">
    <div class="jy-row-head"><h2>🏆 Season board</h2><span class="jy-dim">${esc(b.level || '')}${cur?.name ? ` · ${esc(cur.name)}` : ''}</span></div>
    <p class="jy-dim">Students at your level in your centre. Season XP comes from every round you finish.</p>
    ${rows ? `<table class="jy-table"><thead><tr><th>#</th><th>Name</th><th class="num">XP</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="jy-dim">No season XP yet. Finish a round to get on the board.</p>'}
    ${pods.length ? `<div class="jy-outfits">${pods.map((p) => `<span class="jy-chip">${p.place === 1 ? '🥇' : p.place === 2 ? '🥈' : '🥉'} ${esc(p.name || fmtDate(p.season))}</span>`).join('')}</div>` : ''}
  </section>`;
}

function renderStudent() {
  const root = $('#jy-root');
  const w = state.world;
  if (!w?.level || !w.stages?.length) {
    root.innerHTML = `${seasonBanner()}${mascotCard()}<section class="card"><p>Your teacher needs to set your level before your island opens.</p></section>${boardHtml()}`;
    return;
  }
  root.innerHTML = `
    ${seasonBanner()}
    <div class="jy-grid">
      <div class="jy-col">${mascotCard()}${state.showPicker ? pickerHtml() : ''}${islandsHtml(w.level)}${stagesHtml()}</div>
      <div class="jy-col">${boardHtml()}</div>
    </div>
    <div id="jy-run"></div>`;
  if (state.showPicker) $('#jy-picker')?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------- boss / oral runs */

function speak(text) {
  try {
    const synth = globalThis.speechSynthesis;
    if (!synth) return false;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    u.rate = 0.9;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

function questionHtml(q) {
  const p = q.prompt || {};
  if (q.type === 'add') {
    return `<div class="jy-q-rows">${(p.nums || []).map((n) => `<span class="num">${n < 0 ? '−' : ''}${Math.abs(n)}</span>`).join('')}</div>`;
  }
  if (q.type === 'mul') return `<div class="jy-q-big num">${p.a} × ${p.b}</div>`;
  if (q.type === 'div') return `<div class="jy-q-big num">${p.a} ÷ ${p.b}</div>`;
  if (q.type === 'flash') {
    return `<div class="jy-flash" aria-live="off"><div class="jy-q-big num" data-flash>Ready?</div><button type="button" class="btn btn-outline btn-sm" data-act="flash-go">${state.run.flashed[q.n] ? 'Shown' : 'Show numbers'}</button></div>`;
  }
  if (q.type === 'oral') {
    return `<div class="jy-flash"><div class="jy-q-big">🔊</div><button type="button" class="btn btn-outline btn-sm" data-act="hear">Hear the question</button>
      ${globalThis.speechSynthesis ? '' : `<div class="jy-dim">Sound is not available here: ${esc(oralSpeech(p))}</div>`}</div>`;
  }
  return '';
}

const TYPE_LABEL = { add: 'Add & subtract', mul: 'Multiply', div: 'Divide', flash: 'Flash Anzan', oral: 'Oral' };

function renderRun() {
  const r = state.run;
  const host = $('#jy-run');
  if (!r || !host) return;
  const q = r.questions[r.i];
  host.innerHTML = `<div class="jy-run-backdrop" role="dialog" aria-modal="true" aria-label="${r.kind === 'boss' ? 'Boss round' : 'Oral set'}">
    <div class="card jy-run">
      <div class="jy-row-head">
        <b>${r.kind === 'boss' ? '🐉 Boss round' : '🗣️ Oral set'} · ${r.i + 1} / ${r.questions.length}</b>
        <span class="jy-chip num" id="jy-timer"></span>
      </div>
      <div class="jy-dim">${esc(TYPE_LABEL[q.type] || '')}</div>
      <div class="jy-q">${questionHtml(q)}</div>
      <form id="jy-answer-form" class="jy-answer" autocomplete="off">
        <label class="sr-only" for="jy-answer">Your answer</label>
        <input id="jy-answer" class="form-input num" inputmode="numeric" maxlength="16" value="${esc(r.answers[r.i] ?? '')}" placeholder="Answer" />
        <button type="button" class="btn btn-outline" data-act="prev" ${r.i === 0 ? 'disabled' : ''}>Back</button>
        <button type="submit" class="btn btn-primary">${r.i === r.questions.length - 1 ? 'Hand in' : 'Next'}</button>
      </form>
      <button type="button" class="btn btn-ghost btn-sm" data-act="quit">Leave (counts as handed in)</button>
    </div>
  </div>`;
  $('#jy-answer')?.focus();
  tickTimer();
}

function tickTimer() {
  const r = state.run;
  const el = $('#jy-timer');
  if (!r || !el) return;
  const left = Math.max(0, Math.round((r.endsAt - Date.now()) / 1000));
  el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (left === 0) finishRun();
}

async function startRun(kind) {
  try {
    const data = await drillApi({ action: 'journey_start', kind });
    state.run = { ...data, i: 0, answers: [], flashed: {}, endsAt: Date.now() + data.minutes * 60000 };
    state.run.timer = setInterval(tickTimer, 1000);
    renderRun();
  } catch (e) {
    showToast('error', e.message);
  }
}

async function playFlash() {
  const r = state.run;
  const q = r.questions[r.i];
  const box = $('[data-flash]');
  if (!box || r.flashed[q.n]) return;
  r.flashed[q.n] = true; // one showing only, like a real Flash Anzan round
  const ms = q.prompt.ms || 1000;
  const wait = (t) => new Promise((ok) => setTimeout(ok, t));
  for (const n of q.prompt.nums) {
    box.textContent = String(n);
    await wait(ms);
    box.textContent = '';
    await wait(150);
  }
  box.textContent = '?';
  $('[data-act="flash-go"]')?.setAttribute('disabled', '');
  $('#jy-answer')?.focus();
}

async function finishRun() {
  const r = state.run;
  if (!r || r.sending) return;
  r.sending = true;
  clearInterval(r.timer);
  const input = $('#jy-answer');
  if (input) r.answers[r.i] = input.value;
  try {
    const result = await drillApi({ action: 'journey_submit', session_id: r.session_id, answers: r.questions.map((_, i) => r.answers[i] ?? '') });
    showResult(result);
  } catch (e) {
    showToast('error', e.message);
    state.run = null;
    $('#jy-run').innerHTML = '';
  }
}

function promptText(q) {
  const p = q.prompt || {};
  if (q.type === 'add' || q.type === 'flash') return (p.nums || []).join(' ').replace(/ -/g, ' − ');
  if (q.type === 'oral') return oralSpeech(p);
  return `${p.a} ${p.op === '/' ? '÷' : '×'} ${p.b}`;
}

function showResult(res) {
  const host = $('#jy-run');
  const mascot = state.world?.mascot;
  const mood = res.passed ? 'cheer' : res.percent >= 60 ? 'happy' : 'encourage';
  const by = Object.entries(res.by_type || {}).map(([t, v]) => `<span class="jy-chip">${esc(TYPE_LABEL[t] || t)} ${v.correct}/${v.total}</span>`).join('');
  const head = res.kind === 'boss'
    ? res.passed ? 'Boss defeated! Your teacher will see you are ready.' : `Not this time: ${res.pass_percent}% passes.`
    : res.passed ? 'Oral set cleared!' : `Score ${res.pass_percent}% to count it.`;
  host.innerHTML = `<div class="jy-run-backdrop" role="dialog" aria-modal="true" aria-label="Result">
    <div class="card jy-run">
      <div class="jy-result-head">
        ${mascot ? mascotSvg({ kind: mascot.kind, level: state.world.level, mood, equipped: mascot.equipped, size: 90 }) : ''}
        <div><h2>${res.correct} / ${res.total} · ${res.percent}%</h2><p>${esc(head)}</p></div>
      </div>
      <div class="jy-outfits">${by}</div>
      <details class="jy-review"><summary>Check your answers</summary>
        <ol>${(res.review || []).map((q) => `<li class="${q.correct ? 'ok' : 'bad'}"><span class="num">${esc(promptText(q))}</span> = <b class="num">${q.answer}</b>${q.correct ? ' ✓' : ` <span class="jy-dim">(you: ${esc(q.given || '—')})</span>`}</li>`).join('')}</ol>
      </details>
      <button type="button" class="btn btn-primary" data-act="done">Back to my island</button>
    </div>
  </div>`;
  if (res.passed) celebrate(res.kind === 'boss' ? 'big' : 'small', host.querySelector('.jy-run'));
}

/* -------------------------------------------------------------- staff view */

async function renderStaff() {
  const root = $('#jy-root');
  $('#jy-subtitle').textContent = 'Boss round results, ready-for-level-up flags and themed seasons.';
  const [board, seasons] = await Promise.all([rpc('journey_staff_board', {}), rpc('season_list', {})]);
  state.seasons = seasons;
  const flags = board?.flags || [];
  const attempts = board?.attempts || [];
  const pending = flags.filter((f) => f.status === 'pending');
  const flagRows = flags.map((f) => `<tr>
      <td>${esc(f.name)} <span class="jy-dim">${esc(f.code || '')}</span></td><td>${esc(f.level)}</td><td class="num">${f.percent}%</td><td>${fmtDate(f.flagged_at)}</td>
      <td>${f.status === 'pending'
        ? `<button type="button" class="btn btn-primary btn-xs" data-review="agreed" data-student="${esc(f.student_id)}" data-level="${esc(f.level)}">Ready</button>
           <button type="button" class="btn btn-outline btn-xs" data-review="not_yet" data-student="${esc(f.student_id)}" data-level="${esc(f.level)}">Not yet</button>`
        : `<span class="jy-chip">${f.status === 'agreed' ? 'Ready' : 'Not yet'}</span>`}</td></tr>`).join('');
  const attemptRows = attempts.slice(0, 40).map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.level)}</td><td class="num">${a.correct}/${a.total} · ${a.percent}%</td>
      <td>${Object.entries(a.by_type || {}).map(([t, v]) => `<span class="jy-dim">${esc(TYPE_LABEL[t] || t)} ${v.correct}/${v.total}</span>`).join(' · ')}</td><td>${a.passed ? '✅' : '—'}</td><td>${fmtDate(a.submitted_at)}</td></tr>`).join('');

  root.innerHTML = `
    ${seasonBanner()}
    <section class="card">
      <div class="jy-row-head"><h2>Ready for level-up</h2><span class="jy-chip">${pending.length} waiting</span></div>
      <p class="jy-dim">A passed boss round only raises a flag. To change a student's official level, use the Students page.</p>
      ${flagRows ? `<div class="jy-scroll"><table class="jy-table"><thead><tr><th>Student</th><th>Island</th><th class="num">Score</th><th>Passed</th><th></th></tr></thead><tbody>${flagRows}</tbody></table></div>` : '<p class="jy-dim">No flags yet.</p>'}
    </section>
    <section class="card">
      <h2>Boss round results (last 60 days)</h2>
      ${attemptRows ? `<div class="jy-scroll"><table class="jy-table"><thead><tr><th>Student</th><th>Island</th><th class="num">Score</th><th>By question type</th><th>Pass</th><th>Date</th></tr></thead><tbody>${attemptRows}</tbody></table></div>` : '<p class="jy-dim">No boss rounds yet.</p>'}
    </section>
    ${seasons?.can_manage ? seasonAdminHtml(seasons) : ''}`;
}

function seasonAdminHtml(s) {
  const list = (s.seasons || []).map((x) => `<tr><td>${esc(SEASON_THEMES[x.theme]?.icon || '')} ${esc(x.name)}</td><td>${fmtDate(x.starts_on)} – ${fmtDate(x.ends_on)}</td><td class="num">${formatXp(x.badge_xp)}</td>
      <td>${x.status === 'cancelled' ? '<span class="jy-chip">Cancelled</span>' : x.settled ? '<span class="jy-chip">Finished</span>' : x.starts_on > s.today ? `<button type="button" class="btn btn-outline btn-xs" data-cancel="${x.id}">Cancel</button>` : '<span class="jy-chip">Running</span>'}</td></tr>`).join('');
  const themes = Object.entries(SEASON_THEMES).map(([k, t]) => `<option value="${k}">${t.icon} ${esc(t.label)}</option>`).join('');
  return `<section class="card" id="jy-season-admin">
    <h2>Themed seasons</h2>
    <p class="jy-dim">A season runs 8 weeks. It replaces the monthly season for those weeks: season XP, tiers and the season board all follow it. Days with no themed season use the calendar month.</p>
    <form id="jy-season-form" class="jy-form">
      <label>Name<input class="form-input" name="name" maxlength="60" required placeholder="Space Season" /></label>
      <label>Theme<select class="form-input" name="theme">${themes}</select></label>
      <label>Starts on<input class="form-input" type="date" name="starts_on" required /></label>
      <label>Badge XP<input class="form-input num" type="number" name="badge_xp" min="0" max="100000" step="50" value="500" /></label>
      <label class="jy-wide">Description (optional)<input class="form-input" name="description" maxlength="200" /></label>
      <div class="jy-wide jy-dim" id="jy-season-hint"></div>
      <button type="submit" class="btn btn-primary">Schedule season</button>
    </form>
    ${list ? `<div class="jy-scroll"><table class="jy-table"><thead><tr><th>Season</th><th>Dates</th><th class="num">Badge XP</th><th></th></tr></thead><tbody>${list}</tbody></table></div>` : ''}
  </section>`;
}

/* ----------------------------------------------------------------- events */

async function loadStudent() {
  const [world, seasons, board, xp] = await Promise.all([
    rpc('my_world', {}),
    rpc('season_list', {}).catch(() => null),
    rpc('season_board', {}).catch(() => null),
    state.demo ? Promise.resolve({ season_xp: 1280, tier: { name: 'Gold' } }) : fetchXpSummary().catch(() => null),
  ]);
  state.world = world;
  state.seasons = seasons;
  state.board = board;
  state.xp = xp;
  if (world?.mascot) writeMascotCache({ ...world.mascot, level: world.level });
  renderStudent();
}

function wireEvents() {
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act],[data-kind],[data-item],[data-review],[data-cancel]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'pick') { state.showPicker = true; renderStudent(); return; }
    if (act === 'close-pick') { state.showPicker = false; renderStudent(); return; }
    if (act === 'boss' || act === 'oral') { startRun(act); return; }
    if (act === 'flash-go') { playFlash(); return; }
    if (act === 'hear') { const q = state.run.questions[state.run.i]; if (!speak(oralSpeech(q.prompt))) showToast('info', oralSpeech(q.prompt)); return; }
    if (act === 'prev') { const r = state.run; r.answers[r.i] = $('#jy-answer').value; r.i -= 1; renderRun(); return; }
    if (act === 'quit') { finishRun(); return; }
    if (act === 'done') { state.run = null; $('#jy-run').innerHTML = ''; await loadStudent(); return; }
    if (t.dataset.kind || t.dataset.item !== undefined) {
      const cur = state.world?.mascot || {};
      const kind = t.dataset.kind || cur.kind || 'owl';
      const item = t.dataset.item !== undefined ? t.dataset.item || null : t.dataset.kind && t.dataset.kind !== cur.kind ? null : cur.equipped || null;
      try {
        const saved = await rpc('set_my_mascot', { p_kind: kind, p_equipped: item });
        state.world.mascot = saved;
        writeMascotCache({ ...saved, level: state.world.level });
        renderStudent();
        showToast('success', `${MASCOTS[kind].name} is your mascot.`);
      } catch (e) {
        showToast('error', e.message);
      }
      return;
    }
    if (t.dataset.review) {
      const note = t.dataset.review === 'not_yet' ? globalThis.prompt('A short note for the student (optional):') || null : null;
      try {
        await rpc('journey_levelup_review', { p_student: t.dataset.student, p_level: t.dataset.level, p_status: t.dataset.review, p_note: note });
        showToast('success', 'Saved.');
        renderStaff();
      } catch (e) {
        showToast('error', e.message);
      }
      return;
    }
    if (t.dataset.cancel) {
      if (!globalThis.confirm('Cancel this season? It has not started, so nothing is lost.')) return;
      try {
        await rpc('season_cancel', { p_id: Number(t.dataset.cancel) });
        renderStaff();
      } catch (e) {
        showToast('error', e.message);
      }
    }
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id === 'jy-answer-form') {
      ev.preventDefault();
      const r = state.run;
      r.answers[r.i] = $('#jy-answer').value;
      if (r.i < r.questions.length - 1) { r.i += 1; renderRun(); } else finishRun();
      return;
    }
    if (ev.target.id === 'jy-season-form') {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const draft = { name: String(fd.get('name') || ''), theme: String(fd.get('theme') || ''), starts_on: String(fd.get('starts_on') || '') };
      const check = validateSeasonDraft(draft, { today: state.seasons?.today, seasons: (state.seasons?.seasons || []).filter((x) => x.status === 'scheduled') });
      if (check) { $('#jy-season-hint').textContent = check; return; }
      try {
        await rpc('season_save', { p_name: draft.name, p_theme: draft.theme, p_starts_on: draft.starts_on, p_description: String(fd.get('description') || '') || null, p_badge_xp: Number(fd.get('badge_xp')) || 500 });
        showToast('success', `${draft.name} is scheduled until ${fmtDate(seasonEnd(draft.starts_on))}.`);
        renderStaff();
      } catch (e) {
        showToast('error', e.message);
      }
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.name === 'starts_on' && ev.target.value) {
      const hint = $('#jy-season-hint');
      if (hint) hint.textContent = `Runs ${fmtDate(ev.target.value)} – ${fmtDate(seasonEnd(ev.target.value))} (8 weeks).`;
    }
  });
}

async function init() {
  const profile = await requireAuth(['student', 'teacher', 'admin']);
  if (!profile) return;
  state.profile = profile;
  state.demo = !isSupabaseConfigured();
  ensureMascotStyles();
  wireEvents();
  try {
    if (profile.role === 'student') {
      await loadStudent();
      if (location.hash === '#oral' && state.world?.stages?.length) startRun('oral');
    } else {
      await renderStaff();
    }
  } catch (e) {
    $('#jy-root').innerHTML = `<section class="card"><p>Could not load the journey: ${esc(e.message)}</p></section>`;
  }
}

init();
