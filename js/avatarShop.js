/**
 * Trendz Tracker - Store "Avatar shop" tab (js/avatarShop.js)
 *
 * Students build an avatar from layered SVG parts and buy extra parts with coins.
 * Skin tones, starter styles, hijab, turban and patka are always free. Coins come only
 * from practice; every purchase is checked and saved by the database (avatar_buy).
 * The XP prize shop on the same page (js/arena.js) is unchanged.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { buyAvatarItem, loadAvatarState, saveAvatarLook } from './avatarStore.js';
import { BANNERS, DEFAULT_LOOK, NAME_COLORS, SKIN_TONES, avatarSvg, itemPreviewSvg, normalizeLook } from '../shared/avatarArt.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

const SLOTS = [
  { key: 'skin', label: 'Skin' },
  { key: 'hair', label: 'Hair' },
  { key: 'hair_color', label: 'Hair colour' },
  { key: 'headwear', label: 'Head' },
  { key: 'headwear_color', label: 'Head colour' },
  { key: 'outfit', label: 'Outfit' },
  { key: 'outfit_color', label: 'Outfit colour' },
  { key: 'accessory', label: 'Extras' },
  { key: 'background', label: 'Background' },
  { key: 'frame', label: 'Frame' },
  { key: 'name_color', label: 'Name colour' },
  { key: 'banner', label: 'Banner' },
];

const s = { student: false, data: null, draft: null, slot: 'skin', busy: false, pending: null, loaded: false };

function showPane(name) {
  const tab = name === 'avatar' ? 'avatar' : 'prizes';
  for (const t of ['prizes', 'avatar']) {
    const btn = $(`store-tab-${t}`);
    btn?.setAttribute('aria-selected', String(t === tab));
    btn?.classList.toggle('is-active', t === tab);
    const pane = $(`store-pane-${t}`);
    if (pane) pane.hidden = t !== tab;
  }
  const want = tab === 'avatar' ? '#avatar' : '#prizes';
  if (window.location.hash !== want) history.replaceState(null, '', want);
  if (tab === 'avatar' && !s.loaded) {
    s.loaded = true;
    load();
  }
}

async function load() {
  const box = $('av-shop');
  try {
    s.data = await loadAvatarState(null);
    const saved = s.data.style?.look;
    s.draft = normalizeLook(saved || DEFAULT_LOOK);
    render();
  } catch (err) {
    if (box) box.innerHTML = `<p class="ar-dim">${esc(err?.message || 'The avatar shop could not load right now.')}</p>`;
  }
}

const itemsFor = (slot) => (s.data?.items || []).filter((i) => i.slot === slot);
const valueOf = (key) => key.split('.')[1];
const owned = (key) => !!(s.data?.items || []).find((i) => i.key === key && i.owned);

function isOn(item) {
  const v = valueOf(item.key);
  const st = s.data?.style || {};
  if (item.slot === 'accessory') return s.draft.accessories.includes(v);
  if (item.slot === 'name_color') return (st.name_color || 'default') === v;
  if (item.slot === 'banner') return (st.banner || 'plain') === v;
  return s.draft[item.slot] === v;
}

function thumb(item) {
  const v = valueOf(item.key);
  if (item.slot === 'name_color') {
    const c = NAME_COLORS[v];
    const style = v === 'rainbow' ? `background-image:${c};-webkit-background-clip:text;background-clip:text;color:transparent` : c === 'inherit' ? '' : `color:${c}`;
    return `<span class="avs-name" style="${style}">Aa</span>`;
  }
  if (item.slot === 'banner') return `<span class="avs-banner" style="background:${BANNERS[v]}"></span>`;
  const look = { ...s.draft };
  if (item.slot === 'accessory') {
    const acc = look.accessories.includes(v) ? look.accessories : [...look.accessories.slice(-1), v];
    return avatarSvg({ ...look, accessories: acc }, { label: item.name });
  }
  return itemPreviewSvg(item.key, look);
}

function gridHtml() {
  if (s.slot === 'skin') {
    return SKIN_TONES.map((hex, i) => `<button type="button" class="avs-item ${s.draft.skin === i ? 'is-on' : ''}" data-skin="${i}" aria-pressed="${s.draft.skin === i}">
      <span class="avs-th">${avatarSvg({ ...s.draft, skin: i }, { label: `Skin tone ${i + 1}` })}</span><span class="avs-nm">Tone ${i + 1}</span><span class="avs-price free">Free</span></button>`).join('');
  }
  const list = itemsFor(s.slot);
  const noneAcc = s.slot === 'accessory' ? `<button type="button" class="avs-item ${s.draft.accessories.length ? '' : 'is-on'}" data-acc-none="1"><span class="avs-th">${avatarSvg({ ...s.draft, accessories: [] }, { label: 'No extras' })}</span><span class="avs-nm">None</span><span class="avs-price free">Free</span></button>` : '';
  return noneAcc + list.map((it) => {
    const have = it.owned;
    const price = it.cost === 0 ? '<span class="avs-price free">Free</span>' : have ? '<span class="avs-price own">✓ Owned</span>' : `<span class="avs-price">🪙 ${fmt(it.cost)}</span>`;
    return `<button type="button" class="avs-item ${isOn(it) ? 'is-on' : ''} ${have ? '' : 'is-locked'}" data-item="${esc(it.key)}" aria-pressed="${isOn(it)}">
      <span class="avs-th">${thumb(it)}</span><span class="avs-nm">${esc(it.name)}</span>${price}</button>`;
  }).join('');
}

function render() {
  const box = $('av-shop');
  if (!box || !s.data) return;
  const st = s.data.style || {};
  const dirty = !st.token || JSON.stringify(normalizeLook(st.look)) !== JSON.stringify(s.draft);
  const slotLabel = SLOTS.find((x) => x.key === s.slot)?.label || '';
  box.innerHTML = `
    <div class="avs-top">
      <div><b class="avs-coins">🪙 <span class="num">${fmt(s.data.coins?.balance)}</span> coins</b>
      <p class="ar-dim">You earn 1 coin for every 10 XP from practice${s.data.coins?.since ? ` (from ${esc(new Date(s.data.coins.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))})` : ''}, plus coins from chests on <a href="/pages/profile.html">your profile</a>. Coins can never be bought.</p></div>
    </div>
    <div class="avs-layout">
      <aside class="avs-preview">
        <div class="avs-big">${avatarSvg(s.draft, { label: 'Your avatar preview' })}</div>
        ${s.student ? `<button type="button" class="btn btn-primary btn-sm" id="avs-save" ${dirty ? '' : 'disabled'}>${st.token ? (dirty ? 'Save my avatar' : 'Saved') : 'Save and show my avatar'}</button>
        <p class="ar-dim avs-small">${st.mode === 'avatar' ? 'Your avatar shows on leaderboards and duels.' : 'Saving shows your avatar instead of your photo. Switch back any time on your profile.'}</p>` : '<p class="ar-dim avs-small">Students build their avatars here.</p>'}
      </aside>
      <div class="avs-main">
        <div class="avs-slots" role="tablist" aria-label="Avatar parts">${SLOTS.map((x) => `<button type="button" role="tab" class="ar-tab ${x.key === s.slot ? 'is-active' : ''}" aria-selected="${x.key === s.slot}" data-slot="${x.key}">${x.label}</button>`).join('')}</div>
        ${s.slot === 'accessory' ? '<p class="ar-dim avs-small">Pick up to 2 extras.</p>' : ''}
        ${s.slot === 'name_color' || s.slot === 'banner' ? `<p class="ar-dim avs-small">${slotLabel}s you own can be picked on <a href="/pages/profile.html">your profile</a>.</p>` : ''}
        <div class="avs-grid" id="avs-grid">${gridHtml()}</div>
        <div class="avs-buy" id="avs-buy" ${s.pending ? '' : 'hidden'}>${buyHtml()}</div>
      </div>
    </div>`;
}

function buyHtml() {
  const it = s.pending;
  if (!it) return '';
  const short = (s.data.coins?.balance || 0) < it.cost;
  return `<p><b>${esc(it.name)}</b> costs 🪙 ${fmt(it.cost)} coins. ${short ? `You need ${fmt(it.cost - (s.data.coins?.balance || 0))} more. Keep practising!` : ''}</p>
    <div class="avs-buy-actions"><button type="button" class="btn btn-primary btn-sm" data-buy="${esc(it.key)}" ${short || !s.student ? 'disabled' : ''}>Buy for ${fmt(it.cost)} coins</button>
    <button type="button" class="btn btn-outline btn-sm" data-buy-cancel="1">Not now</button></div>`;
}

function applyItem(it) {
  const v = valueOf(it.key);
  if (it.slot === 'accessory') {
    const acc = s.draft.accessories;
    s.draft.accessories = acc.includes(v) ? acc.filter((a) => a !== v) : [...acc, v].slice(-2);
  } else if (it.slot === 'name_color' || it.slot === 'banner') {
    return;
  } else {
    s.draft[it.slot] = v;
    if (it.slot === 'headwear_color' && s.draft.headwear === 'none') s.draft.headwear = 'turban';
  }
}

async function onClick(e) {
  const box = $('av-shop');
  if (!box || s.busy) return;
  const slotBtn = e.target.closest('[data-slot]');
  if (slotBtn) { s.slot = slotBtn.dataset.slot; s.pending = null; render(); return; }
  const skin = e.target.closest('[data-skin]');
  if (skin) { s.draft.skin = Number(skin.dataset.skin); render(); return; }
  if (e.target.closest('[data-acc-none]')) { s.draft.accessories = []; render(); return; }
  if (e.target.closest('[data-buy-cancel]')) { s.pending = null; render(); return; }
  const buy = e.target.closest('[data-buy]');
  if (buy) {
    s.busy = true;
    buy.disabled = true;
    try {
      const it = s.pending;
      const r = await buyAvatarItem(buy.dataset.buy);
      showToast('success', r.already ? 'You already own this.' : `Bought ${it?.name || 'item'}!`);
      s.pending = null;
      const draft = s.draft;
      s.data = await loadAvatarState(null);
      s.draft = draft;
      if (it) applyItem(it);
      render();
    } catch (err) {
      showToast('error', err?.message || 'That could not be bought.');
      buy.disabled = false;
    } finally {
      s.busy = false;
    }
    return;
  }
  const itemBtn = e.target.closest('[data-item]');
  if (itemBtn) {
    const it = (s.data.items || []).find((i) => i.key === itemBtn.dataset.item);
    if (!it) return;
    if (!it.owned) { s.pending = it; render(); $('avs-buy')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    s.pending = null;
    applyItem(it);
    render();
    return;
  }
  if (e.target.closest('#avs-save')) {
    s.busy = true;
    try {
      await saveAvatarLook(s.draft, s.data.style?.token ? null : 'avatar');
      showToast('success', 'Avatar saved');
      s.data = await loadAvatarState(null);
      s.draft = normalizeLook(s.data.style?.look || s.draft);
      render();
    } catch (err) {
      showToast('error', err?.message || 'Your avatar could not be saved.');
    } finally {
      s.busy = false;
    }
  }
}

function ensureShopStyles() {
  if ($('avs-style')) return;
  const st = document.createElement('style');
  st.id = 'avs-style';
  st.textContent = `
  .avs-top { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .avs-top p { margin: 4px 0 0; }
  .avs-coins { font-size: 20px; }
  .avs-layout { display: grid; grid-template-columns: 220px 1fr; gap: 20px; align-items: start; }
  .avs-preview { position: sticky; top: 12px; display: grid; gap: 10px; justify-items: center; text-align: center; }
  .avs-big { width: 200px; height: 200px; }
  .avs-big svg { width: 100%; height: 100%; display: block; }
  .avs-small { font-size: 13px; margin: 0; }
  .avs-slots { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .avs-slots .ar-tab { padding: 6px 12px; font-size: 13px; }
  .avs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; margin-top: 8px; }
  .avs-item { border: 2px solid var(--border-hairline, #E5E7EB); background: #fff; border-radius: 14px; padding: 8px 6px; display: grid; gap: 4px; justify-items: center; cursor: pointer; font: inherit; color: inherit; }
  .avs-item:hover { border-color: #93C5FD; }
  .avs-item.is-on { border-color: var(--primary, #2563EB); box-shadow: 0 0 0 3px #DBEAFE; }
  .avs-item.is-locked .avs-th { opacity: .75; }
  .avs-th { width: 72px; height: 72px; display: grid; place-items: center; }
  .avs-th svg { width: 100%; height: 100%; }
  .avs-nm { font-weight: 600; font-size: 13px; text-align: center; line-height: 1.2; }
  .avs-price { font-size: 12px; font-weight: 700; color: #92400E; }
  .avs-price.free { color: #15803D; }
  .avs-price.own { color: #2563EB; }
  .avs-name { font-size: 34px; font-weight: 900; }
  .avs-banner { width: 72px; height: 44px; border-radius: 8px; display: block; border: 1px solid #E5E7EB; }
  .avs-buy { margin-top: 12px; border: 2px solid #FCD34D; background: #FFFBEB; border-radius: 12px; padding: 10px 12px; }
  .avs-buy p { margin: 0 0 8px; }
  .avs-buy-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .store-tabs { margin: 0 0 12px; }
  @media (max-width: 720px) {
    .avs-layout { grid-template-columns: 1fr; }
    .avs-preview { position: static; grid-template-columns: 110px 1fr; justify-items: start; text-align: left; align-items: center; }
    .avs-big { width: 110px; height: 110px; grid-row: span 2; }
    .avs-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .avs-th { width: 60px; height: 60px; }
  }`;
  document.head.appendChild(st);
}

async function initAvatarShop() {
  if (!$('store-pane-avatar')) return;
  ensureShopStyles();
  $('store-tab-prizes')?.addEventListener('click', () => showPane('prizes'));
  $('store-tab-avatar')?.addEventListener('click', () => showPane('avatar'));
  $('av-shop')?.addEventListener('click', onClick);
  window.addEventListener('hashchange', () => showPane(window.location.hash.slice(1)));
  const viewer = await requireAuth(['student', 'teacher', 'admin']);
  if (!viewer) return;
  s.student = viewer.role === 'student';
  showPane(window.location.hash.slice(1));
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAvatarShop);
}
