/**
 * Trendz Tracker - Arena page (js/arena.js)
 *
 * Tabs: League (weekly groups of up to 20; the top of each group moves up), Duels
 * (same seeded 1-minute round for two classmates), Class vs class (average XP per
 * student) and Rewards (spend XP on small prizes collected at the centre).
 * Students play; teachers and admins can look at every league; admins run the shop.
 * Every number comes from the database; duels go through POST /api/drill.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { ensureXpStyles, escapeXpHtml as esc } from './xpRewards.js';
import { ensureAvatarStyles, signAvatarUrls } from './avatars.js';
import { celebrate, celebrateOnce } from './motion.js';
import {
  buildClassVsClassHtml,
  buildDuelFormHtml,
  buildDuelListHtml,
  buildLeagueHtml,
  buildRewardAdminHtml,
  buildRewardShopHtml,
  parseRewardItemForm,
} from './arenaView.js';

const $ = (id) => document.getElementById(id);
const TABS = ['league', 'duels', 'classes', 'rewards'];
const state = { viewer: null, isStudent: false, isAdmin: false, loaded: new Set(), period: 'week', staffTier: 1, adminData: null };

/** Calls an RPC and returns { data, error } with a readable error message. */
async function rpc(name, args = {}) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return { data: null, error: 'The database is not connected.' };
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { data: null, error: error.message || 'Something went wrong.' };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err?.message || 'Something went wrong.' };
  }
}

async function drillApi(body) {
  if (!isSupabaseConfigured()) throw new Error('Duels need the online database.');
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const resp = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

/* --------------------------------------------------------------- Tabs */

function showTab(tab, { push = true } = {}) {
  const name = TABS.includes(tab) ? tab : 'league';
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    const panel = $(`panel-${t}`);
    const on = t === name;
    btn?.setAttribute('aria-selected', String(on));
    btn?.classList.toggle('is-active', on);
    if (panel) panel.hidden = !on;
  }
  if (push && window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (!state.loaded.has(name)) {
    state.loaded.add(name);
    loadTab(name);
  }
}

function loadTab(name) {
  const loaders = { league: loadLeague, duels: loadDuels, classes: loadClasses, rewards: loadRewards };
  loaders[name]?.().catch((err) => console.warn(`Could not load ${name}:`, err));
}

/* ------------------------------------------------------------- League */

async function loadLeague() {
  const args = state.isStudent ? {} : { p_tier: state.staffTier };
  const { data, error } = await rpc('league_board', args);
  if (error) {
    $('ar-league').innerHTML = '<p class="ar-dim">Could not load the league right now.</p>';
    return;
  }
  const urls = await signAvatarUrls((data?.rows || []).map((r) => r.avatar_path));
  $('ar-league').innerHTML = buildLeagueHtml(data, urls);
  const last = data?.last;
  if (state.isStudent && last && Number(last.tier_after) > Number(last.tier_before)) {
    celebrateOnce(`league_${data?.week?.from || ''}`, 'big', $('ar-league').querySelector('.ar-last'));
  }
  if (!state.isStudent && Array.isArray(data?.tiers)) {
    const wrap = $('ar-staff-tiers');
    wrap.hidden = false;
    wrap.innerHTML = data.tiers
      .map((t) => `<button type="button" class="btn btn-sm ${Number(t.tier) === state.staffTier ? 'btn-primary' : 'btn-outline'}" data-tier="${t.tier}">${t.icon} ${t.name} (${t.students})</button>`)
      .join('');
  }
}

/* -------------------------------------------------------------- Duels */

async function loadDuels() {
  if (!state.isStudent) {
    $('ar-duels-student').hidden = true;
    $('ar-duels-staff').hidden = false;
    return;
  }
  const [duels, options] = await Promise.all([rpc('my_duels'), rpc('duel_options')]);
  const list = Array.isArray(duels.data) ? duels.data : [];
  const urls = await signAvatarUrls(list.map((d) => d.other_avatar));
  $('ar-duel-list').innerHTML = duels.error ? '<p class="ar-dim">Could not load your duels.</p>' : buildDuelListHtml(list, urls);
  $('ar-duel-form-wrap').innerHTML = options.error ? '' : buildDuelFormHtml(options.data);
}

function setupDuelActions() {
  $('panel-duels').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-duel-cancel]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await drillApi({ action: 'duel_cancel', duel_id: btn.dataset.duelCancel });
      showToast('success', 'Duel closed.');
      await loadDuels();
    } catch (err) {
      showToast('error', err.message);
      btn.disabled = false;
    }
  });
  $('panel-duels').addEventListener('submit', async (e) => {
    if (e.target.id !== 'ar-duel-form') return;
    e.preventDefault();
    const form = e.target;
    const submit = form.querySelector('button[type="submit"]');
    const opponent = form.elements.opponent?.value;
    const category = form.elements.category?.value;
    if (!opponent || !category) return;
    submit.disabled = true;
    try {
      const res = await drillApi({ action: 'duel_create', opponent_id: opponent, category_id: category });
      showToast('success', 'Duel sent! Play your round whenever you are ready.');
      celebrate('small', submit);
      if (res?.duel_id) {
        await loadDuels();
      }
    } catch (err) {
      showToast('error', err.message);
      submit.disabled = false;
    }
  });
}

/* ----------------------------------------------------- Class vs class */

async function loadClasses() {
  const { data, error } = await rpc('class_vs_class', { p_period: state.period });
  $('ar-classes').innerHTML = error ? '<p class="ar-dim">Could not load classes right now.</p>' : buildClassVsClassHtml(data);
}

function setupPeriodButtons() {
  document.querySelector('.ar-period')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn || btn.dataset.period === state.period) return;
    state.period = btn.dataset.period;
    for (const b of document.querySelectorAll('.ar-period [data-period]')) {
      b.classList.toggle('btn-primary', b === btn);
      b.classList.toggle('btn-outline', b !== btn);
    }
    loadClasses();
  });
}

/* ------------------------------------------------------------ Rewards */

async function loadRewards() {
  if (state.isAdmin) {
    const { data, error } = await rpc('reward_admin');
    state.adminData = data;
    $('ar-rewards').innerHTML = error ? `<p class="ar-dim">${esc(error)}</p>` : buildRewardAdminHtml(data);
    $('ar-item-form').hidden = false;
    return;
  }
  if (!state.isStudent) {
    $('ar-rewards').innerHTML = '<p class="ar-dim">Students spend their XP here on rewards an admin adds to the shop.</p>';
    return;
  }
  const { data, error } = await rpc('reward_shop');
  $('ar-rewards').innerHTML = error ? '<p class="ar-dim">Could not load the reward shop.</p>' : buildRewardShopHtml(data);
}

function fillItemForm(item) {
  const form = $('ar-item-form');
  form.elements.id.value = item?.id ?? '';
  form.elements.icon.value = item?.icon ?? '';
  form.elements.name.value = item?.name ?? '';
  form.elements.cost.value = item?.cost ?? '';
  form.elements.stock.value = item?.stock ?? '';
  form.elements.description.value = item?.description ?? '';
  form.elements.active.checked = item ? Boolean(item.active) : true;
  $('ar-item-form-title').textContent = item ? 'Edit reward' : 'Add a reward';
}

function setupRewardActions() {
  $('panel-rewards').addEventListener('click', async (e) => {
    const get = e.target.closest('[data-reward]');
    const cancel = e.target.closest('[data-reward-cancel]');
    const decide = e.target.closest('[data-decide]');
    const editItem = e.target.closest('[data-edit-item]');
    if (get) {
      const name = get.dataset.rewardName;
      if (!window.confirm(`Spend ${get.dataset.rewardCost} XP on "${name}"? Your trainer will hand it to you at the centre.`)) return;
      get.disabled = true;
      const { error } = await rpc('reward_request', { p_item: Number(get.dataset.reward) });
      if (error) {
        showToast('error', error);
        get.disabled = false;
        return;
      }
      showToast('success', `Requested "${name}". Collect it from your trainer.`);
      celebrate('small', get);
      await loadRewards();
    } else if (cancel) {
      cancel.disabled = true;
      const { error } = await rpc('reward_cancel', { p_id: Number(cancel.dataset.rewardCancel) });
      if (error) {
        showToast('error', error);
        cancel.disabled = false;
        return;
      }
      showToast('success', 'Request cancelled. Your XP is back.');
      await loadRewards();
    } else if (decide) {
      const status = decide.dataset.decide;
      let note = null;
      if (status === 'rejected') {
        note = window.prompt('Reason (optional, the student will see it):', '');
        if (note === null) return;
      }
      decide.disabled = true;
      const { error } = await rpc('reward_decide', { p_id: Number(decide.dataset.id), p_status: status, p_note: note });
      if (error) {
        showToast('error', error);
        decide.disabled = false;
        return;
      }
      showToast('success', status === 'given' ? 'Marked as given.' : 'Request rejected; the XP went back.');
      await loadRewards();
    } else if (editItem) {
      const item = (state.adminData?.items || []).find((i) => String(i.id) === editItem.dataset.editItem);
      fillItemForm(item || null);
      $('ar-item-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  $('ar-item-reset').addEventListener('click', () => fillItemForm(null));
  $('ar-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const parsed = parseRewardItemForm({
      name: form.elements.name.value,
      icon: form.elements.icon.value,
      description: form.elements.description.value,
      cost: form.elements.cost.value,
      stock: form.elements.stock.value,
      active: form.elements.active.checked,
    });
    if (!parsed.ok) {
      showToast('error', parsed.error);
      return;
    }
    const v = parsed.value;
    const id = form.elements.id.value ? Number(form.elements.id.value) : null;
    const { error } = await rpc('reward_item_save', {
      p_id: id, p_name: v.name, p_icon: v.icon, p_description: v.description,
      p_cost: v.cost, p_stock: v.stock, p_active: v.active,
    });
    if (error) {
      showToast('error', error);
      return;
    }
    showToast('success', 'Reward saved.');
    fillItemForm(null);
    await loadRewards();
  });
}

/* --------------------------------------------------------------- Init */

async function initArenaPage() {
  const viewer = await requireAuth(['student', 'teacher', 'admin']);
  if (!viewer) return;
  state.viewer = viewer;
  state.isStudent = viewer.role === 'student';
  state.isAdmin = viewer.role === 'admin';
  ensureXpStyles(document);
  ensureAvatarStyles(document);

  for (const t of TABS) $(`tab-${t}`)?.addEventListener('click', () => showTab(t));
  $('ar-staff-tiers').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tier]');
    if (!btn) return;
    state.staffTier = Number(btn.dataset.tier) || 1;
    loadLeague();
  });
  setupDuelActions();
  setupPeriodButtons();
  setupRewardActions();
  window.addEventListener('hashchange', () => showTab(window.location.hash.slice(1), { push: false }));
  showTab(window.location.hash.slice(1), { push: false });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initArenaPage);
}
